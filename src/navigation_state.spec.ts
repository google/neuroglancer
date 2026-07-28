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
const dimensionIds: { [name: string]: number } = { x: 1, y: 2, z: 3, c: 4 };

function makeSpace(
  names: string[],
  scales: number[],
  upperBounds: number[],
  options: {
    lowerBounds?: number[];
    voxelCenterAtIntegerCoordinates?: boolean[];
  } = {},
): CoordinateSpace {
  const {
    lowerBounds = names.map(() => 0),
    voxelCenterAtIntegerCoordinates = names.map(() => false),
  } = options;
  return makeCoordinateSpace({
    names,
    ids: names.map((name) => dimensionIds[name]),
    units: names.map(() => "m"),
    scales: Float64Array.from(scales),
    bounds: {
      lowerBounds: Float64Array.from(lowerBounds),
      upperBounds: Float64Array.from(upperBounds),
      voxelCenterAtIntegerCoordinates,
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

describe("Position edge cases", () => {
  function newPosition(): {
    coordinateSpace: WatchableValue<CoordinateSpace>;
    position: Position;
  } {
    const coordinateSpace = new WatchableValue<CoordinateSpace>(
      emptyInvalidCoordinateSpace,
    );
    return { coordinateSpace, position: new Position(coordinateSpace) };
  }

  it("re-infers the position when the rank changes as well as the order", () => {
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    // A channel dimension appears, so the rank no longer matches.
    const zxycSpace = makeSpace(
      ["z", "x", "y", "c"],
      [4e-8, 4e-9, 4e-9, 1],
      [5000, 250000, 120000, 10],
    );
    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxycSpace;

    expectWithinBounds(zxycSpace, position.value);
    expect(Array.from(position.value)).toEqual([
      2500.5, 125000.5, 60000.5, 5.5,
    ]);
    position.dispose();
  });

  it("re-infers after several consecutive invalid coordinate spaces", () => {
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    const otherInvalidSpace = makeCoordinateSpace({
      valid: false,
      names: [],
      units: [],
      scales: new Float64Array(0),
      boundingBoxes: [],
    });
    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = otherInvalidSpace;
    coordinateSpace.value = zxySpace;

    expectWithinBounds(zxySpace, position.value);
    expect(Array.from(position.value)).toEqual([2500.5, 125000.5, 60000.5]);
    position.dispose();
  });

  it("re-infers when a reset leaves an inferred position behind", () => {
    // The sequence reported in the issue: resetting the viewer state empties
    // the position while the outgoing coordinate space is still valid, so the
    // next render infers a position for that space.  Applying the new state
    // then replaces the space through an invalid gap, and the position left
    // behind must not be carried over by index.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    position.restoreState([1, 2, 3]);

    position.reset();
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxySpace;

    expectWithinBounds(zxySpace, position.value);
    expect(Array.from(position.value)).toEqual([2500.5, 125000.5, 60000.5]);
    position.dispose();
  });

  it("leaves an inferred position unchanged when the same space returns", () => {
    // Reloading the same data must not make the position jump.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    const before = Array.from(position.value);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzSpace;

    expect(Array.from(position.value)).toEqual(before);
    position.dispose();
  });

  it("keeps an explicitly restored position that lies outside the bounds", () => {
    // Navigating deliberately outside the volume is allowed; only inferred
    // positions are recomputed.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    position.restoreState([999999, 0, 0]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzSpace;

    expect(Array.from(position.value)).toEqual([999999, 0, 0]);
    position.dispose();
  });

  it("infers a finite position for unbounded dimensions", () => {
    const { coordinateSpace, position } = newPosition();
    const unboundedSpace = makeSpace(
      ["x", "y", "z"],
      [1, 1, 1],
      [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ],
      {
        lowerBounds: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, 0],
      },
    );
    coordinateSpace.value = unboundedSpace;

    for (const coordinate of position.value) {
      expect(Number.isFinite(coordinate)).toBe(true);
    }
    expect(Array.from(position.value)).toEqual([0.5, 0.5, 0.5]);
    position.dispose();
  });

  it("rounds to integer coordinates where the voxel centre is integral", () => {
    const { coordinateSpace, position } = newPosition();
    const mixedSpace = makeSpace(["x", "y", "z"], [1, 1, 1], [100, 100, 100], {
      voxelCenterAtIntegerCoordinates: [true, false, true],
    });
    coordinateSpace.value = mixedSpace;
    expect(Array.from(position.value)).toEqual([50, 50.5, 50]);
    position.dispose();
  });

  it("still matches dimensions by id when the previous space stays valid", () => {
    // The reordering path that never goes through an invalid space is
    // unaffected: coordinates are remapped by dimension id.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    coordinateSpace.value = zxySpace;

    expectWithinBounds(zxySpace, position.value);
    expect(Array.from(position.value)).toEqual([2500.5, 125000.5, 60000.5]);
    position.dispose();
  });

  it("keeps an inferred position inferred across a remap between valid spaces", () => {
    // Matching dimensions by id is not a move, so a position that is still
    // exactly as inferred stays that way and must be re-inferred if the
    // coordinate space is later replaced while invalid.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    coordinateSpace.value = zxySpace;
    expect(Array.from(position.value)).toEqual([2500.5, 125000.5, 60000.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzSpace;

    expectWithinBounds(xyzSpace, position.value);
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);
    position.dispose();
  });

  it("keeps an explicit position explicit across a remap between valid spaces", () => {
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    position.restoreState([1000, 2000, 3000]);
    coordinateSpace.value = zxySpace;
    expect(Array.from(position.value)).toEqual([3000, 1000, 2000]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxySpace;

    expect(Array.from(position.value)).toEqual([3000, 1000, 2000]);
    position.dispose();
  });

  it("re-infers a snapped inferred position after a reorder", () => {
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    position.snapToVoxel();

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxySpace;

    expectWithinBounds(zxySpace, position.value);
    expect(Array.from(position.value)).toEqual([2500.5, 125000.5, 60000.5]);
    position.dispose();
  });

  it("carries inferred-ness across assign", () => {
    const source = newPosition();
    source.coordinateSpace.value = xyzSpace;
    expect(Array.from(source.position.value)).toEqual([
      125000.5, 60000.5, 2500.5,
    ]);

    const target = newPosition();
    target.position.assign(source.position);
    // Reading the value here is load-bearing: `assign` copies the source's
    // valid coordinate space, so the target has to observe its own invalid
    // space before the new one arrives.  Without this read the dimension-id
    // remap path runs instead of the invalid-gap path under test.
    expect(Array.from(target.position.value)).toEqual([
      125000.5, 60000.5, 2500.5,
    ]);

    // The copied position was inferred, so it must be recomputed rather than
    // reused when the target's space is replaced while invalid.
    target.coordinateSpace.value = emptyInvalidCoordinateSpace;
    target.coordinateSpace.value = zxySpace;

    expectWithinBounds(zxySpace, target.position.value);
    expect(Array.from(target.position.value)).toEqual([
      2500.5, 125000.5, 60000.5,
    ]);
    source.position.dispose();
    target.position.dispose();
  });

  it("keeps a position that was panned in place", () => {
    // `NavigationState.translateVoxelsRelative` and the slice-view zoom move the
    // position by writing into the array returned by `value` rather than going
    // through the setter, so a position that started out inferred must stop
    // counting as inferred once the user has moved it.  Such a position is kept
    // for the same reason an explicitly restored one is: it is a location the
    // user chose.  There is no previous valid coordinate space left to match
    // dimension ids against, so the coordinates carry over by index, exactly as
    // they do for a position restored from JSON.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;

    const voxelCoordinates = position.value;
    voxelCoordinates[0] = 1000;
    voxelCoordinates[1] = 2000;
    position.changed.dispatch();

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxySpace;

    expect(Array.from(position.value)).toEqual([1000, 2000, 2500.5]);
    position.dispose();
  });

  it("keeps a position with a single panned dimension", () => {
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;

    position.value[2] = 4000;
    position.changed.dispatch();

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxySpace;

    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 4000]);
    position.dispose();
  });

  it("re-infers a position panned back onto the inferred coordinates", () => {
    // Moving the position and then moving it back leaves it indistinguishable
    // from a position that was never touched, so it is treated as inferred.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;

    position.value[0] = 1000;
    position.changed.dispatch();
    position.value[0] = 125000.5;
    position.changed.dispatch();

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxySpace;

    expectWithinBounds(zxySpace, position.value);
    expect(Array.from(position.value)).toEqual([2500.5, 125000.5, 60000.5]);
    position.dispose();
  });

  it("carries explicitness across assign", () => {
    const source = newPosition();
    source.coordinateSpace.value = xyzSpace;
    source.position.restoreState([1, 2, 3]);

    const target = newPosition();
    target.position.assign(source.position);
    // As above, the target must observe its own invalid coordinate space
    // first; otherwise it still holds the space copied from the source and the
    // assignment below is a no-op that exercises nothing.
    expect(Array.from(target.position.value)).toEqual([1, 2, 3]);

    target.coordinateSpace.value = xyzSpace;

    expect(Array.from(target.position.value)).toEqual([1, 2, 3]);
    source.position.dispose();
    target.position.dispose();
  });
});
