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
import { Position } from "#src/navigation_state.js";
import { WatchableValue } from "#src/trackable_value.js";
import { setupPositionDropHandlers } from "#src/ui/position_drag_and_drop.js";
import { positionDragType } from "#src/widget/position_widget.js";

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

const xyzSpace = makeSpace(["x", "y", "z"], [1000, 800, 600]);
const xyzLargerSpace = makeSpace(["x", "y", "z"], [2000, 1600, 1200]);
const XYZ_CENTRE = [500.5, 400.5, 300.5];
const XYZ_LARGER_CENTRE = [1000.5, 800.5, 600.5];

function setup() {
  const coordinateSpace = new WatchableValue<CoordinateSpace>(
    emptyInvalidCoordinateSpace,
  );
  const position = new Position(coordinateSpace);
  coordinateSpace.value = xyzSpace;
  const target = new EventTarget();
  const disposer = setupPositionDropHandlers(target, position);
  return { coordinateSpace, position, target, disposer };
}

// Dispatches a "drop" event carrying a position payload, the way dragging a
// position link onto a viewer does.
function dropPosition(
  target: EventTarget,
  dimensions: string[],
  coordinates: number[],
) {
  const event = Object.assign(new Event("drop", { cancelable: true }), {
    dataTransfer: {
      types: [positionDragType],
      getData: (type: string) =>
        type === positionDragType
          ? JSON.stringify({ dimensions, position: coordinates })
          : "",
    },
  });
  target.dispatchEvent(event);
}

describe("position drag-and-drop", () => {
  it("applies a dropped position and keeps it", () => {
    const { coordinateSpace, position, target, disposer } = setup();
    dropPosition(target, ["x", "y", "z"], [111, 222, 333]);
    expect(Array.from(position.value)).toEqual([111, 222, 333]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual([111, 222, 333]);
    disposer();
    position.dispose();
  });

  it("keeps a position dropped away and back onto the inferred coordinates", () => {
    const { coordinateSpace, position, target, disposer } = setup();
    dropPosition(target, ["x", "y", "z"], [111, 222, 333]);
    dropPosition(target, ["x", "y", "z"], XYZ_CENTRE);
    expect(Array.from(position.value)).toEqual(XYZ_CENTRE);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    // The user chose the position, even though it matches the inferred one.
    expect(Array.from(position.value)).toEqual(XYZ_CENTRE);
    disposer();
    position.dispose();
  });

  it("does not count a drop that changes nothing as a move", () => {
    const { coordinateSpace, position, target, disposer } = setup();
    dropPosition(target, ["x", "y", "z"], XYZ_CENTRE);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual(XYZ_LARGER_CENTRE);
    disposer();
    position.dispose();
  });

  it("applies only the dimensions present in the coordinate space", () => {
    const { coordinateSpace, position, target, disposer } = setup();
    dropPosition(target, ["q", "z"], [7, 42]);
    expect(Array.from(position.value)).toEqual([500.5, 400.5, 42]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual([500.5, 400.5, 42]);
    disposer();
    position.dispose();
  });
});
