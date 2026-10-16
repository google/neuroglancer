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

import { describe, expect, it, vi } from "vitest";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import {
  emptyInvalidCoordinateSpace,
  makeCoordinateSpace,
} from "#src/coordinate_transform.js";
import {
  CoordinateSpacePlaybackVelocity,
  DisplayPose,
  OrientationState,
  PlaybackManager,
  Position,
  TrackableDisplayDimensions,
  TrackableRelativeDisplayScales,
  VelocityBoundaryBehavior,
  WatchableDisplayDimensionRenderInfo,
} from "#src/navigation_state.js";
import { WatchableValue } from "#src/trackable_value.js";
import { vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";

// Stable per-name dimension ids, so that a space listing the same dimensions in
// a different order still refers to the same dimensions.
const dimensionIds: { [name: string]: number } = {
  x: 1,
  y: 2,
  z: 3,
  c: 4,
  t: 5,
  u: 6,
  v: 7,
  w: 8,
};

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
// The same dimensions in the same order over a larger extent, as happens when a
// second layer widens the combined coordinate space.  Its centre differs from
// `xyzSpace`'s, so a position inferred for `xyzSpace` and carried over is no
// longer the centre of the bounds.
const xyzLargerSpace = makeSpace(
  ["x", "y", "z"],
  [4e-9, 4e-9, 4e-8],
  [500000, 240000, 10000],
);

// A higher-rank volume, e.g. spatial dimensions plus channel and time, to
// check that the bookkeeping does not depend on the typical rank of 3.
const highRankNames = ["x", "y", "z", "c", "t", "u", "v", "w"];
const highRankSpace = makeSpace(
  highRankNames,
  highRankNames.map(() => 1e-9),
  [10, 20, 30, 40, 50, 60, 70, 80],
);
const highRankLargerSpace = makeSpace(
  highRankNames,
  highRankNames.map(() => 1e-9),
  [20, 40, 60, 80, 100, 120, 140, 160],
);
const highRankCentre = [5.5, 10.5, 15.5, 20.5, 25.5, 30.5, 35.5, 40.5];
const highRankLargerCentre = [10.5, 20.5, 30.5, 40.5, 50.5, 60.5, 70.5, 80.5];

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

  it("keeps a position moved in place without a `markMoved` call", () => {
    // The navigation callers report their moves through `Position.markMoved`,
    // but a caller that does not is still detected, because the coordinates no
    // longer match the copy taken when they were inferred.  Such a position is
    // kept for the same reason an explicitly restored one is: it is a location
    // the user chose.  There is no previous valid coordinate space left to
    // match dimension ids against, so the coordinates carry over by index,
    // exactly as they do for a position restored from JSON.
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
    // Carrying over by index means a moved position can land outside the bounds
    // of a space whose dimensions are ordered differently: `z` ends up at
    // 125000.5 here, against an upper bound of 5000.  That behaviour predates
    // this change -- matching dimensions by id across the invalid gap would be
    // needed to fix it -- and is asserted only to pin what happens today.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;

    position.value[2] = 4000;
    position.changed.dispatch();

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxySpace;

    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 4000]);
    position.dispose();
  });

  it("keeps a position moved away and back by `addOffset`", () => {
    // A linked position is driven by `Position.addOffset`, which writes into the
    // target's live coordinate array.  Following a peer away and back must not
    // make the target count as inferred again.
    const source = newPosition();
    source.coordinateSpace.value = xyzSpace;
    source.position.restoreState([0, 0, 0]);

    const target = newPosition();
    target.coordinateSpace.value = xyzSpace;
    const inferred = Array.from(target.position.value);
    expect(inferred).toEqual([125000.5, 60000.5, 2500.5]);

    Position.addOffset(
      target.position,
      source.position,
      Float32Array.from(inferred),
    );
    expect(Array.from(target.position.value)).toEqual(inferred);

    // The peer moves, dragging the target with it, and then moves back.
    source.position.value = Float32Array.of(100, 0, 0);
    Position.addOffset(
      target.position,
      source.position,
      Float32Array.from(inferred),
    );
    expect(Array.from(target.position.value)).toEqual([
      125100.5, 60000.5, 2500.5,
    ]);
    source.position.value = Float32Array.of(0, 0, 0);
    Position.addOffset(
      target.position,
      source.position,
      Float32Array.from(inferred),
    );
    expect(Array.from(target.position.value)).toEqual(inferred);

    target.coordinateSpace.value = emptyInvalidCoordinateSpace;
    target.coordinateSpace.value = zxySpace;

    expect(Array.from(target.position.value)).toEqual(inferred);
    source.position.dispose();
    target.position.dispose();
  });

  it("keeps a position that `snapToVoxel` moved away and back", () => {
    // Snapping a position that is already on a voxel centre changes nothing, so
    // it stays inferred; snapping one that is not is a move.
    const { coordinateSpace, position } = newPosition();
    coordinateSpace.value = xyzSpace;
    const inferred = Array.from(position.value);

    position.snapToVoxel();
    expect(Array.from(position.value)).toEqual(inferred);

    // Move off the voxel centre in place, as the slice-view zoom does, and then
    // snap back onto the inferred coordinates.
    position.value[0] = 125000.2;
    position.changed.dispatch();
    position.snapToVoxel();
    expect(Array.from(position.value)).toEqual(inferred);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = zxySpace;

    expect(Array.from(position.value)).toEqual(inferred);
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

describe("Position moved through the navigation callers", () => {
  // `DisplayPose` moves the position by writing into the array returned by
  // `Position.value` and dispatching `changed` itself, rather than going
  // through the setter.  These tests drive those callers directly, so that the
  // bookkeeping which distinguishes an inferred position from one the user
  // chose is exercised the way it is in the application.
  function newPose() {
    const coordinateSpace = new WatchableValue<CoordinateSpace>(
      emptyInvalidCoordinateSpace,
    );
    const position = new Position(coordinateSpace);
    const pose = new DisplayPose(
      position,
      new WatchableDisplayDimensionRenderInfo(
        new TrackableRelativeDisplayScales(coordinateSpace),
        new TrackableDisplayDimensions(coordinateSpace),
      ),
      new OrientationState(),
    );
    return { coordinateSpace, position, pose };
  }

  it("keeps a position the user stepped away from and back to", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;
    coordinateSpace.value = xyzLargerSpace;

    // Carried over from `xyzSpace`, so no longer the centre of the bounds.
    const chosen = [125000.5, 60000.5, 2500.5];
    expect(Array.from(position.value)).toEqual(chosen);

    // The user steps a dimension away and back, landing on exactly the
    // coordinates that were inferred.
    pose.translateDimensionRelative(0, 100);
    expect(Array.from(position.value)).toEqual([125100.5, 60000.5, 2500.5]);
    pose.translateDimensionRelative(0, -100);
    expect(Array.from(position.value)).toEqual(chosen);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    // The position was chosen by the user, so it must not be recomputed as the
    // centre of the new bounds.
    expect(Array.from(position.value)).toEqual(chosen);
    pose.dispose();
  });

  it("keeps a position the user panned away from and back to", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;
    coordinateSpace.value = xyzLargerSpace;

    const chosen = [125000.5, 60000.5, 2500.5];
    pose.translateVoxelsRelative(vec3.fromValues(10, 0, 0));
    expect(Array.from(position.value)).toEqual([125010.5, 60000.5, 2500.5]);
    pose.translateVoxelsRelative(vec3.fromValues(-10, 0, 0));
    expect(Array.from(position.value)).toEqual(chosen);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual(chosen);
    pose.dispose();
  });

  it("does not count a step that rounds back onto the same voxel as a move", () => {
    // Arrow-key stepping rounds to the voxel centre, so a sub-voxel adjustment
    // leaves the coordinates untouched.  Nothing moved, so the position is
    // still the inferred one and must be recomputed for the new bounds.
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;
    coordinateSpace.value = xyzLargerSpace;
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    pose.translateDimensionRelative(0, 0.1);
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual([250000.5, 120000.5, 5000.5]);
    pose.dispose();
  });

  it("still re-infers a position the user never moved", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;
    coordinateSpace.value = xyzLargerSpace;
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    // Nothing moved the position, so it is recomputed for the new bounds.
    expect(Array.from(position.value)).toEqual([250000.5, 120000.5, 5000.5]);
    pose.dispose();
  });

  it("keeps a position that a clamped step moved to the boundary", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;

    // Stepping far past the upper bound clamps to the last voxel centre.
    pose.translateDimensionRelative(2, 1e9);
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 4999.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    // The clamped step still moved the position, so it is kept.
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 4999.5]);
    pose.dispose();
  });

  it("does not count a step clamped back onto the same voxel as a move", () => {
    // A space so shallow in `z` that the centre voxel is also the last one:
    // the clamp puts the stepped coordinate right back where it started.
    const shallowSpace = makeSpace(
      ["x", "y", "z"],
      [4e-9, 4e-9, 4e-8],
      [1000, 800, 2],
    );
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = shallowSpace;
    expect(Array.from(position.value)).toEqual([500.5, 400.5, 1.5]);

    pose.translateDimensionRelative(2, 5);
    expect(Array.from(position.value)).toEqual([500.5, 400.5, 1.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    // Nothing actually moved, so the position is recomputed for the new bounds.
    expect(Array.from(position.value)).toEqual([250000.5, 120000.5, 5000.5]);
    pose.dispose();
  });

  it("does not count a rotation about the current position as a move", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;
    const fixedPoint = Float32Array.from(position.value);

    pose.rotateAbsolute(vec3.fromValues(0, 0, 1), Math.PI / 2, fixedPoint);
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual([250000.5, 120000.5, 5000.5]);
    pose.dispose();
  });

  it("keeps a position rotated about another point", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;
    const fixedPoint = Float32Array.from(position.value);
    fixedPoint[0] += 10;

    // A half turn about `fixedPoint` reflects the position through it.
    pose.rotateAbsolute(vec3.fromValues(0, 0, 1), Math.PI, fixedPoint);
    expect(Array.from(position.value)).toEqual([125020.5, 60000.5, 2500.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzSpace;

    expect(Array.from(position.value)).toEqual([125020.5, 60000.5, 2500.5]);
    pose.dispose();
  });

  it("keeps a position moved away and back through updateDisplayPosition", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;

    expect(
      pose.updateDisplayPosition((pos) => {
        pos[0] += 10;
      }),
    ).toBe(true);
    expect(Array.from(position.value)).toEqual([125010.5, 60000.5, 2500.5]);
    expect(
      pose.updateDisplayPosition((pos) => {
        pos[0] -= 10;
      }),
    ).toBe(true);
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);
    pose.dispose();
  });

  it("does not count an updateDisplayPosition that changes nothing as a move", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;

    expect(pose.updateDisplayPosition(() => {})).toBe(true);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual([250000.5, 120000.5, 5000.5]);
    pose.dispose();
  });

  it("keeps a position after repeated away-and-back cycles", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = xyzSpace;

    for (let i = 0; i < 5; ++i) {
      pose.translateDimensionRelative(0, 100);
      pose.translateDimensionRelative(0, -100);
      pose.translateVoxelsRelative(vec3.fromValues(0, 7, 0));
      pose.translateVoxelsRelative(vec3.fromValues(0, -7, 0));
    }
    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);
    pose.dispose();
  });

  it("re-infers an untouched rank-8 position", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = highRankSpace;
    expect(Array.from(position.value)).toEqual(highRankCentre);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = highRankLargerSpace;

    expect(Array.from(position.value)).toEqual(highRankLargerCentre);
    pose.dispose();
  });

  it("keeps a rank-8 position stepped away and back on every dimension", () => {
    const { coordinateSpace, position, pose } = newPose();
    coordinateSpace.value = highRankSpace;

    // Many alternating steps across all dimensions, netting out to zero.
    for (let round = 0; round < 625; ++round) {
      for (let dim = 0; dim < 8; ++dim) {
        pose.translateDimensionRelative(dim, 1);
        pose.translateDimensionRelative(dim, -1);
      }
    }
    expect(Array.from(position.value)).toEqual(highRankCentre);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = highRankLargerSpace;

    expect(Array.from(position.value)).toEqual(highRankCentre);
    pose.dispose();
  });
});

