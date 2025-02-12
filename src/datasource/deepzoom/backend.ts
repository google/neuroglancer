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

import { decodeJpeg } from "#src/async_computation/decode_jpeg_request.js";
import { decodePng } from "#src/async_computation/decode_png_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import {
  ImageTileEncoding,
  ImageTileSourceParameters,
} from "#src/datasource/deepzoom/base.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { transposeArray2d } from "#src/util/array.js";
import { registerSharedObject } from "#src/worker_rpc.js";

/* This is enough if support for these aren't needed:
 * - Firefox before 105 (OffscreenCanvas, 2022-09-20)
 * - Safari before 16.4 (OffscreenCanvas, 2023-03-27)
 */
// declare var OffscreenCanvas: any; // shutting up some outdated compiler(?)

@registerSharedObject()
export class DeepzoomImageTileSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  ImageTileSourceParameters,
) {
  private tileKvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.url,
  );

  gridShape = (() => {
    const gridShape = new Uint32Array(2);
    const { upperVoxelBound, chunkDataSize } = this.spec;
    for (let i = 0; i < 2; ++i) {
      gridShape[i] = Math.ceil(upperVoxelBound[i] / chunkDataSize[i]);
    }
    return gridShape;
  })();

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    const { parameters } = this;

    // /* This block is enough if support for these aren't needed:
    //  * - Firefox before 105 (OffscreenCanvas, 2022-09-20)
    //  * - Safari before 16.4 (OffscreenCanvas, 2023-03-27)
    //  */
    // const {tilesize, overlap} = parameters;
    // const [x, y] = chunk.chunkGridPosition;
    // const url = `${parameters.url}/${x}_${y}.${ImageTileEncoding[parameters.encoding].toLowerCase()}`;
    // const response: Blob = await (await fetchSpecialOk(this.credentialsProvider, url, {signal: signal})).blob();
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

    const { tilesize, overlap, encoding } = parameters;
    const [x, y] = chunk.chunkGridPosition;
    const ox = x === 0 ? 0 : overlap;
    const oy = y === 0 ? 0 : overlap;
    const path = `${this.tileKvStore.path}/${x}_${y}.${parameters.format}`;
    const response = await this.tileKvStore.store.read(path, {
      signal,
    });
    if (response === undefined) {
      return;
    }
    const responseArray = new Uint8Array(await response.response.arrayBuffer());

    let tilewidth = 0;
    let tileheight = 0;
    let tiledata: Uint8Array | undefined;
    switch (encoding) {
      case ImageTileEncoding.PNG: {
        const pngbitmap = await requestAsyncComputation(
          decodePng,
          signal,
          [responseArray.buffer],
          responseArray,
          undefined,
          undefined,
          undefined,
          3,
          1,
          false,
        );
        ({ width: tilewidth, height: tileheight } = pngbitmap);
        tiledata = transposeArray2d(
          pngbitmap.uint8Array,
          tilewidth * tileheight,
          3,
        );
        break;
      }

      case ImageTileEncoding.JPG:
      case ImageTileEncoding.JPEG: {
        const jpegbitmap = await requestAsyncComputation(
          decodeJpeg,
          signal,
          [responseArray.buffer],
          responseArray,
          undefined,
          undefined,
          undefined,
          3,
          false,
        );
        ({
          uint8Array: tiledata,
          width: tilewidth,
          height: tileheight,
        } = jpegbitmap);
        break;
      }
    }
    if (tiledata !== undefined) {
      const t2 = tilesize * tilesize;
      const twh = tilewidth * tileheight;
      const d = (chunk.data = new Uint8Array(t2 * 3));
      for (let k = 0; k < 3; k++)
        for (let j = 0; j < tileheight; j++)
          for (let i = 0; i < tilewidth; i++)
            d[i + j * tilesize + k * t2] =
              tiledata[i + ox + (j + oy) * tilewidth + k * twh];
    }
  }
}
