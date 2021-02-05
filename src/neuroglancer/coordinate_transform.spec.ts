/**
 * @license
 * Copyright 2019 Google Inc.
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

import {transformedBoundingBoxesEqual, CoordinateSpaceCombiner, coordinateSpacesEqual, emptyInvalidCoordinateSpace, homogeneousTransformSubmatrix, makeCoordinateSpace, makeIdentityTransform, newDimensionId, TransformedBoundingBox, WatchableCoordinateSpaceTransform, coordinateTransformSpecificationFromJson} from 'neuroglancer/coordinate_transform';
import {WatchableValue} from 'neuroglancer/trackable_value';

describe('newDimensionId', () => {
  it('returns unique values', () => {
    const a = newDimensionId();
    const b = newDimensionId();
    const c = newDimensionId();
    expect(a === b).toBeFalsy();
    expect(a === c).toBeFalsy();
    expect(b === c).toBeFalsy();
  });
});

describe('boundingBoxesEqual', () => {
  it('works for simple examples', () => {
    const boxes: TransformedBoundingBox[] = [
      {
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        box: {lowerBounds: Float64Array.of(11, 12), upperBounds: Float64Array.of(13, 14)},
      },
      {
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 10),
        box: {lowerBounds: Float64Array.of(11, 12), upperBounds: Float64Array.of(13, 14)},
      },
      {
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        box: {lowerBounds: Float64Array.of(11, 13), upperBounds: Float64Array.of(13, 14)},
      },
      {
        transform: Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        box: {lowerBounds: Float64Array.of(11, 12), upperBounds: Float64Array.of(13, 15)},
      }
    ];

    boxes.forEach((x, xIndex) => {
      boxes.forEach((y, yIndex) => {
        expect(transformedBoundingBoxesEqual(x, y))
            .toBe(
                x === y,
                `${xIndex}: ${JSON.stringify(x)}, ` +
                    `${yIndex}: ${JSON.stringify(y)}`);
      });
    });
  });
});

describe('emptyCoordinateSpace', () => {
  it('has expected value', () => {
    expect(emptyInvalidCoordinateSpace.rank).toEqual(0);
    expect(emptyInvalidCoordinateSpace.valid).toEqual(false);
    expect(emptyInvalidCoordinateSpace.scales).toEqual(new Float64Array(0));
    expect(emptyInvalidCoordinateSpace.units).toEqual([]);
    expect(emptyInvalidCoordinateSpace.ids).toEqual([]);
    expect(emptyInvalidCoordinateSpace.names).toEqual([]);
    expect(emptyInvalidCoordinateSpace.timestamps).toEqual([]);
    expect(emptyInvalidCoordinateSpace.boundingBoxes).toEqual([]);
    expect(emptyInvalidCoordinateSpace.bounds)
        .toEqual({lowerBounds: new Float64Array(0), upperBounds: new Float64Array(0)});
  });
});

describe('CoordinateSpaceCombiner', () => {
  it('supports retain', () => {
    const initialSpace = makeCoordinateSpace({
      valid: false,
      names: ['a', 'b', 'c'],
      scales: Float64Array.of(1, 2, 3),
      units: ['m', 'm', 'm'],
    });

    const otherSpace = makeCoordinateSpace({
      valid: true,
      names: ['d', 'a'],
      scales: Float64Array.of(4, 5),
      units: ['s', 's'],
    });

    const space = new WatchableValue(initialSpace);
    const combiner = new CoordinateSpaceCombiner(space, () => true);
    const retainer = combiner.retain();
    expect(coordinateSpacesEqual(initialSpace, combiner.combined.value)).toBeTruthy();
    const binding = combiner.bind(new WatchableValue(otherSpace));
    expect(combiner.combined.value.names).toEqual(['a', 'b', 'c', 'd']);
    expect(combiner.combined.value.scales).toEqual(Float64Array.of(1, 2, 3, 4));
    expect(combiner.combined.value.units).toEqual(['m', 'm', 'm', 's']);
    expect(combiner.dimensionRefCounts).toEqual(new Map([['a', 1], ['d', 1]]));
    expect(combiner.combined.value.valid).toBeTruthy();
    retainer();
    expect(combiner.combined.value.names).toEqual(['a', 'd']);
    expect(combiner.combined.value.scales).toEqual(Float64Array.of(1, 4));
    expect(combiner.combined.value.units).toEqual(['m', 's']);
    expect(combiner.combined.value.valid).toBeTruthy();
    binding();
    expect(coordinateSpacesEqual(emptyInvalidCoordinateSpace, combiner.combined.value))
        .toBeTruthy(combiner.combined.value);
  });

  it('handle renames', () => {
    const aSpace = makeCoordinateSpace({
      valid: true,
      names: ['a', 'b'],
      ids: [1, 2],
      scales: Float64Array.of(4, 5),
      units: ['s', 's'],
    });

    const bSpace = makeCoordinateSpace({
      valid: true,
      names: ['a', 'c'],
      ids: [1, 2],
      scales: Float64Array.of(5, 6),
      units: ['m', 'm'],
    });

    const a = new WatchableValue(aSpace);
    const b = new WatchableValue(bSpace);
    const combiner =
        new CoordinateSpaceCombiner(new WatchableValue(emptyInvalidCoordinateSpace), () => true);
    combiner.bind(a);
    combiner.bind(b);
    expect(combiner.combined.value.names).toEqual(['a', 'b', 'c']);
    expect(combiner.combined.value.scales).toEqual(Float64Array.of(4, 5, 6));
    expect(combiner.combined.value.units).toEqual(['s', 's', 'm']);
    expect(combiner.dimensionRefCounts).toEqual(new Map([['a', 2], ['b', 1], ['c', 1]]));
    expect(combiner.combined.value.valid).toBeTruthy();

    a.value = makeCoordinateSpace({
      valid: true,
      names: ['b', 'd'],
      ids: [2, 1],
      scales: Float64Array.of(5, 7),
      units: ['s', 's'],
      timestamps: [Number.NEGATIVE_INFINITY, Date.now()],
    });

    expect(combiner.combined.value.names).toEqual(['d', 'b', 'c']);
    expect(combiner.combined.value.scales).toEqual(Float64Array.of(7, 5, 6));
    expect(combiner.combined.value.units).toEqual(['s', 's', 'm']);
    expect(combiner.dimensionRefCounts).toEqual(new Map([['d', 2], ['b', 1], ['c', 1]]));
    expect(combiner.combined.value.valid).toBeTruthy();

    expect(a.value.names).toEqual(['b', 'd']);
    expect(a.value.scales).toEqual(Float64Array.of(5, 7));
    expect(b.value.names).toEqual(['d', 'c']);
    expect(b.value.scales).toEqual(Float64Array.of(7, 6));
  });
});

describe('getOutputSpaceWithTransformedBoundingBoxes', () => {
  it('works for identity transform', () => {
    const inputSpace = makeCoordinateSpace({
      scales: Float64Array.of(4, 9, 35),
      units: ['m', 'm', 'm'],
      names: ['x', 'y', 'z'],
      boundingBoxes: [{
        box: {lowerBounds: Float64Array.of(1, 2), upperBounds: Float64Array.of(5, 10)},
        transform: Float64Array.from([
          6, 7, 8,     //
          9, 10, 11,   //
          12, 13, 14,  //
        ]),
      }],
    });
    const outputSpace = makeCoordinateSpace({
      scales: Float64Array.of(2, 3, 7),
      units: ['m', 'm', 'm'],
      names: ['a', 'b', 'c'],
    });
    const watchableTransform =
        new WatchableCoordinateSpaceTransform(makeIdentityTransform(inputSpace));
    watchableTransform.outputSpace.value = outputSpace;
    expect(watchableTransform.value.outputSpace.boundingBoxes).toEqual([{
      box: {lowerBounds: Float64Array.of(1, 2), upperBounds: Float64Array.of(5, 10)},
      transform: Float64Array.from([
        6 * 2, 7 * 3, 8 * 5,     //
        9 * 2, 10 * 3, 11 * 5,   //
        12 * 2, 13 * 3, 14 * 5,  //
      ]),
    }]);
  });
});

describe('homogeneousTransformSubmatrix', () => {
  it('works for rank 2', () => {
    const orig = Float32Array.from([
      1, 2, 0,  //
      3, 4, 0,  //
      5, 6, 1
    ]);

    const permuted = homogeneousTransformSubmatrix(Float32Array, orig, 2, [0, 1], [0, 1]);

    expect(permuted).toEqual(orig);
  });

  it('works for rank 4', () => {
    const orig = Float32Array.from([
      1,  2,  3,  4,  0,  //
      3,  4,  5,  6,  0,  //
      7,  8,  9,  10, 0,  //
      11, 12, 13, 14, 0,  //
      15, 16, 17, 18, 1,  //
    ]);

    {
      const permuted =
          homogeneousTransformSubmatrix(Float32Array, orig, 4, [0, 1, 2, 3], [0, 1, 2, 3]);

      expect(permuted).toEqual(orig);
    }
    {
      const permuted =
          homogeneousTransformSubmatrix(Float32Array, orig, 4, [0, 1, 2, 3], [3, 0, 1, 2]);

      const expected = Float32Array.from([
        11, 12, 13, 14, 0,  //
        1,  2,  3,  4,  0,  //
        3,  4,  5,  6,  0,  //
        7,  8,  9,  10, 0,  //
        15, 16, 17, 18, 1,  //
      ]);
      expect(permuted).toEqual(expected);
    }
  });
});

describe('WatchableCoordinateSpaceTransform.spec', () => {
  it('preserves coordinate arrays from input space with outputDimensions', () => {
    const inputSpace = makeCoordinateSpace({
      names: ['a', 'b'],
      scales: Float64Array.of(1, 1),
      units: ['', ''],
      coordinateArrays: [{explicit: false, coordinates: [0], labels: ['x']}, undefined],
    });
    const watchableTransform =
      new WatchableCoordinateSpaceTransform(makeIdentityTransform(inputSpace));
    watchableTransform.spec = coordinateTransformSpecificationFromJson({'outputDimensions': {
      'a': [1, ''],
      'b': [1, ''],
    }});
    expect(watchableTransform.value.inputSpace.coordinateArrays).toEqual(inputSpace.coordinateArrays);
    expect(watchableTransform.value.outputSpace.coordinateArrays).toEqual(inputSpace.coordinateArrays);
  });
  it('preserves coordinate arrays from input space with inputDimensions', () => {
    const inputSpace = makeCoordinateSpace({
      names: ['a', 'b'],
      scales: Float64Array.of(1, 1),
      units: ['', ''],
      coordinateArrays: [{explicit: false, coordinates: [0], labels: ['x']}, undefined],
    });
    const watchableTransform =
        new WatchableCoordinateSpaceTransform(makeIdentityTransform(inputSpace));
    watchableTransform.spec = coordinateTransformSpecificationFromJson({
      'inputDimensions': {
        'a': [1, ''],
        'b': [1, ''],
      },
      'outputDimensions': {
        'a': [1, ''],
        'b': [1, ''],
      }
    });
    expect(watchableTransform.value.inputSpace.coordinateArrays)
        .toEqual(inputSpace.coordinateArrays);
    expect(watchableTransform.value.outputSpace.coordinateArrays)
        .toEqual(inputSpace.coordinateArrays);
  });
});
