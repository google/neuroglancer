/**
 * @license
 * Copyright 2016 Google Inc.
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

import { WithParameters } from "#src/chunk_manager/backend.js";
import {
  MeshSourceParameters,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/python/base.js";
import {
  assignMeshFragmentData,
  decodeTriangleVertexPositionsAndIndices,
  FragmentChunk,
  ManifestChunk,
  MeshSource,
} from "#src/mesh/backend.js";
import { SkeletonChunk, SkeletonSource } from "#src/skeleton/backend.js";
import { decodeSkeletonChunk } from "#src/skeleton/decode_precomputed_skeleton.js";
import { ChunkDecoder } from "#src/sliceview/backend_chunk_decoders/index.js";
import { decodeJpegChunk } from "#src/sliceview/backend_chunk_decoders/jpeg.js";
import { decodeNdstoreNpzChunk } from "#src/sliceview/backend_chunk_decoders/ndstoreNpz.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import { Endianness } from "#src/util/endian.js";
import { fetchOk } from "#src/util/http_request.js";
import { registerSharedObject } from "#src/worker_rpc.js";

const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.NPZ, decodeNdstoreNpzChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);

@registerSharedObject()
export class PythonVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeChunkSourceParameters,
) {
  chunkDecoder = chunkDecoders.get(this.parameters["encoding"])!;
  encoding = VolumeChunkEncoding[this.parameters.encoding].toLowerCase();

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    const { parameters } = this;
    let path = `../../neuroglancer/${this.encoding}/${parameters.key}/${parameters.scaleKey}`;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      const chunkPosition = this.computeChunkBounds(chunk);
      const chunkDataSize = chunk.chunkDataSize!;
      const length = chunkPosition.length;
      path += `/${chunkPosition.join()}/`;
      for (let i = 0; i < length; ++i) {
        if (i !== 0) path += ",";
        path += (chunkPosition[i] + chunkDataSize[i]).toString();
      }
    }
    const response = await fetchOk(new URL(path, parameters.baseUrl).href, {
      signal: signal,
    });
    await this.chunkDecoder(chunk, signal, await response.arrayBuffer());
  }
}

export function decodeFragmentChunk(
  chunk: FragmentChunk,
  response: ArrayBuffer,
) {
  const dv = new DataView(response);
  const numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
    chunk,
    decodeTriangleVertexPositionsAndIndices(
      response,
      Endianness.LITTLE,
      /*vertexByteOffset=*/ 4,
      numVertices,
    ),
  );
}

@registerSharedObject()
export class PythonMeshSource extends WithParameters(
  MeshSource,
  MeshSourceParameters,
) {
  download(chunk: ManifestChunk) {
    // No manifest chunk to download, as there is always only a single fragment.
    chunk.fragmentIds = [""];
    return Promise.resolve(undefined);
  }

  downloadFragment(chunk: FragmentChunk, signal: AbortSignal) {
    const { parameters } = this;
    const requestPath = `../../neuroglancer/mesh/${parameters.key}/${
      chunk.manifestChunk!.objectId
    }`;
    return fetchOk(new URL(requestPath, parameters.baseUrl).href, {
      signal: signal,
    })
      .then((response) => response.arrayBuffer())
      .then((response) => decodeFragmentChunk(chunk, response));
  }
}

@registerSharedObject()
export class PythonSkeletonSource extends WithParameters(
  SkeletonSource,
  SkeletonSourceParameters,
) {
  download(chunk: SkeletonChunk, signal: AbortSignal) {
    const { parameters } = this;
    const requestPath = `../../neuroglancer/skeleton/${parameters.key}/${chunk.objectId}`;
    return fetchOk(new URL(requestPath, parameters.baseUrl).href, {
      signal: signal,
    })
      .then((response) => response.arrayBuffer())
      .then((response) =>
        decodeSkeletonChunk(chunk, response, parameters.vertexAttributes),
      );
  }
}
