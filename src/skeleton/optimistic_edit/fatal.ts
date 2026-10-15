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

export const SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON =
  "Reload the page before making more skeleton edits.";

export type SpatialSkeletonOptimisticFatalReason =
  | "authority-indeterminate"
  | "committed-local-publication-failed"
  | "local-projection-reset-failed";

/** Immutable, layer-scoped reason that optimistic editing cannot continue. */
export interface SpatialSkeletonOptimisticFatalState {
  readonly reason: SpatialSkeletonOptimisticFatalReason;
  readonly authority: "committed" | "indeterminate" | "unchanged";
  readonly intentId?: number;
  readonly operationId?: number;
  readonly cause?: unknown;
}

export function freezeSpatialSkeletonOptimisticFatalState(
  state: SpatialSkeletonOptimisticFatalState,
): SpatialSkeletonOptimisticFatalState {
  return Object.freeze({ ...state });
}

export class SpatialSkeletonOptimisticReloadRequiredError extends Error {
  constructor(readonly fatalState: SpatialSkeletonOptimisticFatalState) {
    super(SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON, {
      cause: fatalState.cause,
    });
    this.name = "SpatialSkeletonOptimisticReloadRequiredError";
  }
}

/** Generic engine boundary for a latch owned by one spatial-skeleton state. */
export interface SpatialSkeletonOptimisticFatalStatePort {
  get(): SpatialSkeletonOptimisticFatalState | undefined;
  latch(state: SpatialSkeletonOptimisticFatalState): boolean;
}
