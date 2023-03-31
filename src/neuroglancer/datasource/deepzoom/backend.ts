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
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodePngChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/png';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
// import {isNotFoundError, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {cancellableFetchSpecialOk, SpecialProtocolCredentials} from 'neuroglancer/util/special_protocol_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

const chunkDecoders = new Map<ImageTileEncoding, ChunkDecoder>();
chunkDecoders.set(ImageTileEncoding.JPG, decodeJpegChunk);
chunkDecoders.set(ImageTileEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(ImageTileEncoding.PNG, decodePngChunk);

declare var OffscreenCanvas: any; // shutting up some outdated compiler(?)

@registerSharedObject() export class DeepzoomImageTileSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(VolumeChunkSource), ImageTileSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;
  gridShape = (() => {
    const gridShape = new Uint32Array(3);
    const {upperVoxelBound, chunkDataSize} = this.spec;
    for (let i = 0; i < 3; ++i) {
      gridShape[i] = Math.ceil(upperVoxelBound[i] / chunkDataSize[i]);
    }
    return gridShape;
  })();

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken): Promise<void> {
    const {parameters} = this;

    /* This block is enough if support for these aren't needed:
     * - Firefox before 105 (OffscreenCanvas, 2022-09-20)
     * - Safari before 16.4 (OffscreenCanvas, 2023-03-27)
     */
    const {tilesize, overlap} = parameters;
    const [x, y] = chunk.chunkGridPosition;
    const url = `${parameters.url}/${x}_${y}.${ImageTileEncoding[parameters.encoding].toLowerCase()}`;
    const response: Blob = await cancellableFetchSpecialOk(this.credentialsProvider, url, {}, response => response.blob(), cancellationToken);
    const tile = await createImageBitmap(response);
    const canvas = new OffscreenCanvas(tilesize, tilesize);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(tile, x === 0 ? 0 : -overlap, y === 0 ? 0 : -overlap);
    const id = ctx.getImageData(0, 0, tilesize, tilesize).data;
    const t2 = tilesize * tilesize;
    const d = chunk.data = new Uint8Array(t2 * 3);
    for (let i = 0; i < t2; i++) {
      d[i] = id[i * 4];
      d[i + t2] = id[i * 4 + 1];
      d[i + 2 * t2] = id[i * 4 + 2];
    }

    // let response: ArrayBuffer|undefined;
    //   let url: string;
    //   {
    //     // chunkPosition must not be captured, since it will be invalidated by the next call to
    //     // computeChunkBounds.
    //     // let chunkPosition = this.computeChunkBounds(chunk);
    //     this.computeChunkBounds(chunk);
    //     // let chunkDataSize = chunk.chunkDataSize!;
    //     // url = `${parameters.url}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
    //     //     `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
    //     //     `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
    //     url = `${parameters.url}/${chunk.chunkGridPosition[0]}_${chunk.chunkGridPosition[1]}.${ImageTileEncoding[parameters.encoding].toLowerCase()}`;
    //   }
    //   try {
    //     response = await cancellableFetchSpecialOk(
    //         this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
    //   } catch (e) {
    //     if (isNotFoundError(e)) {
    //       response = undefined;
    //     } else {
    //       throw e;
    //     }
    //   }
    // if (response !== undefined) {
    //   await this.chunkDecoder(chunk, cancellationToken, response);
    // }
  }
}
