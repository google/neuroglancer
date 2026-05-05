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

import * as json_keys from "#src/layer/segmentation/json_keys.js";

export interface JsonSerializableTrackable<T = unknown> {
  toJSON(): any;
  value: T;
}

export interface SpatialSkeletonSerializationTrackables {
  hiddenObjectAlpha: JsonSerializableTrackable<number>;
  spatialSkeletonGridResolutionTarget2d: JsonSerializableTrackable<number>;
  spatialSkeletonGridResolutionTarget3d: JsonSerializableTrackable<number>;
  spatialSkeletonGridResolutionRelative2d: JsonSerializableTrackable<boolean>;
  spatialSkeletonGridResolutionRelative3d: JsonSerializableTrackable<boolean>;
  spatialSkeletonGridLevel2d: JsonSerializableTrackable<number>;
  spatialSkeletonGridLevel3d: JsonSerializableTrackable<number>;
}

function getSerializedTrackableValue<T>(
  trackable: JsonSerializableTrackable<T>,
  includeDefaults: boolean,
) {
  const value = trackable.toJSON();
  if (value !== undefined) return value;
  if (!includeDefaults) return undefined;
  return trackable.value;
}

function setSerializedTrackable<T>(
  target: Record<string, any>,
  key: string,
  trackable: JsonSerializableTrackable<T>,
  includeDefaults: boolean,
) {
  const value = getSerializedTrackableValue(trackable, includeDefaults);
  if (value !== undefined) {
    target[key] = value;
  }
}

export function appendSpatialSkeletonSerializationState(
  target: Record<string, any>,
  trackables: SpatialSkeletonSerializationTrackables,
  includeDefaults: boolean,
) {
  setSerializedTrackable(
    target,
    json_keys.HIDDEN_OPACITY_3D_JSON_KEY,
    trackables.hiddenObjectAlpha,
    includeDefaults,
  );
  setSerializedTrackable(
    target,
    json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_TARGET_2D_JSON_KEY,
    trackables.spatialSkeletonGridResolutionTarget2d,
    includeDefaults,
  );
  setSerializedTrackable(
    target,
    json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_TARGET_3D_JSON_KEY,
    trackables.spatialSkeletonGridResolutionTarget3d,
    includeDefaults,
  );
  setSerializedTrackable(
    target,
    json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_RELATIVE_2D_JSON_KEY,
    trackables.spatialSkeletonGridResolutionRelative2d,
    includeDefaults,
  );
  setSerializedTrackable(
    target,
    json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_RELATIVE_3D_JSON_KEY,
    trackables.spatialSkeletonGridResolutionRelative3d,
    includeDefaults,
  );
  setSerializedTrackable(
    target,
    json_keys.SPATIAL_SKELETON_GRID_LEVEL_2D_JSON_KEY,
    trackables.spatialSkeletonGridLevel2d,
    includeDefaults,
  );
  setSerializedTrackable(
    target,
    json_keys.SPATIAL_SKELETON_GRID_LEVEL_3D_JSON_KEY,
    trackables.spatialSkeletonGridLevel3d,
    includeDefaults,
  );
}
