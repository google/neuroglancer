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
import type { ChunkSourceParametersConstructor } from "#src/chunk_manager/base.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import type { DVIDToken } from "#src/datasource/dvid/api.js";
import {
  DVIDInstance,
  fetchWithDVIDCredentials,
  appendQueryStringForDvid,
} from "#src/datasource/dvid/api.js";
import {
  MeshSourceParameters,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/dvid/base.js";
import type { FragmentChunk, ManifestChunk } from "#src/mesh/backend.js";
import {
  assignMeshFragmentData,
  decodeTriangleVertexPositionsAndIndices,
  MeshSource,
} from "#src/mesh/backend.js";
import type { SkeletonChunk } from "#src/skeleton/backend.js";
import { SkeletonSource } from "#src/skeleton/backend.js";
import { decodeSwcSkeletonChunk } from "#src/skeleton/decode_swc_skeleton.js";
import { decodeCompressedSegmentationChunk } from "#src/sliceview/backend_chunk_decoders/compressed_segmentation.js";
import { decodeJpegChunk } from "#src/sliceview/backend_chunk_decoders/jpeg.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { Endianness } from "#src/util/endian.js";
import type { SharedObject } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

function DVIDSource<
  Parameters,
  TBase extends { new (...args: any[]): SharedObject },
>(
  Base: TBase,
  parametersConstructor: ChunkSourceParametersConstructor<Parameters>,
) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<DVIDToken>()(Base),
    parametersConstructor,
  );
}

@registerSharedObject()
export class DVIDSkeletonSource extends DVIDSource(
  SkeletonSource,
  SkeletonSourceParameters,
) {
  download(chunk: SkeletonChunk, abortSignal: AbortSignal) {
    const { parameters } = this;
    const bodyid = `${chunk.objectId}`;
    const url =
      `${parameters.baseUrl}/api/node/${parameters.nodeKey}` +
      `/${parameters.dataInstanceKey}/key/` +
      bodyid +
      "_swc";
    return fetchWithDVIDCredentials(
      this.credentialsProvider,
      appendQueryStringForDvid(url, parameters.user),
      {
        signal: abortSignal,
      },
    )
      .then((response) => response.arrayBuffer())
      .then((response) => {
        const enc = new TextDecoder("utf-8");
        decodeSwcSkeletonChunk(chunk, enc.decode(response));
      });
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
export class DVIDMeshSource extends DVIDSource(
  MeshSource,
  MeshSourceParameters,
) {
  download(chunk: ManifestChunk) {
    // DVID does not currently store meshes chunked, the main
    // use-case is for low-resolution 3D views.
    // for now, fragmentId is the body id
    chunk.fragmentIds = [`${chunk.objectId}`];
    return Promise.resolve(undefined);
  }

  downloadFragment(chunk: FragmentChunk, abortSignal: AbortSignal) {
    const { parameters } = this;
    const dvidInstance = new DVIDInstance(
      parameters.baseUrl,
      parameters.nodeKey,
    );
    const meshUrl = dvidInstance.getKeyValueUrl(
      parameters.dataInstanceKey,
      `${chunk.fragmentId}.ngmesh`,
    );

    return fetchWithDVIDCredentials(
      this.credentialsProvider,
      appendQueryStringForDvid(meshUrl, parameters.user),
      {
        signal: abortSignal,
      },
    )
      .then((response) => response.arrayBuffer())
      .then((response) => decodeFragmentChunk(chunk, response));
  }
}

@registerSharedObject()
export class DVIDVolumeChunkSource extends DVIDSource(
  VolumeChunkSource,
  VolumeChunkSourceParameters,
) {
  async download(chunk: VolumeChunk, abortSignal: AbortSignal) {
    const params = this.parameters;
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      const chunkPosition = this.computeChunkBounds(chunk);
      const chunkDataSize = chunk.chunkDataSize!;

      // if the volume is an image, get a jpeg
      path = this.getPath(chunkPosition, chunkDataSize);
    }
    const decoder = this.getDecoder(params);
    const response = await fetchWithDVIDCredentials(
      this.credentialsProvider,
      appendQueryStringForDvid(`${params.baseUrl}${path}`, params.user),
      { signal: abortSignal },
    ).then((response) => response.arrayBuffer());
    await decoder(
      chunk,
      abortSignal,
      params.encoding === VolumeChunkEncoding.JPEG
        ? response.slice(16)
        : response,
    );
  }
  getPath(chunkPosition: Float32Array, chunkDataSize: Uint32Array) {
    const params = this.parameters;
    if (params.encoding === VolumeChunkEncoding.JPEG) {
      return (
        `/api/node/${params.nodeKey}/${params.dataInstanceKey}/subvolblocks/` +
        `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
        `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}`
      );
    }
    if (params.encoding === VolumeChunkEncoding.RAW) {
      return (
        `/api/node/${params.nodeKey}/${params.dataInstanceKey}/raw/0_1_2/` +
        `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
        `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}/jpeg`
      );
    }
    if (params.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
      return (
        `/api/node/${params.nodeKey}/${params.dataInstanceKey}/raw/0_1_2/` +
        `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
        `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}?compression=googlegzip&scale=${params.dataScale}`
      );
    }
    // encoding is COMPRESSED_SEGMENTATION
    return (
      `/api/node/${params.nodeKey}/${params.dataInstanceKey}/raw/0_1_2/` +
      `${chunkDataSize[0]}_${chunkDataSize[1]}_${chunkDataSize[2]}/` +
      `${chunkPosition[0]}_${chunkPosition[1]}_${chunkPosition[2]}?compression=googlegzip`
    );
  }
  getDecoder(params: any) {
    if (
      params.encoding === VolumeChunkEncoding.JPEG ||
      params.encoding === VolumeChunkEncoding.RAW
    ) {
      return decodeJpegChunk;
    }
    // encoding is COMPRESSED_SEGMENTATION
    return decodeCompressedSegmentationChunk;
  }
}