describe("Position moved by playback", () => {
  function newPlayback() {
    const coordinateSpace = new WatchableValue<CoordinateSpace>(
      emptyInvalidCoordinateSpace,
    );
    const position = new Position(coordinateSpace);
    coordinateSpace.value = xyzSpace;
    const velocity = new CoordinateSpacePlaybackVelocity(coordinateSpace);
    const display = {
      updateStarted: new NullarySignal(),
      scheduleRedraw() {},
    };
    const playback = new PlaybackManager(display, position, velocity);
    return { coordinateSpace, position, velocity, display, playback };
  }

  it("keeps a position that playback moved", () => {
    vi.useFakeTimers();
    try {
      const { coordinateSpace, position, velocity, display, playback } =
        newPlayback();
      velocity.value = [
        undefined,
        undefined,
        {
          velocity: 1000,
          atBoundary: VelocityBoundaryBehavior.STOP,
          paused: false,
        },
      ];
      vi.advanceTimersByTime(500);
      display.updateStarted.dispatch();
      expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 3000.5]);

      coordinateSpace.value = emptyInvalidCoordinateSpace;
      coordinateSpace.value = xyzLargerSpace;

      // Playback moved the position, so it is kept.
      expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 3000.5]);
      playback.dispose();
      velocity.dispose();
      position.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count a playback tick too small to change the coordinate as a move", () => {
    vi.useFakeTimers();
    try {
      const { coordinateSpace, position, velocity, display, playback } =
        newPlayback();
      velocity.value = [
        undefined,
        undefined,
        {
          velocity: 1e-6,
          atBoundary: VelocityBoundaryBehavior.STOP,
          paused: false,
        },
      ];
      vi.advanceTimersByTime(1);
      display.updateStarted.dispatch();
      // The delta is far below Float32 precision at this coordinate, so the
      // stored value is unchanged even though a change was dispatched.
      expect(Array.from(position.value)).toEqual([125000.5, 60000.5, 2500.5]);

      coordinateSpace.value = emptyInvalidCoordinateSpace;
      coordinateSpace.value = xyzLargerSpace;

      expect(Array.from(position.value)).toEqual([250000.5, 120000.5, 5000.5]);
      playback.dispose();
      velocity.dispose();
      position.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Position synchronised by addOffset", () => {
  it("does not count a sync that recomputes the same coordinates as a move", () => {
    const coordinateSpace = new WatchableValue<CoordinateSpace>(
      emptyInvalidCoordinateSpace,
    );
    const source = new Position(coordinateSpace);
    const target = new Position(coordinateSpace);
    coordinateSpace.value = xyzSpace;
    const offset = Position.getOffset(target, source);

    Position.addOffset(target, source, offset);
    expect(Array.from(target.value)).toEqual([125000.5, 60000.5, 2500.5]);

    coordinateSpace.value = emptyInvalidCoordinateSpace;
    coordinateSpace.value = xyzLargerSpace;

    // The sync rewrote identical coordinates, so the position is still the
    // inferred one and is recomputed for the new bounds.
    expect(Array.from(target.value)).toEqual([250000.5, 120000.5, 5000.5]);
    source.dispose();
    target.dispose();
  });
});
