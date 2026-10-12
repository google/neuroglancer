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

import type { EditableSpatiallyIndexedSkeletonSource } from "#src/skeleton/api.js";
import {
  isSpatialSkeletonOptimisticEditingProvider,
  SpatialSkeletonOptimisticDatasourceContractError,
  type SpatialSkeletonOptimisticEditingProvider,
} from "#src/skeleton/optimistic_edit/api.js";
import type { SpatialSkeletonOptimisticEditQueue } from "#src/skeleton/optimistic_edit/types.js";
import type { SpatialSkeletonLayerContext } from "#src/skeleton/spatial_skeleton_manager.js";

export function getSpatialSkeletonOptimisticEditingProvider(
  source: EditableSpatiallyIndexedSkeletonSource,
): SpatialSkeletonOptimisticEditingProvider | undefined {
  const candidate = source.optimisticEditing;
  return isSpatialSkeletonOptimisticEditingProvider(candidate)
    ? candidate
    : undefined;
}

/**
 * Ensures the state-owned queue using the editable source's validated driver.
 *
 * Command construction calls this boundary every time. The layer state reuses
 * its existing engine for the same source and replaces it only after a new
 * datasource registration has been validated.
 */
export function ensureSpatialSkeletonOptimisticEditQueue(
  layer: SpatialSkeletonLayerContext,
  source: EditableSpatiallyIndexedSkeletonSource,
): SpatialSkeletonOptimisticEditQueue {
  const state = layer.spatialSkeletonState;
  const provider = getSpatialSkeletonOptimisticEditingProvider(source);
  if (provider === undefined) {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Writable spatial skeleton datasource is missing optimisticEditing.createDriver().",
    );
  }
  return state.ensureOptimisticEditingEngine(layer, source, provider);
}
