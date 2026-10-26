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

import {
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { SkeletonFindPathState } from "#src/skeleton/find_path/find_path.js";
import { SpatialSkeletonFindPathAnnotationController } from "#src/skeleton/find_path/find_path_attachment.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";

function makeFixture(state: SkeletonFindPathState) {
  const coordinateSpace = makeCoordinateSpace({
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    scales: Float64Array.of(1, 1, 1),
  });
  const transform = new WatchableCoordinateSpaceTransform(
    makeIdentityTransform(coordinateSpace),
  );
  const visibleSegments = {
    size: 0,
    changed: new NullarySignal(),
  };
  const displayState = {
    segmentationGroupState: new WatchableValue({ visibleSegments }),
  };
  let addedState: unknown;
  let addedSubsource: unknown;
  const layer = {
    displayState,
    localPosition: new WatchableValue(new Float32Array(3)),
    addAnnotationLayerState(stateValue: unknown, subsourceValue: unknown) {
      addedState = stateValue;
      addedSubsource = subsourceValue;
    },
  } as unknown as SegmentationUserLayer;
  const loadedSubsource = {
    loadedDataSource: {
      transform,
      layerDataSource: { name: "test data source" },
    },
    subsourceEntry: { id: "skeletons" },
    subsourceIndex: 4,
    getRenderLayerTransform: () =>
      new WatchableValue({ error: new Error("Unused test transform") }),
  } as unknown as LoadedDataSubsource;
  const controller = new SpatialSkeletonFindPathAnnotationController({
    layer,
    loadedSubsource,
    state,
  });
  return {
    controller,
    layer,
    loadedSubsource,
    transform,
    get addedState() {
      return addedState;
    },
    get addedSubsource() {
      return addedSubsource;
    },
  };
}

describe("SpatialSkeletonFindPathAnnotationController", () => {
  it("adds an independent white annotation layer for the loaded subsource", () => {
    const state = new SkeletonFindPathState();
    const fixture = makeFixture(state);
    const { controller } = fixture;

    expect(fixture.addedState).toBe(controller.annotationState);
    expect(fixture.addedSubsource).toBe(fixture.loadedSubsource);
    expect(controller.annotationState.subsourceId).toBe("skeletons");
    expect(controller.annotationState.subsourceIndex).toBe(4);
    expect(controller.annotationState.subsubsourceId).toBe(
      "spatialSkeletonFindPath",
    );
    expect(controller.annotations.annotationSource.relationships).toEqual([
      "associated segments",
    ]);
    expect(
      Array.from(controller.annotationState.displayState.color.value),
    ).toEqual([1, 1, 1]);
    const relationship =
      controller.annotationState.displayState.relationshipStates.get(
        "associated segments",
      );
    expect(relationship?.segmentationState.value).toBe(
      fixture.layer.displayState,
    );
    expect(relationship?.showMatches.value).toBe(false);

    controller.dispose();
    state.dispose();
  });
});
