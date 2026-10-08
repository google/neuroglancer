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
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import {
  emptyInvalidCoordinateSpace,
  makeCoordinateSpace,
} from "#src/coordinate_transform.js";
import { UserLayer } from "#src/layer/index.js";
import { Position } from "#src/navigation_state.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import { WatchableValue } from "#src/trackable_value.js";

function makeSpace(names: string[], upperBounds: number[]): CoordinateSpace {
  return makeCoordinateSpace({
    names,
    ids: names.map((_, i) => i + 1),
    units: names.map(() => "m"),
    scales: Float64Array.from(names.map(() => 1e-9)),
    bounds: {
      lowerBounds: new Float64Array(names.length),
      upperBounds: Float64Array.from(upperBounds),
      voxelCenterAtIntegerCoordinates: names.map(() => false),
    },
  });
}

const globalSpace = makeSpace(["x", "y", "z"], [1000, 800, 600]);
const globalLargerSpace = makeSpace(["x", "y", "z"], [2000, 1600, 1200]);
const localSpace = makeSpace(["c"], [8]);
const localLargerSpace = makeSpace(["c"], [16]);
const GLOBAL_CENTRE = [500.5, 400.5, 300.5];
const GLOBAL_LARGER_CENTRE = [1000.5, 800.5, 600.5];
const LOCAL_CENTRE = [4.5];
const LOCAL_LARGER_CENTRE = [8.5];

// `setLayerPosition` only touches `this.manager.root.globalPosition` and
// `this.localPosition`, so it can be driven against real `Position`s without
// constructing a full layer.
function setup() {
  const globalCoordinateSpace = new WatchableValue<CoordinateSpace>(
    emptyInvalidCoordinateSpace,
  );
  const localCoordinateSpace = new WatchableValue<CoordinateSpace>(
    emptyInvalidCoordinateSpace,
  );
  const globalPosition = new Position(globalCoordinateSpace);
  const localPosition = new Position(localCoordinateSpace);
  globalCoordinateSpace.value = globalSpace;
  localCoordinateSpace.value = localSpace;
  const layer = {
    manager: { root: { globalPosition } },
    localPosition,
  } as unknown as UserLayer;
  // A rank-4 render layer: dimensions 0-2 come from the global position and
  // dimension 3 from the local (channel) position.
  const modelTransform = {
    globalToRenderLayerDimensions: [0, 1, 2],
    localToRenderLayerDimensions: [3],
  } as unknown as RenderLayerTransform;
  const setLayerPosition = (layerPosition: Float32Array) =>
    UserLayer.prototype.setLayerPosition.call(
      layer,
      modelTransform,
      layerPosition,
    );
  return {
    globalCoordinateSpace,
    localCoordinateSpace,
    globalPosition,
    localPosition,
    setLayerPosition,
  };
}

function reload(
  coordinateSpace: WatchableValue<CoordinateSpace>,
  space: CoordinateSpace,
) {
  coordinateSpace.value = emptyInvalidCoordinateSpace;
  coordinateSpace.value = space;
}

describe("UserLayer.setLayerPosition", () => {
  it("keeps global and local positions it moved", () => {
    const {
      globalCoordinateSpace,
      localCoordinateSpace,
      globalPosition,
      localPosition,
      setLayerPosition,
    } = setup();
    setLayerPosition(Float32Array.of(10, 20, 30, 2));
    expect(Array.from(globalPosition.value)).toEqual([10, 20, 30]);
    expect(Array.from(localPosition.value)).toEqual([2]);

    reload(globalCoordinateSpace, globalLargerSpace);
    reload(localCoordinateSpace, localLargerSpace);

    expect(Array.from(globalPosition.value)).toEqual([10, 20, 30]);
    expect(Array.from(localPosition.value)).toEqual([2]);
    globalPosition.dispose();
    localPosition.dispose();
  });

  it("does not count a layer position that changes nothing as a move", () => {
    const {
      globalCoordinateSpace,
      localCoordinateSpace,
      globalPosition,
      localPosition,
      setLayerPosition,
    } = setup();
    setLayerPosition(Float32Array.of(...GLOBAL_CENTRE, ...LOCAL_CENTRE));

    reload(globalCoordinateSpace, globalLargerSpace);
    reload(localCoordinateSpace, localLargerSpace);

    expect(Array.from(globalPosition.value)).toEqual(GLOBAL_LARGER_CENTRE);
    expect(Array.from(localPosition.value)).toEqual(LOCAL_LARGER_CENTRE);
    globalPosition.dispose();
    localPosition.dispose();
  });

  it("marks only the position that actually moved", () => {
    const {
      globalCoordinateSpace,
      localCoordinateSpace,
      globalPosition,
      localPosition,
      setLayerPosition,
    } = setup();
    // Global coordinates unchanged; only the local channel moves.
    setLayerPosition(Float32Array.of(...GLOBAL_CENTRE, 2));

    reload(globalCoordinateSpace, globalLargerSpace);
    reload(localCoordinateSpace, localLargerSpace);

    expect(Array.from(globalPosition.value)).toEqual(GLOBAL_LARGER_CENTRE);
    expect(Array.from(localPosition.value)).toEqual([2]);
    globalPosition.dispose();
    localPosition.dispose();
  });
});
