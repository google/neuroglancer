/**
 * @license
 * Copyright 2026 Google Inc.
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
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import type {
  CatmaidClient,
  CatmaidToken,
} from "#src/datasource/catmaid/api.js";
import { getCatmaidSpatialSkeletonGridCellBounds } from "#src/datasource/catmaid/api.js";
import {
  CatmaidSkeletonSourceParameters,
  CatmaidCompleteSkeletonSourceParameters,
  makeCatmaidClient,
} from "#src/datasource/catmaid/base.js";
import { packCatmaidSkeletonNodes } from "#src/datasource/catmaid/skeleton_packing.js";
import type {
  SpatiallyIndexedSkeletonChunk,
  SkeletonChunk,
} from "#src/skeleton/backend.js";
import {
  SpatiallyIndexedSkeletonSourceBackend,
  SkeletonSource,
} from "#src/skeleton/backend.js";
import { registerSharedObject } from "#src/worker_rpc.js";

@registerSharedObject()
export class CatmaidSpatiallyIndexedSkeletonSourceBackend extends WithParameters(
  WithSharedCredentialsProviderCounterpart<CatmaidToken>()(
    SpatiallyIndexedSkeletonSourceBackend,
  ),
  CatmaidSkeletonSourceParameters,
) {
  private clientInstance: CatmaidClient | undefined;

  get client(): CatmaidClient {
    return (this.clientInstance ??= makeCatmaidClient(
      this.parameters.catmaidParameters,
      this.credentialsProvider,
    ));
  }

  constructor(...args: any[]) {
    super(args[0], args[1]);
  }

  async download(chunk: SpatiallyIndexedSkeletonChunk, signal: AbortSignal) {
    const { chunkGridPosition } = chunk;
    const { chunkDataSize } = this.spec;
    const bounds = getCatmaidSpatialSkeletonGridCellBounds(
      chunkGridPosition,
      chunkDataSize,
    );
    const lodValue = this.parameters.catmaidLod ?? 0;
    const cacheProvider = this.parameters.catmaidParameters.cacheProvider;
    const nodes = await this.client.fetchNodes(bounds, lodValue, {
      cacheProvider,
      signal,
    });
    const packed = packCatmaidSkeletonNodes(nodes);

    chunk.vertexPositions = packed.vertexPositions;
    chunk.indices = packed.indices;

    // Pack only segment IDs into vertexAttributes (positions are in vertexPositions)
    chunk.vertexAttributes = [packed.segmentIds];
    chunk.nodeIds = packed.nodeIds;
    chunk.nodeSourceStates = packed.sourceStates;
  }
}

@registerSharedObject()
export class CatmaidSkeletonSourceBackend extends WithParameters(
  WithSharedCredentialsProviderCounterpart<CatmaidToken>()(SkeletonSource),
  CatmaidCompleteSkeletonSourceParameters,
) {
  private clientInstance: CatmaidClient | undefined;

  get client(): CatmaidClient {
    return (this.clientInstance ??= makeCatmaidClient(
      this.parameters.catmaidParameters,
      this.credentialsProvider,
    ));
  }

  constructor(...args: any[]) {
    super(args[0], args[1]);
  }

  async download(chunk: SkeletonChunk, signal: AbortSignal) {
    const skeletonId = Number(chunk.objectId);
    const nodes = await this.client.getSkeleton(skeletonId, { signal });
    const packed = packCatmaidSkeletonNodes(nodes);

    chunk.vertexPositions = packed.vertexPositions;
    chunk.indices = packed.indices;
    chunk.vertexAttributes = [packed.segmentIds];
  }
}
