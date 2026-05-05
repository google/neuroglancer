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

import { describe, expect, it } from "vitest";

import * as json_keys from "#src/layer/segmentation/json_keys.js";
import { appendSpatialSkeletonSerializationState } from "#src/layer/segmentation/spatial_skeleton_serialization.js";
import { trackableAlphaValue } from "#src/trackable_alpha.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import { TrackableValue } from "#src/trackable_value.js";
import {
  verifyFiniteNonNegativeFloat,
  verifyNonnegativeInt,
} from "#src/util/json.js";

function makeTrackables() {
  return {
    hiddenObjectAlpha: trackableAlphaValue(0.5),
    spatialSkeletonGridResolutionTarget2d: new TrackableValue<number>(
      1,
      verifyFiniteNonNegativeFloat,
      1,
    ),
    spatialSkeletonGridResolutionTarget3d: new TrackableValue<number>(
      1,
      verifyFiniteNonNegativeFloat,
      1,
    ),
    spatialSkeletonGridResolutionRelative2d: new TrackableBoolean(false, false),
    spatialSkeletonGridResolutionRelative3d: new TrackableBoolean(false, false),
    spatialSkeletonGridLevel2d: new TrackableValue<number>(
      0,
      verifyNonnegativeInt,
      0,
    ),
    spatialSkeletonGridLevel3d: new TrackableValue<number>(
      0,
      verifyNonnegativeInt,
      0,
    ),
  };
}

describe("appendSpatialSkeletonSerializationState", () => {
  it("does not emit spatial skeleton keys when round-tripping a legacy spec", () => {
    const legacySpec: Record<string, unknown> = {};
    const trackables = makeTrackables();
    trackables.hiddenObjectAlpha.restoreState(
      legacySpec[json_keys.HIDDEN_OPACITY_3D_JSON_KEY],
    );
    trackables.spatialSkeletonGridResolutionTarget2d.restoreState(
      legacySpec[json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_TARGET_2D_JSON_KEY],
    );
    trackables.spatialSkeletonGridResolutionTarget3d.restoreState(
      legacySpec[json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_TARGET_3D_JSON_KEY],
    );
    trackables.spatialSkeletonGridResolutionRelative2d.restoreState(
      legacySpec[
        json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_RELATIVE_2D_JSON_KEY
      ],
    );
    trackables.spatialSkeletonGridResolutionRelative3d.restoreState(
      legacySpec[
        json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_RELATIVE_3D_JSON_KEY
      ],
    );
    trackables.spatialSkeletonGridLevel2d.restoreState(
      legacySpec[json_keys.SPATIAL_SKELETON_GRID_LEVEL_2D_JSON_KEY],
    );
    trackables.spatialSkeletonGridLevel3d.restoreState(
      legacySpec[json_keys.SPATIAL_SKELETON_GRID_LEVEL_3D_JSON_KEY],
    );

    const serialized: Record<string, unknown> = {};
    appendSpatialSkeletonSerializationState(
      serialized,
      trackables,
      /* includeDefaults= */ false,
    );
    expect(serialized).toEqual({});
  });

  it("emits non-default values for non-spatial layers", () => {
    const trackables = makeTrackables();
    trackables.hiddenObjectAlpha.value = 0.35;

    const serialized: Record<string, unknown> = {};
    appendSpatialSkeletonSerializationState(
      serialized,
      trackables,
      /* includeDefaults= */ false,
    );
    expect(serialized).toEqual({
      [json_keys.HIDDEN_OPACITY_3D_JSON_KEY]: 0.35,
    });
  });

  it("emits defaults for spatially indexed skeleton layers", () => {
    const trackables = makeTrackables();

    const serialized: Record<string, unknown> = {};
    appendSpatialSkeletonSerializationState(
      serialized,
      trackables,
      /* includeDefaults= */ true,
    );
    expect(serialized).toEqual({
      [json_keys.HIDDEN_OPACITY_3D_JSON_KEY]: 0.5,
      [json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_TARGET_2D_JSON_KEY]: 1,
      [json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_TARGET_3D_JSON_KEY]: 1,
      [json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_RELATIVE_2D_JSON_KEY]: false,
      [json_keys.SPATIAL_SKELETON_GRID_RESOLUTION_RELATIVE_3D_JSON_KEY]: false,
      [json_keys.SPATIAL_SKELETON_GRID_LEVEL_2D_JSON_KEY]: 0,
      [json_keys.SPATIAL_SKELETON_GRID_LEVEL_3D_JSON_KEY]: 0,
    });
  });
});
