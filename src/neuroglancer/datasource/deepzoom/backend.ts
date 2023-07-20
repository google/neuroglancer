/**
 * @license
 * Copyright 2016 Google Inc., 2023 Gergely Csucs
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {ImageTileEncoding, ImageTileSourceParameters} from 'neuroglancer/datasource/deepzoom/base';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {isNotFoundError, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {cancellableFetchSpecialOk, SpecialProtocolCredentials} from 'neuroglancer/util/special_protocol_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';
import {decodeJpeg} from 'src/neuroglancer/async_computation/decode_jpeg_request';
import {decodePng} from 'src/neuroglancer/async_computation/decode_png_request';
import {requestAsyncComputation} from 'src/neuroglancer/async_computation/request';
import {transposeArray2d} from 'src/neuroglancer/util/array';

/* This is enough if support for these aren't needed:
 * - Firefox before 105 (OffscreenCanvas, 2022-09-20)
 * - Safari before 16.4 (OffscreenCanvas, 2023-03-27)
 */
// declare var OffscreenCanvas: any; // shutting up some outdated compiler(?)

@registerSharedObject() export class DeepzoomImageTileSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(VolumeChunkSource), ImageTileSourceParameters)) {
  gridShape = (() => {
    const gridShape = new Uint32Array(2);
    const {upperVoxelBound, chunkDataSize} = this.spec;
    for (let i = 0; i < 2; ++i) {
      gridShape[i] = Math.ceil(upperVoxelBound[i] / chunkDataSize[i]);
    }
    return gridShape;
  })();

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken): Promise<void> {
    const {parameters} = this;

    // /* This block is enough if support for these aren't needed:
    //  * - Firefox before 105 (OffscreenCanvas, 2022-09-20)
    //  * - Safari before 16.4 (OffscreenCanvas, 2023-03-27)
    //  */
    // const {tilesize, overlap} = parameters;
    // const [x, y] = chunk.chunkGridPosition;
    // const url = `${parameters.url}/${x}_${y}.${ImageTileEncoding[parameters.encoding].toLowerCase()}`;
    // const response: Blob = await cancellableFetchSpecialOk(this.credentialsProvider, url, {}, response => response.blob(), cancellationToken);
    // const tile = await createImageBitmap(response);
    // const canvas = new OffscreenCanvas(tilesize, tilesize);
    // const ctx = canvas.getContext("2d")!;
    // ctx.drawImage(tile, x === 0 ? 0 : -overlap, y === 0 ? 0 : -overlap);
    // const id = ctx.getImageData(0, 0, tilesize, tilesize).data;
    // const t2 = tilesize * tilesize;
    // const d = chunk.data = new Uint8Array(t2 * 3);
    // for (let i = 0; i < t2; i++) {
    //   d[i] = id[i * 4];
    //   d[i + t2] = id[i * 4 + 1];
    //   d[i + 2 * t2] = id[i * 4 + 2];
    // }
    // Todo: ^ "transposeArray2d" likely does the same

    const {tilesize, overlap, encoding} = parameters;
    const [x, y] = chunk.chunkGridPosition;
    const ox = x === 0 ? 0 : overlap;
    const oy = y === 0 ? 0 : overlap;
    const url = `${parameters.url}/${x}_${y}.${parameters.format}`;
    try {
      const responseBuffer = await cancellableFetchSpecialOk(
          this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);

      let tilewidth = 0, tileheight = 0;
      let tiledata: Uint8Array|undefined;
      switch(encoding){
        case ImageTileEncoding.PNG:
          const pngbitmap = await requestAsyncComputation(
              decodePng, cancellationToken, [responseBuffer],
              new Uint8Array(responseBuffer), undefined, undefined, 3, 1, false
          );
          ({width: tilewidth, height: tileheight} = pngbitmap);
          tiledata = transposeArray2d(pngbitmap.uint8Array, tilewidth * tileheight, 3);
          break;

        case ImageTileEncoding.JPG:
        case ImageTileEncoding.JPEG:
            const jpegbitmap = await requestAsyncComputation(
                decodeJpeg, cancellationToken, [responseBuffer],
                new Uint8Array(responseBuffer), undefined, undefined, 3, false);
            ({uint8Array: tiledata, width: tilewidth, height: tileheight} = jpegbitmap);
          break;
      }
      if(tiledata !== undefined) {
        const t2 = tilesize * tilesize;
        const twh = tilewidth * tileheight;
        const d = chunk.data = new Uint8Array(t2 * 3);
        for(let k = 0; k < 3; k++)
          for(let j = 0; j < tileheight; j++)
            for(let i = 0; i < tilewidth; i++)
              d[i + j * tilesize + k * t2] = tiledata[i + ox + (j + oy) * tilewidth + k * twh];
      }
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
  }
}
