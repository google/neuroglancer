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
  makeCatmaidClient,
} from "#src/datasource/catmaid/base.js";
import { SpatiallyIndexedSkeletonSourceBackend } from "#src/skeleton/spatial/backend.js";
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

  downloadChunk(chunkGridPosition: Float32Array, signal: AbortSignal) {
    const bounds = getCatmaidSpatialSkeletonGridCellBounds(
      chunkGridPosition,
      this.spec.chunkDataSize,
    );
    return this.client.fetchNodes(bounds, this.parameters.catmaidLod ?? 0, {
      cacheProvider: this.parameters.catmaidParameters.cacheProvider,
      signal,
    });
  }
}
