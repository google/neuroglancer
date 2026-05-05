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

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { SpatialSkeletonAction } from "#src/skeleton/actions.js";
import type { SpatialSkeletonCommand } from "#src/skeleton/command_history.js";

export type SpatialSkeletonCommandPayload = object;

export interface SpatialSkeletonEditCommandSource {
  supports(action: SpatialSkeletonAction): boolean;
  createCommand(
    action: SpatialSkeletonAction,
    layer: SegmentationUserLayer,
    payload: SpatialSkeletonCommandPayload,
  ): SpatialSkeletonCommand | undefined;
}

type SpatialSkeletonEditCommandSourceCandidate = {
  supports?: (action: SpatialSkeletonAction) => boolean;
  createCommand?: (
    action: SpatialSkeletonAction,
    layer: SegmentationUserLayer,
    payload: SpatialSkeletonCommandPayload,
  ) => SpatialSkeletonCommand | undefined;
};

export function isSpatialSkeletonEditCommandSource(
  value: unknown,
): value is SpatialSkeletonEditCommandSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SpatialSkeletonEditCommandSourceCandidate).supports ===
      "function" &&
    typeof (value as SpatialSkeletonEditCommandSourceCandidate)
      .createCommand ===
      "function"
  );
}
