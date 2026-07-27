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

// Stable per-name dimension ids, so that a space listing the same dimensions in
// a different order still refers to the same dimensions.
const dimensionIds: { [name: string]: number } = { x: 1, y: 2, z: 3 };

function makeSpace(
  names: string[],
  scales: number[],
  upperBounds: number[],
): CoordinateSpace {
  const rank = names.length;
  return makeCoordinateSpace({
    names,
    ids: names.map((name) => dimensionIds[name]),
    units: names.map(() => "m"),
    scales: Float64Array.from(scales),
    bounds: {
      lowerBounds: new Float64Array(rank),
      upperBounds: Float64Array.from(upperBounds),
      voxelCenterAtIntegerCoordinates: names.map(() => false),
    },
  });
}

// Bounds shaped like a typical EM volume: `x` and `y` are large, `z` is small.
// The same volume, described with dimensions listed in two different orders.
const xyzSpace = makeSpace(
  ["x", "y", "z"],
  [4e-9, 4e-9, 4e-8],
  [250000, 120000, 5000],
);
const zxySpace = makeSpace(
  ["z", "x", "y"],
  [4e-8, 4e-9, 4e-9],
  [5000, 250000, 120000],
);

function expectWithinBounds(space: CoordinateSpace, coordinates: Float32Array) {
  const { lowerBounds, upperBounds } = space.bounds;
  for (let i = 0; i < coordinates.length; ++i) {
    expect(
      coordinates[i],
      `dimension ${space.names[i]} (index ${i}) out of bounds`,
    ).toBeGreaterThanOrEqual(lowerBounds[i]);
    expect(
      coordinates[i],
      `dimension ${space.names[i]} (index ${i}) out of bounds`,
    ).toBeLessThanOrEqual(upperBounds[i]);
  }
}

describe("Position", () => {
  it("infers the default position as the centre of the bounds", () => {
    const coordinateSpace = new WatchableValue<CoordinateSpace>(
      emptyInvalidCoordinateSpace,
    );
    const position = new Position(coordinateSpace);
    coordinateSpace.value = xyzSpace;
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);
    position.dispose();
  });

  it("re-infers the default position when the coordinate space becomes valid again with a different dimension order", () => {
    const coordinateSpace = new WatchableValue<CoordinateSpace>(
      emptyInvalidCoordinateSpace,
    );
    const position = new Position(coordinateSpace);

    // Initial load: the position is inferred as the centre of the bounds.
    coordinateSpace.value = xyzSpace;
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    // Resetting the viewer state leaves the coordinate space invalid while the
    // data source is reloaded.
    coordinateSpace.value = emptyInvalidCoordinateSpace;

    // The same state is applied again, but this time the dimensions are listed
    // in `z`, `x`, `y` order.  The previously inferred position refers to the
    // old ordering and must not be carried over unchanged.
    coordinateSpace.value = zxySpace;

    expectWithinBounds(zxySpace, position.value);
    expect(Array.from(position.value)).toEqual([2500.5, 125000.5, 60000.5]);
    position.dispose();
  });

  it("keeps a position that was explicitly restored from JSON", () => {
    const coordinateSpace = new WatchableValue<CoordinateSpace>(
      emptyInvalidCoordinateSpace,
    );
    const position = new Position(coordinateSpace);
    coordinateSpace.value = xyzSpace;

    position.restoreState([1, 2, 3]);
    expect(Array.from(position.value)).toEqual([1, 2, 3]);

    // An explicit position must survive the coordinate space going invalid and
    // valid again.
    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzSpace;
    expect(Array.from(position.value)).toEqual([1, 2, 3]);
    position.dispose();
  });

  it("keeps a position that was explicitly assigned", () => {
    const coordinateSpace = new WatchableValue<CoordinateSpace>(
      emptyInvalidCoordinateSpace,
    );
    const position = new Position(coordinateSpace);
    coordinateSpace.value = xyzSpace;

    position.value = Float32Array.of(10, 20, 30);
    expect(Array.from(position.value)).toEqual([10, 20, 30]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzSpace;
    expect(Array.from(position.value)).toEqual([10, 20, 30]);
    position.dispose();
  });
});
