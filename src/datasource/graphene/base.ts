/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import type { ShardingParameters } from "#src/datasource/precomputed/base.js";
import type { KvStoreContext } from "#src/kvstore/context.js";
import { ReadableHttpKvStore } from "#src/kvstore/http/common.js";
import { joinBaseUrlAndPath } from "#src/kvstore/url.js";
import type {
  ChunkLayoutOptions,
  SliceViewChunkSource,
  SliceViewChunkSpecification,
  SliceViewChunkSpecificationBaseOptions,
  SliceViewChunkSpecificationOptions,
  DataType,
} from "#src/sliceview/base.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import type { mat4 } from "#src/util/geom.js";
import type { FetchOk, HttpError } from "#src/util/http_request.js";

export const PYCG_APP_VERSION = 1;
export const GRAPHENE_MESH_NEW_SEGMENT_RPC_ID = "GrapheneMeshSource:NewSegment";

export enum VolumeChunkEncoding {
  RAW = 0,
  JPEG = 1,
  COMPRESSED_SEGMENTATION = 2,
}

export class VolumeChunkSourceParameters {
  url: string;
  encoding: VolumeChunkEncoding;
  sharding: ShardingParameters | undefined;

  static RPC_ID = "graphene/VolumeChunkSource";
}

export class ChunkedGraphSourceParameters {
  url: string;

  static RPC_ID = "graphene/ChunkedGraphSource";
}

export class MeshSourceParameters {
  manifestUrl: string;
  fragmentUrl: string;
  lod: number;
  sharding: Array<ShardingParameters> | undefined;
  nBitsForLayerId: number;

  static RPC_ID = "graphene/MeshSource";
}

export class MultiscaleMeshSourceParameters {
  manifestUrl: string;
  fragmentUrl: string;
  metadata: MultiscaleMeshMetadata;
  sharding: Array<ShardingParameters>|undefined;
  nBitsForLayerId: number;

  static RPC_ID = 'graphene/MultiscaleMeshSource';
}

export class MultiscaleMeshMetadata {
  transform: mat4;
  lodScaleMultiplier: number;
  vertexQuantizationBits: number;
  sharding: Array<ShardingParameters> | undefined;
}

export function isBaseSegmentId(segmentId: bigint, nBitsForLayerId: number) {
  const layerId = segmentId >> BigInt(64 - nBitsForLayerId);
  return layerId == 1n;
}

export function getGrapheneFragmentKey(fragmentId: string) {
  const sharded = fragmentId.charAt(0) === "~";

  if (sharded) {
    const parts = fragmentId.substring(1).split(/:(.+)/);
    return { key: parts[0], fragmentId: parts[1] };
  }
  return { key: fragmentId, fragmentId: fragmentId };
}

export const CHUNKED_GRAPH_LAYER_RPC_ID = "ChunkedGraphLayer";
export const CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID =
  "ChunkedGraphLayer:updateSources";
export const RENDER_RATIO_LIMIT = 5.0;

export interface ChunkedGraphChunkSpecificationBaseOptions
  extends SliceViewChunkSpecificationBaseOptions {
  /**
   * Specifies offset for use by backend.ts:GenericVolumeChunkSource.computeChunkBounds in
   * calculating chunk voxel coordinates.  The calculated chunk coordinates will be equal to the
   * voxel position (in chunkLayout coordinates) plus this value.
   *
   * Defaults to kZeroVec if not specified.
   */
  baseVoxelOffset?: Float32Array;
  dataType: DataType;
}

export interface ChunkedGraphChunkSpecificationOptions
  extends ChunkedGraphChunkSpecificationBaseOptions,
    SliceViewChunkSpecificationOptions<Uint32Array> {}

/**
 * Specifies parameters for ChunkedGraphChunkSpecification.getDefaults.
 */
export interface ChunkedGraphChunkSpecificationGetDefaultsOptions
  extends ChunkedGraphChunkSpecificationBaseOptions,
    ChunkLayoutOptions {}

/**
 * Specifies a chunk layout and voxel size.
 */
export interface ChunkedGraphChunkSpecification
  extends SliceViewChunkSpecification<Uint32Array> {
  baseVoxelOffset: Float32Array;
  dataType: DataType;
}

export function makeChunkedGraphChunkSpecification(
  options: ChunkedGraphChunkSpecificationOptions,
): ChunkedGraphChunkSpecification {
  const { rank, dataType } = options;
  const { baseVoxelOffset = new Float32Array(rank) } = options;

  return {
    ...makeSliceViewChunkSpecification(options),
    baseVoxelOffset,
    dataType,
  };
}

export interface ChunkedGraphChunkSource extends SliceViewChunkSource {
  spec: ChunkedGraphChunkSpecification;
}

export async function parseGrapheneError(e: HttpError) {
  if (e.response) {
    let msg: string;
    if (e.response.headers.get("content-type") === "application/json") {
      msg = (await e.response.json()).message;
    } else {
      msg = await e.response.text();
    }
    return msg;
  }
  return undefined;
}

export interface HttpSource {
  fetchOkImpl: FetchOk;
  baseUrl: string;
}

export function getHttpSource(
  kvStoreContext: KvStoreContext,
  url: string,
): HttpSource {
  const { store, path } = kvStoreContext.getKvStore(url);
  if (!(store instanceof ReadableHttpKvStore)) {
    throw new Error(`Non-HTTP URL ${JSON.stringify(url)} not supported`);
  }
  const { fetchOkImpl, baseUrl } = store;
  if (baseUrl.includes("?")) {
    throw new Error(`Invalid URL ${baseUrl}: query parameters not supported`);
  }
  return { fetchOkImpl, baseUrl: joinBaseUrlAndPath(baseUrl, path) };
}
