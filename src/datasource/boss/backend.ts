/**
 * @license
 * Copyright 2017 Google Inc.
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
import type { ChunkSourceParametersConstructor } from "#src/chunk_manager/base.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import type { BossToken } from "#src/datasource/boss/api.js";
import { fetchWithBossCredentials } from "#src/datasource/boss/api.js";
import {
  MeshSourceParameters,
  VolumeChunkSourceParameters,
} from "#src/datasource/boss/base.js";
import type { FragmentChunk, ManifestChunk } from "#src/mesh/backend.js";
import {
  assignMeshFragmentData,
  decodeJsonManifestChunk,
  decodeTriangleVertexPositionsAndIndices,
  MeshSource,
} from "#src/mesh/backend.js";
import { decodeBossNpzChunk } from "#src/sliceview/backend_chunk_decoders/bossNpz.js";
import type { ChunkDecoder } from "#src/sliceview/backend_chunk_decoders/index.js";
import { decodeJpegChunk } from "#src/sliceview/backend_chunk_decoders/jpeg.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { Endianness } from "#src/util/endian.js";
import type { SharedObject } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

const chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set("npz", decodeBossNpzChunk);
chunkDecoders.set("jpeg", decodeJpegChunk);

const acceptHeaders = new Map<string, string>();
acceptHeaders.set("npz", "application/npygz");
acceptHeaders.set("jpeg", "image/jpeg");

function BossSource<
  Parameters,
  TBase extends { new (...args: any[]): SharedObject },
>(
  Base: TBase,
  parametersConstructor: ChunkSourceParametersConstructor<Parameters>,
) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<BossToken>()(Base),
    parametersConstructor,
  );
}

@registerSharedObject()
export class BossVolumeChunkSource extends BossSource(
  VolumeChunkSource,
  VolumeChunkSourceParameters,
) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    const { parameters } = this;
    let url = `${parameters.baseUrl}/latest/cutout/${parameters.collection}/${parameters.experiment}/${parameters.channel}/${parameters.resolution}`;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      const chunkPosition = this.computeChunkBounds(chunk);
      const chunkDataSize = chunk.chunkDataSize!;
      for (let i = 0; i < 3; ++i) {
        url += `/${chunkPosition[i]}:${chunkPosition[i] + chunkDataSize[i]}`;
      }
    }
    url += "/";

    if (parameters.window !== undefined) {
      url += `?window=${parameters.window[0]},${parameters.window[1]}`;
    }
    const response = await fetchWithBossCredentials(
      this.credentialsProvider,
      url,
      {
        signal: signal,
        headers: { Accept: acceptHeaders.get(parameters.encoding)! },
      },
    );
    await this.chunkDecoder(chunk, signal, await response.arrayBuffer());
  }
}

function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, "fragments");
}

function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
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
export class BossMeshSource extends BossSource(
  MeshSource,
  MeshSourceParameters,
) {
  download(chunk: ManifestChunk, signal: AbortSignal) {
    const { parameters } = this;
    return fetchWithBossCredentials(
      this.credentialsProvider,
      `${parameters.baseUrl}${chunk.objectId}`,
      { signal: signal },
    )
      .then((response) => response.arrayBuffer())
      .then((response) => decodeManifestChunk(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, signal: AbortSignal) {
    const { parameters } = this;
    return fetchWithBossCredentials(
      this.credentialsProvider,
      `${parameters.baseUrl}${chunk.fragmentId}`,
      { signal: signal },
    )
      .then((response) => response.arrayBuffer())
      .then((response) => decodeFragmentChunk(chunk, response));
  }
}
