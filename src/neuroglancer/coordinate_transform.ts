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

import {WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual, arraysEqualWithPredicate, getInsertPermutation, TypedArray} from 'neuroglancer/util/array';
import {getDependentTransformInputDimensions, mat4, quat, vec3} from 'neuroglancer/util/geom';
import {expectArray, parseArray, parseFiniteVec, parseFixedLengthArray, verifyFiniteFloat, verifyFinitePositiveFloat, verifyIntegerArray, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {scaleByExp10, supportedUnits, unitFromJson} from 'neuroglancer/util/si_units';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import * as vector from 'neuroglancer/util/vector';

export type DimensionId = number;

let nextDimensionId = 0;

export function newDimensionId(): DimensionId {
  return ++nextDimensionId;
}

export interface CoordinateArray {
  // Indicates whether this coordinate array was specified explicitly, in which case it will be
  // encoded in the JSON representation.
  explicit: boolean;
  // Specifies the coordinates.  Must be montonically increasing integers.
  coordinates: number[];
  // Specifies the label for each coordinate in `coordinates`.
  labels: string[];
}

export interface CoordinateSpace {
  /**
   * If `true`, has been fully initialized (i.e. based on at least one data source).  If `false`,
   * may be partially initialized.
   */
  readonly valid: boolean;

  readonly rank: number;

  /**
   * Specifies the name of each dimension.
   */
  readonly names: readonly string[];

  readonly ids: readonly DimensionId[];

  /**
   * Timestamp of last user action that changed the name, scale, or unit of each dimension, or
   * `undefined` if there was no user action.
   */
  readonly timestamps: readonly number[];

  /**
   * Specifies the physical units corresponding to this dimension.  May be empty to indicate
   * unitless.
   */
  readonly units: readonly string[];

  /**
   * Specifies a scale for this dimension.
   */
  readonly scales: Float64Array;

  readonly bounds: BoundingBox;
  readonly boundingBoxes: readonly TransformedBoundingBox[];

  readonly coordinateArrays: (CoordinateArray|undefined)[];
}

export function boundingBoxesEqual(a: BoundingBox, b: BoundingBox) {
  return arraysEqual(a.lowerBounds, b.lowerBounds) && arraysEqual(a.upperBounds, b.upperBounds);
}

export function coordinateArraysEqual(a: CoordinateArray|undefined, b: CoordinateArray|undefined) {
  if (a === undefined) return b === undefined;
  if (b === undefined) return false;
  return a.explicit === b.explicit && arraysEqual(a.coordinates, b.coordinates) &&
      arraysEqual(a.labels, b.labels);
}

export function normalizeCoordinateArray(coordinates: number[], labels: string[]) {
  const map = new Map<number, string>();
  for (let i = 0, length = coordinates.length; i < length; ++i) {
    map.set(coordinates[i], labels[i]);
  }
  coordinates = Array.from(map.keys());
  coordinates.sort((a, b) => a - b);
  labels = Array.from(coordinates, x => map.get(x)!);
  return {coordinates, labels};
}

export function mergeCoordinateArrays(coordinateArrays: ReadonlyArray<CoordinateArray>):
    CoordinateArray {
  if (coordinateArrays.length === 1) return coordinateArrays[0];
  const map = new Map<number, string>();
  let explicit = false;
  for (const x of coordinateArrays) {
    if (x.explicit) explicit = true;
    const {coordinates, labels} = x;
    for (let i = 0, length = coordinates.length; i < length; ++i) {
      map.set(coordinates[i], labels[i]);
    }
  }
  const coordinates = Array.from(map.keys());
  coordinates.sort((a, b) => a - b);
  const labels = Array.from(coordinates, x => map.get(x)!);
  return {explicit, coordinates, labels};
}

export function mergeOptionalCoordinateArrays(
    coordinateArrays: ReadonlyArray<CoordinateArray|undefined>): CoordinateArray|undefined {
  coordinateArrays = coordinateArrays.filter(x => x !== undefined);
  if (coordinateArrays.length === 0) return undefined;
  return mergeCoordinateArrays(coordinateArrays as ReadonlyArray<CoordinateArray>);
}

export function transformedBoundingBoxesEqual(
    a: TransformedBoundingBox, b: TransformedBoundingBox) {
  return arraysEqual(a.transform, b.transform) && boundingBoxesEqual(a.box, b.box);
}

export function coordinateSpacesEqual(a: CoordinateSpace, b: CoordinateSpace) {
  return (
      a.valid === b.valid && a.rank === b.rank && arraysEqual(a.names, b.names) &&
      arraysEqual(a.ids, b.ids) && arraysEqual(a.timestamps, b.timestamps) &&
      arraysEqual(a.units, b.units) && arraysEqual(a.scales, b.scales) &&
      arraysEqualWithPredicate(a.boundingBoxes, b.boundingBoxes, transformedBoundingBoxesEqual) &&
      arraysEqualWithPredicate(a.coordinateArrays, b.coordinateArrays, coordinateArraysEqual));
}

export function unitsFromJson(units: string[], scaleExponents: Float64Array, obj: any) {
  parseFixedLengthArray(units, obj, (x: any, index: number) => {
    const result = unitFromJson(x);
    scaleExponents[index] = result.exponent;
    return result.unit;
  });
}

export function makeCoordinateSpace(space: {
  readonly valid?: boolean,
  readonly names: readonly string[],
  readonly units: readonly string[],
  readonly scales: Float64Array,
  readonly rank?: number,
  readonly timestamps?: readonly number[],
  readonly ids?: readonly DimensionId[],
  readonly boundingBoxes?: readonly TransformedBoundingBox[],
  readonly bounds?: BoundingBox,
  readonly coordinateArrays?: (CoordinateArray|undefined)[],
}): CoordinateSpace {
  const {names, units, scales} = space;
  const {
    valid = true,
    rank = names.length,
    timestamps = names.map(() => Number.NEGATIVE_INFINITY),
    ids = names.map((_, i) => -i),
    boundingBoxes = [],
  } = space;
  const {coordinateArrays = new Array<CoordinateArray|undefined>(rank)} = space;
  const {bounds = computeCombinedBounds(boundingBoxes, rank)} = space;
  return {
    valid,
    rank,
    names,
    timestamps,
    ids,
    units,
    scales,
    boundingBoxes,
    bounds,
    coordinateArrays
  };
}

export const emptyInvalidCoordinateSpace = makeCoordinateSpace({
  valid: false,
  names: [],
  units: [],
  scales: vector.kEmptyFloat64Vec,
  boundingBoxes: [],
});

export const emptyValidCoordinateSpace = makeCoordinateSpace({
  valid: true,
  names: [],
  units: [],
  scales: vector.kEmptyFloat64Vec,
  boundingBoxes: [],
});

function unitAndScaleFromJson(obj: unknown) {
  const [scaleObj, unitObj] = expectArray(obj, 2);
  const scale = verifyFinitePositiveFloat(scaleObj);
  const unitString = verifyString(unitObj);
  const result = supportedUnits.get(unitString);
  if (result === undefined) throw new Error(`Invalid unit: ${JSON.stringify(unitString)}`);
  return {unit: result.unit, scale: scaleByExp10(scale, result.exponent)};
}

export function coordinateSpaceFromJson(
    obj: any, allowNumericalDimensions = false): CoordinateSpace {
  if (obj === undefined) return emptyInvalidCoordinateSpace;
  verifyObject(obj);
  const names = dimensionNamesFromJson(Object.keys(obj), allowNumericalDimensions);
  const rank = names.length;
  const units = new Array<string>(rank);
  const scales = new Float64Array(rank);
  const coordinateArrays = new Array<CoordinateArray|undefined>(rank);
  for (let i = 0; i < rank; ++i) {
    verifyObjectProperty(obj, names[i], mem => {
      if (Array.isArray(mem)) {
        // Normal unit-scale dimension.
        const {unit, scale} = unitAndScaleFromJson(mem);
        units[i] = unit;
        scales[i] = scale;
      } else {
        // Coordinate array dimension.
        verifyObject(mem);
        let coordinates = verifyObjectProperty(mem, 'coordinates', verifyIntegerArray);
        let labels = verifyObjectProperty(mem, 'labels', verifyStringArray);
        let length = coordinates.length;
        if (length !== labels.length) {
          throw new Error(
              `Length of coordinates array (${length}) ` +
              `does not match length of labels array (${labels.length})`);
        }
        units[i] = '';
        scales[i] = 1;
        coordinateArrays[i] = {explicit: true, ...normalizeCoordinateArray(coordinates, labels)};
      }
    });
  }
  return makeCoordinateSpace({valid: false, names, units, scales, coordinateArrays});
}

export function coordinateSpaceToJson(coordinateSpace: CoordinateSpace): any {
  const {rank} = coordinateSpace;
  if (rank === 0) return undefined;
  const {names, units, scales, coordinateArrays} = coordinateSpace;
  const json: any = {};
  for (let i = 0; i < rank; ++i) {
    const name = names[i];
    const coordinateArray = coordinateArrays[i];
    if (coordinateArray?.explicit) {
      json[name] = {
        coordinates: Array.from(coordinateArray.coordinates),
        labels: coordinateArray.labels
      };
    } else {
      json[name] = [scales[i], units[i]];
    }
  }
  return json;
}

export class TrackableCoordinateSpace extends WatchableValue<CoordinateSpace> {
  constructor() {
    super(emptyInvalidCoordinateSpace);
  }

  toJSON() {
    return coordinateSpaceToJson(this.value);
  }
  reset() {
    this.value = emptyInvalidCoordinateSpace;
  }
  restoreState(obj: any) {
    this.value = coordinateSpaceFromJson(obj);
  }
}

export interface BoundingBox {
  lowerBounds: Float64Array;
  upperBounds: Float64Array;
}

export function getCenterBound(lower: number, upper: number) {
  let x = (lower + upper) / 2;
  if (!Number.isFinite(x)) x = Math.min(Math.max(0, lower), upper);
  return x;
}

export function getBoundingBoxCenter(out: Float32Array, bounds: BoundingBox): Float32Array {
  const {lowerBounds, upperBounds} = bounds;
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = getCenterBound(lowerBounds[i], upperBounds[i]);
  }
  return out;
}

export interface TransformedBoundingBox {
  box: BoundingBox;

  /**
   * Transform from "box" coordinate space to target coordinate space.
   */
  transform: Float64Array;
}

export function makeIdentityTransformedBoundingBox(box: BoundingBox) {
  const rank = box.lowerBounds.length;
  return {box, transform: matrix.createIdentity(Float64Array, rank, rank + 1)};
}

export function computeCombinedLowerUpperBound(
    boundingBox: TransformedBoundingBox, outputDimension: number,
    outputRank: number): {lower: number, upper: number}|undefined {
  const {
    box: {lowerBounds: baseLowerBounds, upperBounds: baseUpperBounds},
    transform,
  } = boundingBox;
  const inputRank = baseLowerBounds.length;
  const stride = outputRank;
  const offset = transform[stride * inputRank + outputDimension];
  let targetLower = offset, targetUpper = offset;
  let hasCoefficient = false;
  for (let inputDim = 0; inputDim < inputRank; ++inputDim) {
    let c = transform[stride * inputDim + outputDimension];
    if (c === 0) continue;
    const lower = c * baseLowerBounds[inputDim];
    const upper = c * baseUpperBounds[inputDim];
    targetLower += Math.min(lower, upper);
    targetUpper += Math.max(lower, upper);
    hasCoefficient = true;
  }
  if (!hasCoefficient) return undefined;
  return {lower: targetLower, upper: targetUpper};
}

export function computeCombinedBounds(
    boundingBoxes: readonly TransformedBoundingBox[], outputRank: number): BoundingBox {
  const lowerBounds = new Float64Array(outputRank);
  const upperBounds = new Float64Array(outputRank);
  lowerBounds.fill(Number.NEGATIVE_INFINITY);
  upperBounds.fill(Number.POSITIVE_INFINITY);
  for (const boundingBox of boundingBoxes) {
    for (let outputDim = 0; outputDim < outputRank; ++outputDim) {
      const result = computeCombinedLowerUpperBound(boundingBox, outputDim, outputRank);
      if (result === undefined) continue;
      const {lower: targetLower, upper: targetUpper} = result;
      lowerBounds[outputDim] = lowerBounds[outputDim] === Number.NEGATIVE_INFINITY ?
          targetLower :
          Math.min(lowerBounds[outputDim], targetLower);
      upperBounds[outputDim] = upperBounds[outputDim] === Number.POSITIVE_INFINITY ?
          targetUpper :
          Math.max(upperBounds[outputDim], targetUpper);
    }
  }
  return {lowerBounds, upperBounds};
}

export function extendTransformedBoundingBox(
    boundingBox: TransformedBoundingBox, newOutputRank: number,
    newOutputDims: readonly number[]): TransformedBoundingBox {
  const {transform: oldTransform, box} = boundingBox;
  const oldOutputRank = newOutputDims.length;
  const inputRank = box.lowerBounds.length;
  const newTransform = new Float64Array((inputRank + 1) * newOutputRank);
  for (let oldOutputDim = 0; oldOutputDim < oldOutputRank; ++oldOutputDim) {
    const newOutputDim = newOutputDims[oldOutputDim];
    if (newOutputDim === -1) continue;
    for (let inputDim = 0; inputDim <= inputRank; ++inputDim) {
      newTransform[inputDim * newOutputRank + newOutputDim] =
          oldTransform[inputDim * oldOutputRank + oldOutputDim];
    }
  }
  return {
    transform: newTransform,
    box,
  };
}

export function makeSingletonDimTransformedBoundingBox(outputRank: number, outputDim: number) {
  const box = {lowerBounds: Float64Array.of(0), upperBounds: Float64Array.of(1)};
  const transform = new Float64Array(2 * outputRank);
  transform[outputDim] = 1;
  return {transform, box};
}

export function extendTransformedBoundingBoxUpToRank(
    boundingBox: TransformedBoundingBox, oldOutputRank: number,
    newOutputRank: number): TransformedBoundingBox {
  if (oldOutputRank === newOutputRank) return boundingBox;
  const {box} = boundingBox;
  const inputRank = box.lowerBounds.length;
  const transform = new Float64Array((inputRank + 1) * newOutputRank);
  matrix.copy(
      transform, newOutputRank, boundingBox.transform, oldOutputRank, oldOutputRank, inputRank + 1);
  return {box, transform};
}

export interface CoordinateSpaceTransform {
  /**
   * Equal to `outputSpace.rank`.
   */
  readonly rank: number;

  /**
   * The source rank, which is <= rank.  Input dimensions >= sourceRank are synthetic and serve only
   * to embed the source data in a larger view space.
   */
  readonly sourceRank: number;

  /**
   * May have rank less than `outputSpace.rank`, in which case additional unnamed dimensions with
   * range `[0, 1)` are implicitly added.
   */
  readonly inputSpace: CoordinateSpace;

  readonly outputSpace: CoordinateSpace;

  /**
   * `(rank + 1) * (rank + 1)` homogeneous column-major transformation matrix, where columns
   * correspond to input dimensions and rows correspond to output dimensions.
   */
  readonly transform: Float64Array;
}

export function coordinateSpaceTransformsEquivalent(
    defaultTransform: CoordinateSpaceTransform, transform: CoordinateSpaceTransform) {
  const {rank, sourceRank} = defaultTransform;
  if (rank !== transform.rank || sourceRank !== transform.sourceRank) return false;
  const {inputSpace: defaultInputSpace} = defaultTransform;
  const {inputSpace} = transform;
  if (!arraysEqual(inputSpace.scales, defaultInputSpace.scales) ||
      !arraysEqual(inputSpace.units, defaultInputSpace.units) ||
      !arraysEqual(transform.outputSpace.names, defaultTransform.outputSpace.names)) {
    return false;
  }
  return isTransformDerivableFromDefault(
      defaultTransform.transform, rank, defaultTransform.outputSpace.scales, transform.transform,
      rank, transform.outputSpace.scales);
}

export function makeIdentityTransform(inputSpace: CoordinateSpace): CoordinateSpaceTransform {
  return {
    rank: inputSpace.rank,
    sourceRank: inputSpace.rank,
    inputSpace,
    outputSpace: inputSpace,
    transform: matrix.createIdentity(Float64Array, inputSpace.rank + 1),
  };
}

function transformBoundingBox(
    boundingBox: TransformedBoundingBox, transform: Float64Array, sourceScales: Float64Array,
    targetScales: Float64Array): TransformedBoundingBox {
  let {transform: oldBoxTransform, box} = boundingBox;
  const inputRank = boundingBox.box.lowerBounds.length;
  const targetRank = targetScales.length;
  // transform is a column-major homogeneous `(rows=targetRank+1, cols=targetRank+1)` matrix.
  // oldBoxTransform is a column-major `(rows=targetRank, cols=inputRank+1)` matrix.
  // newBoxTransform is a column-major `(rows=targetRank, cols=inputRank+1)` matrix.
  const newBoxTransform = new Float64Array((inputRank + 1) * targetRank);
  for (let targetDim = 0; targetDim < targetRank; ++targetDim) {
    const targetScale = targetScales[targetDim];
    // Compute the rotation/scaling components
    for (let inputDim = 0; inputDim < inputRank; ++inputDim) {
      let sum = 0;
      for (let sourceDim = 0; sourceDim < targetRank; ++sourceDim) {
        const sourceScale = sourceScales[sourceDim];
        sum += transform[(targetRank + 1) * sourceDim + targetDim] *
            oldBoxTransform[targetRank * inputDim + sourceDim] * (sourceScale / targetScale);
      }
      newBoxTransform[targetRank * inputDim + targetDim] = sum;
    }
    // Compute the translation component
    let sum = transform[(targetRank + 1) * targetRank + targetDim];
    for (let sourceDim = 0; sourceDim < targetRank; ++sourceDim) {
      const sourceScale = sourceScales[sourceDim];
      sum += transform[(targetRank + 1) * sourceDim + targetDim] *
          oldBoxTransform[targetRank * inputRank + sourceDim] * (sourceScale / targetScale);
    }
    newBoxTransform[inputRank * targetRank + targetDim] = sum;
  }
  return {
    transform: newBoxTransform,
    box,
  };
}

function getTransformedBoundingBoxes(
    inputSpace: CoordinateSpace, transform: Float64Array, outputScales: Float64Array) {
  return inputSpace.boundingBoxes.map(
      boundingBox => transformBoundingBox(boundingBox, transform, inputSpace.scales, outputScales));
}

export function getOutputSpaceWithTransformedBoundingBoxes(
    inputSpace: CoordinateSpace, transform: Float64Array, oldOutputSpace: CoordinateSpace) {
  const newSpace = makeCoordinateSpace({
    valid: inputSpace.valid,
    rank: oldOutputSpace.rank,
    ids: oldOutputSpace.ids,
    names: oldOutputSpace.names,
    timestamps: oldOutputSpace.timestamps,
    scales: oldOutputSpace.scales,
    units: oldOutputSpace.units,
    boundingBoxes: getTransformedBoundingBoxes(inputSpace, transform, oldOutputSpace.scales),
    coordinateArrays: oldOutputSpace.coordinateArrays,
  });
  if (coordinateSpacesEqual(newSpace, oldOutputSpace)) return oldOutputSpace;
  return newSpace;
}

export function isValidDimensionName(name: string, allowNumericalNames = false) {
  if (allowNumericalNames) {
    const n = Number(name);
    if (Number.isInteger(n) && n >= 0) return true;
  }
  return name.match(/^[a-zA-Z][a-zA-Z_0-9]*['^]?$/) !== null;
}

export function validateDimensionNames(names: string[], allowNumericalNames = false) {
  const seenNames = new Set<string>();
  for (const name of names) {
    if (!isValidDimensionName(name, allowNumericalNames)) return false;
    if (seenNames.has(name)) return false;
    seenNames.add(name);
  }
  return true;
}

export function getDimensionNameValidity(names: readonly string[]): boolean[] {
  const rank = names.length;
  const isValid = new Array<boolean>(rank);
  isValid.fill(true);
  for (let i = 0; i < rank; ++i) {
    const name = names[i];
    if (!isValidDimensionName(name)) {
      isValid[i] = false;
      continue;
    }
    const otherIndex = names.indexOf(name, i + 1);
    if (otherIndex !== -1) {
      isValid[i] = false;
      isValid[otherIndex] = false;
    }
  }
  return isValid;
}

export function isLocalDimension(name: string) {
  return name.endsWith('\'');
}

export function isLocalOrChannelDimension(name: string) {
  return name.endsWith('\'') || name.endsWith('^');
}

export function isChannelDimension(name: string) {
  return name.endsWith('^');
}

export function isGlobalDimension(name: string) {
  return !isLocalOrChannelDimension(name);
}

export function convertTransformOutputScales(
    existingTransform: Float64Array, existingOutputScales: Float64Array,
    newOutputScales: Float64Array) {
  const newTransform = new Float64Array(existingTransform);
  const rank = existingOutputScales.length;
  const baseIndex = (rank + 1) * rank;
  for (let i = 0; i < rank; ++i) {
    newTransform[baseIndex + i] *= (existingOutputScales[i] / newOutputScales[i]);
  }
  return newTransform;
}

function isTransformDerivableFromDefault(
    defaultTransform: Float64Array, defaultRank: number, defaultOutputScales: Float64Array,
    newTransform: Float64Array, newRank: number, newOutputScales: Float64Array) {
  // Verify that matched linear portion is equal.
  if (!matrix.equal(
          defaultTransform, defaultRank + 1, newTransform, newRank + 1, defaultRank, defaultRank))
    return false;

  // Verify that common translation is equivalent.
  for (let i = 0; i < defaultRank; ++i) {
    const aValue = defaultTransform[(defaultRank + 1) * defaultRank + i];
    const bValue = newTransform[(newRank + 1) * newRank + i];
    if (aValue * (defaultOutputScales[i] / newOutputScales[i]) !== bValue) return false;
  }

  // Verify that extended translation is 0.
  for (let i = defaultRank; i < newRank; ++i) {
    if (newTransform[(newRank + 1) * newRank + i] !== 0) return false;
  }

  // Verify that extended linear portion is identity.
  for (let i = defaultRank; i < newRank; ++i) {
    for (let j = 0; j < defaultRank; ++j) {
      if (newTransform[(newRank + 1) * j + i] !== 0) return false;
    }
    for (let j = 0; j < newRank; ++j) {
      const coeff = newTransform[(newRank + 1) * i + j];
      if (i === j) {
        if (coeff !== 1) return false;
      } else {
        if (coeff !== 0) return false;
      }
    }
  }
  return true;
}

export function makeDimensionNameUnique(name: string, existingNames: readonly string[]) {
  if (!existingNames.includes(name)) return name;
  const [, prefix, suffix] = name.match(/^([^']*)('?)$/)!;
  for (let i = 0;; ++i) {
    const newName = `${prefix}${i}${suffix}`;
    if (!existingNames.includes(newName)) return newName;
  }
}

export function remapTransformInputSpace(
    old: CoordinateSpaceTransform, inputSpace: CoordinateSpace): CoordinateSpaceTransform {
  const {inputSpace: oldInputSpace, transform: oldTransform} = old;
  const {ids: oldInputDimensionIds, rank: oldRank} = oldInputSpace;
  const {
    rank: newRank,
    names: newInputDimensionNames,
    units: newInputUnits,
    scales: newInputScales
  } = inputSpace;
  const removedOldInputIndices = new Array(oldRank);
  removedOldInputIndices.fill(true);
  const addedInputDimensionIndices: number[] = [];
  const newToOldInputDimensionIndices: number[] = inputSpace.ids.map((id, i) => {
    const oldIndex = oldInputDimensionIds.indexOf(id);
    if (oldIndex !== -1) {
      removedOldInputIndices[oldIndex] = false;
    } else {
      addedInputDimensionIndices.push(i);
    }
    return oldIndex;
  });
  const {outputSpace: oldOutputSpace} = old;
  const {
    names: oldOutputDimensionNames,
    units: oldOutputUnits,
    scales: oldOutputScales,
    ids: oldOutputDimensionIds,
    timestamps: oldOutputTimestamps,
    coordinateArrays: oldOutputCoordinateArrays,
  } = oldOutputSpace;
  // For now just use a simple mapping.
  const removedOldOutputIndices = removedOldInputIndices;
  const outputDimensionNames: string[] = [];
  const outputUnits: string[] = [];
  const outputScales = new Float64Array(newRank);
  const outputDimensionIds: DimensionId[] = [];
  const outputDimensionTimestamps: number[] = [];
  const outputCoordinateArrays = new Array<CoordinateArray|undefined>(newRank);
  let newOutputDim = 0;
  const newTransform = new Float64Array((newRank + 1) ** 2);
  newTransform[newTransform.length - 1] = 1;
  for (let oldOutputDim = 0; oldOutputDim < oldRank; ++oldOutputDim) {
    if (removedOldOutputIndices[oldOutputDim]) continue;
    outputDimensionNames[newOutputDim] = oldOutputDimensionNames[oldOutputDim];
    outputDimensionIds[newOutputDim] = oldOutputDimensionIds[oldOutputDim];
    outputUnits[newOutputDim] = oldOutputUnits[oldOutputDim];
    outputScales[newOutputDim] = oldOutputScales[oldOutputDim];
    outputDimensionTimestamps[newOutputDim] = oldOutputTimestamps[oldOutputDim];
    outputCoordinateArrays[newOutputDim] = oldOutputCoordinateArrays[oldOutputDim];
    for (let newInputDim = 0; newInputDim < newRank; ++newInputDim) {
      const oldInputDim = newToOldInputDimensionIndices[newInputDim];
      if (oldInputDim === -1) continue;
      newTransform[newInputDim * (newRank + 1) + newOutputDim] =
          oldTransform[oldInputDim * (oldRank + 1) + oldOutputDim];
    }
    newTransform[newRank * (newRank + 1) + newOutputDim] =
        oldTransform[oldRank * (oldRank + 1) + oldOutputDim];
    ++newOutputDim;
  }
  for (const newInputDim of addedInputDimensionIndices) {
    outputDimensionIds[newOutputDim] = newDimensionId();
    outputDimensionNames[newOutputDim] =
        makeDimensionNameUnique(newInputDimensionNames[newInputDim], outputDimensionNames);
    outputScales[newOutputDim] = newInputScales[newInputDim];
    outputUnits[newOutputDim] = newInputUnits[newInputDim];
    newTransform[newInputDim * (newRank + 1) + newOutputDim] = 1;
    ++newOutputDim;
  }
  const outputSpace = makeCoordinateSpace({
    valid: inputSpace.valid,
    rank: newRank,
    names: outputDimensionNames,
    ids: outputDimensionIds,
    timestamps: outputDimensionTimestamps,
    units: outputUnits,
    scales: outputScales,
    boundingBoxes: getTransformedBoundingBoxes(inputSpace, newTransform, outputScales),
    coordinateArrays: outputCoordinateArrays,
  });
  return {
    rank: newRank,
    sourceRank: old.sourceRank,
    inputSpace,
    outputSpace,
    transform: newTransform
  };
}

function normalizeCoordinateSpaceTransform(value: CoordinateSpaceTransform) {
  const outputSpace = getOutputSpaceWithTransformedBoundingBoxes(
      value.inputSpace, value.transform, value.outputSpace);
  if (outputSpace === value.outputSpace) return value;
  return {
    rank: value.rank,
    sourceRank: value.sourceRank,
    inputSpace: value.inputSpace,
    transform: value.transform,
    outputSpace,
  };
}

export class WatchableCoordinateSpaceTransform implements
    Trackable, WatchableValueInterface<CoordinateSpaceTransform> {
  private value_: CoordinateSpaceTransform|undefined = undefined;
  readonly outputSpace: WatchableValueInterface<CoordinateSpace>;
  readonly inputSpace: WatchableValueInterface<CoordinateSpace>;
  changed = new NullarySignal();
  private inputSpaceChanged = new NullarySignal();
  readonly defaultTransform: CoordinateSpaceTransform;

  constructor(
      defaultTransform: CoordinateSpaceTransform,
      public readonly mutableSourceRank: boolean = false) {
    this.defaultTransform = normalizeCoordinateSpaceTransform(defaultTransform);
    const self = this;
    this.outputSpace = {
      changed: self.changed,
      get value() {
        return self.value.outputSpace;
      },
      set value(newOutputSpace: CoordinateSpace) {
        const {value} = self;
        if (coordinateSpacesEqual(value.outputSpace, newOutputSpace)) return;
        if (value.rank !== newOutputSpace.rank) return;
        const transform = convertTransformOutputScales(
            value.transform, value.outputSpace.scales, newOutputSpace.scales);
        self.value_ = {
          sourceRank: value.sourceRank,
          rank: value.rank,
          inputSpace: value.inputSpace,
          outputSpace: getOutputSpaceWithTransformedBoundingBoxes(
              value.inputSpace, transform, newOutputSpace),
          transform,
        };
        self.changed.dispatch();
      },
    };
    this.inputSpace = {
      changed: self.inputSpaceChanged,
      get value() {
        return self.value.inputSpace;
      },
      set value(newInputSpace: CoordinateSpace) {
        const {value} = self;
        if (coordinateSpacesEqual(value.inputSpace, newInputSpace)) return;
        self.value_ = remapTransformInputSpace(value, newInputSpace);
        self.inputSpaceChanged.dispatch();
        self.changed.dispatch();
      },
    };
  }

  set value(value: CoordinateSpaceTransform) {
    const existingValue = this.value;
    if (value === existingValue) return;
    this.value_ = normalizeCoordinateSpaceTransform(value);
    if (value.inputSpace !== existingValue.inputSpace) {
      this.inputSpaceChanged.dispatch();
    }
    this.changed.dispatch();
  }

  get value(): CoordinateSpaceTransform {
    let {value_: value} = this;
    if (value === undefined) {
      value = this.value_ = this.defaultTransform;
    }
    return value;
  }

  reset() {
    if (this.value_ === this.defaultTransform) return;
    this.value_ = this.defaultTransform;
    this.inputSpaceChanged.dispatch();
    this.changed.dispatch();
  }

  get defaultInputSpace() {
    return this.defaultTransform.inputSpace;
  }

  get spec(): Readonly<CoordinateTransformSpecification>|undefined {
    const {value} = this;
    const {rank, transform, inputSpace, outputSpace, sourceRank} = value;
    const {defaultTransform, mutableSourceRank} = this;
    const {
      inputSpace: defaultInputSpace,
      rank: defaultRank,
      transform: defaultTransformMatrix,
      outputSpace: defaultOutputSpace
    } = defaultTransform;
    const {units, scales} = inputSpace;
    const inputSpaceSame = sourceRank === rank &&
        arraysEqual(scales, mutableSourceRank ? outputSpace.scales : defaultInputSpace.scales) &&
        arraysEqual(units, mutableSourceRank ? outputSpace.units : defaultInputSpace.units);
    const transformSame = isTransformDerivableFromDefault(
        defaultTransformMatrix, defaultRank, defaultOutputSpace.scales, transform, rank,
        outputSpace.scales);
    const outputNamesSame = arraysEqual(defaultOutputSpace.names, outputSpace.names);
    if (transformSame && outputNamesSame && inputSpaceSame) {
      return undefined;
    }
    return {
      sourceRank,
      transform: transformSame ? undefined : transform,
      outputSpace: value.outputSpace,
      inputSpace: inputSpaceSame ? undefined : inputSpace,
    };
  }

  set transform(transform: Float64Array) {
    const {value} = this;
    const {inputSpace} = value;
    this.value_ = {
      rank: value.rank,
      sourceRank: value.sourceRank,
      inputSpace,
      transform,
      outputSpace:
          getOutputSpaceWithTransformedBoundingBoxes(inputSpace, transform, value.outputSpace),
    };
    this.changed.dispatch();
  }

  set spec(spec: Readonly<CoordinateTransformSpecification>|undefined) {
    if (spec === undefined) {
      this.reset();
      return;
    }
    if (this.mutableSourceRank) {
      const origInputSpace = spec.inputSpace || spec.outputSpace;
      const rank = origInputSpace.rank;
      const inputSpace = makeCoordinateSpace({
        rank,
        names: origInputSpace.names.map((_, i) => `${i}`),
        units: origInputSpace.units,
        scales: origInputSpace.scales,
        coordinateArrays: origInputSpace.coordinateArrays,
      });
      this.value = {
        rank,
        transform: spec.transform || matrix.createIdentity(Float64Array, rank + 1),
        sourceRank: spec.sourceRank,
        outputSpace: spec.outputSpace,
        inputSpace
      };
      return;
    }
    const {
      inputSpace: defaultInputSpace,
      sourceRank: defaultSourceRank,
      outputSpace: defaultOutputSpace,
      transform: defaultTransformMatrix,
      rank: defaultRank
    } = this.defaultTransform;
    const {
      inputSpace: specInputSpace,
      sourceRank: specSourceRank,
      outputSpace: specOutputSpace,
      transform: specTransformMatrix
    } = spec;
    const specRank = spec.outputSpace.rank;
    const defaultInputNames = defaultInputSpace.names;
    const specInputNames = specInputSpace !== undefined ? specInputSpace.names : defaultInputNames;
    const newToSpecDimensionIndices = new Array<number>(defaultSourceRank);
    for (let defaultDim = 0; defaultDim < defaultSourceRank; ++defaultDim) {
      let specDim = specInputNames.indexOf(defaultInputNames[defaultDim]);
      if (specDim >= specSourceRank) specDim = -1;
      newToSpecDimensionIndices[defaultDim] = specDim;
    }
    const newRank = (specRank - specSourceRank) + defaultSourceRank;
    for (let i = specSourceRank; i < specRank; ++i) {
      newToSpecDimensionIndices[defaultSourceRank + i - specSourceRank] = i;
    }
    const newInputScales = new Float64Array(newRank);
    const newInputCoordinateArrays = new Array<CoordinateArray|undefined>(newRank);
    const newInputUnits: string[] = [];
    for (let newDim = 0; newDim < defaultSourceRank; ++newDim) {
      const specDim = newToSpecDimensionIndices[newDim];
      if (specDim === -1 || specInputSpace === undefined) {
        newInputScales[newDim] = defaultInputSpace.scales[newDim];
        newInputUnits[newDim] = defaultInputSpace.units[newDim];
        newInputCoordinateArrays[newDim] = defaultInputSpace.coordinateArrays[newDim];
      } else {
        newInputScales[newDim] = specInputSpace.scales[specDim];
        newInputUnits[newDim] = specInputSpace.units[specDim];
        newInputCoordinateArrays[newDim] = mergeOptionalCoordinateArrays(
            [defaultInputSpace.coordinateArrays[newDim], specInputSpace.coordinateArrays[specDim]]);
      }
    }
    const specInputOrOutputSpace = specInputSpace || specOutputSpace;
    const newInputNames = defaultInputNames.slice(0, defaultSourceRank);
    const newOutputNames = defaultOutputSpace.names.slice(0, defaultSourceRank);
    const newOutputCoordinateArrays =
        defaultOutputSpace.coordinateArrays.slice(0, defaultSourceRank);
    const newOutputScales = new Float64Array(newRank);
    const newOutputUnits: string[] = [];
    for (let newDim = 0; newDim < newRank; ++newDim) {
      const specDim = newToSpecDimensionIndices[newDim];
      if (specDim === -1) {
        newOutputScales[newDim] = defaultOutputSpace.scales[newDim];
        newOutputUnits[newDim] = defaultOutputSpace.units[newDim];
        newOutputCoordinateArrays[newDim] = defaultOutputSpace.coordinateArrays[newDim];
      } else {
        newOutputNames[newDim] = specOutputSpace.names[specDim];
        newOutputUnits[newDim] = specOutputSpace.units[specDim];
        newOutputScales[newDim] = specOutputSpace.scales[specDim];
        newOutputCoordinateArrays[newDim] = specOutputSpace.coordinateArrays[specDim];
      }
    }
    if (!validateDimensionNames(newOutputNames)) {
      // Spec is incompatible, ignore it.
      this.reset();
      return;
    }
    // Handle singleton dimensions.
    for (let newDim = defaultSourceRank; newDim < newRank; ++newDim) {
      const specDim = (newDim - defaultSourceRank) + specSourceRank;
      newInputScales[newDim] = specInputOrOutputSpace.scales[specDim];
      newInputUnits[newDim] = specInputOrOutputSpace.units[specDim];
      newInputNames[newDim] = `${newDim}`;
    }

    const newTransform = new Float64Array((newRank + 1) ** 2);
    newTransform[newTransform.length - 1] = 1;
    for (let newRow = 0; newRow < newRank; ++newRow) {
      const specRow = newToSpecDimensionIndices[newRow];
      let value: number;
      if (specRow === -1 || specTransformMatrix === undefined) {
        if (newRow >= defaultSourceRank) {
          value = 0;
        } else {
          value = defaultTransformMatrix[defaultRank * (defaultRank + 1) + newRow] *
              (defaultOutputSpace.scales[newRow] / newOutputScales[newRow]);
        }
      } else {
        value = specTransformMatrix[specRank * (specRank + 1) + specRow];
      }
      newTransform[newRank * (newRank + 1) + newRow] = value;
      for (let newCol = 0; newCol < newRank; ++newCol) {
        const specCol = newToSpecDimensionIndices[newCol];
        let value: number;
        if ((specRow === -1) != (specCol === -1)) {
          value = 0;
        } else if (specRow === -1 || specTransformMatrix === undefined) {
          if (specRow >= defaultSourceRank || specCol >= defaultSourceRank) {
            value = specRow === specCol ? 1 : 0;
          } else {
            value = defaultTransformMatrix[newCol * (defaultRank + 1) + newRow];
          }
        } else {
          value = specTransformMatrix[specCol * (specRank + 1) + specRow];
        }
        newTransform[newCol * (newRank + 1) + newRow] = value;
      }
    }
    const boundingBoxes = defaultInputSpace.boundingBoxes.map(
        boundingBox => extendTransformedBoundingBoxUpToRank(boundingBox, defaultRank, newRank));
    for (let i = defaultSourceRank; i < newRank; ++i) {
      boundingBoxes.push(makeSingletonDimTransformedBoundingBox(newRank, i));
    }
    // Propagate coordinate arrays from input dimensions to output dimensions.
    for (let outputDim = 0; outputDim < newRank; ++outputDim) {
      // Check if this output dimension is identity mapped from a single input dimension.
      const translation = newTransform[newRank * (newRank + 1) + outputDim];
      if (translation !== 0) continue;
      let singleInputDim: number|undefined|null = undefined;
      for (let inputDim = 0; inputDim < newRank; ++inputDim) {
        const factor = newTransform[inputDim * (newRank + 1) + outputDim];
        if (factor === 0) continue;
        if (factor === 1) {
          if (singleInputDim === undefined) {
            // First input dimension that maps to this output dimension.
            singleInputDim = inputDim;
          } else {
            // Multiple input dimensions map to this output dimension.
            singleInputDim = null;
            break;
          }
        } else {
          // Non-identity mapping.
          singleInputDim = null;
          break;
        }
      }
      if (singleInputDim == null) continue;
      let coordinateArray = newInputCoordinateArrays[singleInputDim];
      if (coordinateArray === undefined) continue;
      if (coordinateArray.explicit) {
        coordinateArray = {...coordinateArray, explicit: false};
      }
      newOutputCoordinateArrays[outputDim] =
          mergeOptionalCoordinateArrays([coordinateArray, newOutputCoordinateArrays[outputDim]]);
    }
    this.value = {
      rank: newRank,
      transform: newTransform,
      sourceRank: defaultSourceRank,
      outputSpace: makeCoordinateSpace({
        rank: newRank,
        names: newOutputNames,
        scales: newOutputScales,
        units: newOutputUnits,
        coordinateArrays: newOutputCoordinateArrays,
      }),
      inputSpace: makeCoordinateSpace({
        rank: newRank,
        names: newInputNames,
        scales: newInputScales,
        units: newInputUnits,
        coordinateArrays: newInputCoordinateArrays,
        boundingBoxes,
      }),
    };
  }

  toJSON() {
    return coordinateTransformSpecificationToJson(this.spec);
  }

  restoreState(obj: unknown) {
    this.spec = coordinateTransformSpecificationFromJson(obj);
  }
}

export function expectDimensionName(obj: unknown, allowNumericalNames = false): string {
  const name = verifyString(obj);
  if (!isValidDimensionName(name, allowNumericalNames)) {
    throw new Error(`Invalid dimension name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function dimensionNamesFromJson(obj: any, allowNumericalNames = false) {
  const dimensions = parseArray(obj, x => expectDimensionName(x, allowNumericalNames));
  if (!validateDimensionNames(dimensions, allowNumericalNames)) {
    throw new Error(`Invalid dimensions: ${JSON.stringify(dimensions)}`);
  }
  return dimensions;
}

interface BoundCoordinateSpace {
  space: WatchableValueInterface<CoordinateSpace>;
  prevValue: CoordinateSpace|undefined;
  mappedDimensionIds: (DimensionId|undefined)[];
}

export class CoordinateSpaceCombiner {
  private bindings = new Set<BoundCoordinateSpace>();

  private retainCount = 0;

  private prevCombined: CoordinateSpace|undefined = this.combined.value;

  dimensionRefCounts = new Map<string, number>();

  getRenameValidity(newNames: readonly string[]): boolean[] {
    const existingNames = this.combined.value.names;
    const validity = getDimensionNameValidity(newNames);
    const rank = newNames.length;
    for (let i = 0; i < rank; ++i) {
      if (!validity[i]) continue;
      const newName = newNames[i];
      if (existingNames.includes(newName)) continue;
      let valid = true;
      for (const binding of this.bindings) {
        const otherNames = binding.space.value.names;
        if (otherNames.includes(newName)) {
          valid = false;
          break;
        }
      }
      validity[i] = valid;
    }
    return validity;
  }

  private includeDimensionPredicate_: (name: string) => boolean;

  get includeDimensionPredicate() {
    return this.includeDimensionPredicate_;
  }
  set includeDimensionPredicate(value: (name: string) => boolean) {
    this.includeDimensionPredicate_ = value;
    this.update();
  }

  constructor(
      public combined: WatchableValueInterface<CoordinateSpace>,
      includeDimensionPredicate: (name: string) => boolean) {
    this.includeDimensionPredicate_ = includeDimensionPredicate;
  }

  private update() {
    const {combined, bindings} = this;
    const retainExisting = this.retainCount > 0 ? 1 : 0;
    if (bindings.size === 0 && !retainExisting) {
      combined.value = emptyInvalidCoordinateSpace;
      return;
    }
    const include = this.includeDimensionPredicate_;
    const existing = combined.value;
    let mergedNames = Array.from(existing.names);
    let mergedUnits = Array.from(existing.units);
    let mergedScales = Array.from(existing.scales);
    let mergedIds = Array.from(existing.ids);
    let mergedTimestamps = Array.from(existing.timestamps);
    let dimensionRefs: number[] = existing.names.map(() => retainExisting ? 1 : 0);
    const bindingCombinedIndices: (number|undefined)[][] = [];
    let valid = false;
    for (const binding of bindings) {
      const {space: {value: space}, prevValue, mappedDimensionIds} = binding;
      valid = valid || space.valid;
      const {names, units, scales, ids, timestamps} = space;
      const newMappedDimensionIds: (DimensionId|undefined)[] = [];
      const combinedIndices: (number|undefined)[] = [];
      bindingCombinedIndices.push(combinedIndices);
      binding.mappedDimensionIds = newMappedDimensionIds;
      binding.prevValue = space;
      const rank = names.length;
      for (let i = 0; i < rank; ++i) {
        const name = names[i];
        if (!include(name)) continue;
        if (prevValue !== undefined) {
          const id = ids[i];
          const prevIndex = prevValue.ids.indexOf(id);
          if (prevIndex !== -1) {
            const combinedId = mappedDimensionIds[prevIndex];
            if (combinedId !== undefined) {
              const combinedIndex = mergedIds.indexOf(combinedId);
              if (combinedIndex !== -1) {
                newMappedDimensionIds[i] = combinedId;
                ++dimensionRefs[combinedIndex];
                combinedIndices[i] = combinedIndex;
                const timestamp = timestamps[i];
                if (timestamp !== undefined && !(timestamp <= mergedTimestamps[combinedIndex])) {
                  mergedNames[combinedIndex] = name;
                  mergedScales[combinedIndex] = scales[i];
                  mergedUnits[combinedIndex] = units[i];
                  mergedTimestamps[combinedIndex] = timestamp;
                }
                continue;
              }
            }
          }
        }
        let combinedIndex = mergedNames.indexOf(name);
        if (combinedIndex !== -1) {
          newMappedDimensionIds[i] = mergedIds[combinedIndex];
          ++dimensionRefs[combinedIndex];
          combinedIndices[i] = combinedIndex;
          continue;
        }
        combinedIndex = mergedNames.length;
        combinedIndices[i] = combinedIndex;
        dimensionRefs[combinedIndex] = 1 + retainExisting;
        mergedNames[combinedIndex] = name;
        mergedUnits[combinedIndex] = units[i];
        mergedScales[combinedIndex] = scales[i];
        mergedTimestamps[combinedIndex] = timestamps[i];
        const combinedId = newDimensionId();
        mergedIds[combinedIndex] = combinedId;
        newMappedDimensionIds[i] = combinedId;
      }
    }
    // Propagate names, units, and scales back
    const {dimensionRefCounts} = this;
    dimensionRefCounts.clear();
    let bindingIndex = 0;
    let newRank = mergedNames.length;
    for (const binding of bindings) {
      const {space: {value: space}} = binding;
      const combinedIndices = bindingCombinedIndices[bindingIndex++];
      const {rank} = space;
      const names = Array.from(space.names);
      const timestamps = Array.from(space.timestamps);
      const scales = Float64Array.from(space.scales);
      const units = Array.from(space.units);
      for (let i = 0; i < rank; ++i) {
        const combinedIndex = combinedIndices[i];
        if (combinedIndex === undefined) continue;
        units[i] = mergedUnits[combinedIndex];
        scales[i] = mergedScales[combinedIndex];
        timestamps[i] = mergedTimestamps[combinedIndex];
        names[i] = mergedNames[combinedIndex];
      }
      for (const name of names) {
        let count = dimensionRefCounts.get(name);
        if (count === undefined) {
          count = 1;
        } else {
          ++count;
        }
        dimensionRefCounts.set(name, count);
      }
      if (!arraysEqual(units, space.units) || !arraysEqual(scales, space.scales) ||
          !arraysEqual(names, space.names) || !arraysEqual(timestamps, space.timestamps)) {
        const newSpace = makeCoordinateSpace({
          valid: space.valid,
          ids: space.ids,
          scales,
          units,
          names,
          timestamps,
          boundingBoxes: space.boundingBoxes,
          coordinateArrays: space.coordinateArrays,
        });
        binding.prevValue = newSpace;
        binding.space.value = newSpace;
      }
    }

    {
      for (let i = 0; i < newRank; ++i) {
        if (!include(mergedNames[i])) {
          dimensionRefs[i] = 0;
        }
      }
      const hasRefs = (_: any, i: number) => dimensionRefs[i] !== 0;
      mergedNames = mergedNames.filter(hasRefs);
      mergedUnits = mergedUnits.filter(hasRefs);
      mergedScales = mergedScales.filter(hasRefs);
      mergedIds = mergedIds.filter(hasRefs);
      mergedTimestamps = mergedTimestamps.filter(hasRefs);
      dimensionRefs = dimensionRefs.filter(hasRefs);
      newRank = mergedNames.length;
    }

    const mergedBoundingBoxes: TransformedBoundingBox[] = [];
    const allCoordinateArrays = new Array<CoordinateArray[]|undefined>(newRank);
    // Include any explicit coordinate arrays from `existing`.
    for (let i = 0, existingRank = existing.rank; i < existingRank; ++i) {
      const coordinateArray = existing.coordinateArrays[i];
      if (!coordinateArray?.explicit) continue;
      const newDim = mergedIds.indexOf(existing.ids[i]);
      if (newDim === -1) continue;
      allCoordinateArrays[newDim] = [coordinateArray];
    }
    for (const binding of bindings) {
      const {space: {value: space}} = binding;
      const {rank, boundingBoxes, coordinateArrays} = space;
      const newDims = space.names.map(x => mergedNames.indexOf(x));
      for (const oldBoundingBox of boundingBoxes) {
        mergedBoundingBoxes.push(extendTransformedBoundingBox(oldBoundingBox, newRank, newDims));
      }
      for (let i = 0; i < rank; ++i) {
        const coordinateArray = coordinateArrays[i];
        if (coordinateArray === undefined) continue;
        const newDim = newDims[i];
        const mergedList = allCoordinateArrays[newDim];
        if (mergedList === undefined) {
          allCoordinateArrays[newDim] = [coordinateArray];
        } else {
          mergedList.push(coordinateArray);
        }
      }
    }
    const mergedCoordinateArrays = new Array<CoordinateArray|undefined>(newRank);
    for (let i = 0; i < newRank; ++i) {
      const mergedList = allCoordinateArrays[i];
      if (mergedList === undefined) continue;
      mergedCoordinateArrays[i] = mergeCoordinateArrays(mergedList);
    }
    const newCombined = makeCoordinateSpace({
      valid,
      ids: mergedIds,
      names: mergedNames,
      units: mergedUnits,
      scales: new Float64Array(mergedScales),
      boundingBoxes: mergedBoundingBoxes,
      coordinateArrays: mergedCoordinateArrays,
    });
    if (retainExisting) {
      for (let i = 0; i < newRank; ++i) {
        --dimensionRefs[i];
      }
    }
    if (!coordinateSpacesEqual(existing, newCombined)) {
      this.prevCombined = newCombined;
      combined.value = newCombined;
    }
  }

  private handleCombinedChanged = () => {
    if (this.combined.value === this.prevCombined) return;
    this.update();
  };

  retain() {
    ++this.retainCount;
    return () => {
      if (--this.retainCount === 0) {
        this.update();
      }
    };
  }

  bind(space: WatchableValueInterface<CoordinateSpace>) {
    const binding = {space, mappedDimensionIds: [], prevValue: undefined};
    const {bindings} = this;
    if (bindings.size === 0) {
      this.combined.changed.add(this.handleCombinedChanged);
    }
    bindings.add(binding);

    const changedDisposer = space.changed.add(() => {
      if (space.value === binding.prevValue) return;
      this.update();
    });
    const disposer = () => {
      changedDisposer();
      const {bindings} = this;
      bindings.delete(binding);
      if (bindings.size === 0) {
        this.combined.changed.remove(this.handleCombinedChanged);
      }
      this.update();
    };
    this.update();
    return disposer;
  }
}

export function homogeneousTransformSubmatrix<T extends TypedArray>(
    constructor: {new (n: number): T}, oldTransform: TypedArray, oldRank: number,
    oldRows: readonly number[], oldCols: readonly number[]): T {
  const newRank = oldCols.length;
  const newTransform = new constructor((newRank + 1) ** 2);
  newTransform[newTransform.length - 1] = 1;
  for (let newRow = 0; newRow < newRank; ++newRow) {
    const oldRow = oldRows[newRow];
    newTransform[(newRank + 1) * newRank + newRow] = oldTransform[(oldRank + 1) * oldRank + oldRow];
    for (let newCol = 0; newCol < newRank; ++newCol) {
      const oldCol = oldCols[newCol];
      newTransform[(newRank + 1) * newCol + newRow] = oldTransform[(oldRank + 1) * oldCol + oldRow];
    }
  }
  return newTransform;
}

export interface CoordinateTransformSpecification {
  sourceRank: number;
  transform: Float64Array|undefined;
  inputSpace: CoordinateSpace|undefined;
  outputSpace: CoordinateSpace;
}

export function coordinateTransformSpecificationFromLegacyJson(obj: unknown):
    CoordinateTransformSpecification|undefined {
  if (obj === undefined) return undefined;
  const transform = new Float64Array(16);
  if (Array.isArray(obj)) {
    if (obj.length === 16) {
      for (let i = 0; i < 4; ++i) {
        for (let j = 0; j < 4; ++j) {
          transform[i * 4 + j] = verifyFiniteFloat(obj[j * 4 + i]);
        }
      }
    } else {
      expectArray(obj, 4);
      for (let i = 0; i < 4; ++i) {
        const row = expectArray(obj[i], 4);
        for (let j = 0; j < 4; ++j) {
          transform[j * 4 + i] = verifyFiniteFloat(row[j]);
        }
      }
    }
  } else {
    verifyObject(obj);
    const rotation = quat.create();
    const translation = vec3.create();
    const scale = vec3.fromValues(1, 1, 1);
    verifyOptionalObjectProperty(obj, 'rotation', x => {
      parseFiniteVec(rotation, x);
      quat.normalize(rotation, rotation);
    });
    verifyOptionalObjectProperty(obj, 'translation', x => {
      parseFiniteVec(translation, x);
    });
    verifyOptionalObjectProperty(obj, 'scale', x => {
      parseFiniteVec(scale, x);
    });
    const tempMat4 = mat4.create();
    mat4.fromRotationTranslationScale(tempMat4, rotation, translation, scale);
    transform.set(tempMat4);
  }
  return {
    sourceRank: 3,
    transform,
    outputSpace: makeCoordinateSpace({
      valid: true,
      names: ['x', 'y', 'z'],
      units: ['m', 'm', 'm'],
      scales: Float64Array.of(1e-9, 1e-9, 1e-9)
    }),
    inputSpace: undefined,
  };
}

export function coordinateTransformSpecificationFromJson(j: unknown):
    CoordinateTransformSpecification|undefined {
  if (j === undefined) return undefined;
  const obj = verifyObject(j);
  const outputSpace = verifyObjectProperty(obj, 'outputDimensions', coordinateSpaceFromJson);
  const rank = outputSpace.rank;
  const sourceRank = verifyObjectProperty(obj, 'sourceRank', rankObj => {
    if (rankObj === undefined) return rank;
    if (!Number.isInteger(rankObj) || rankObj < 0 || rankObj > rank) {
      throw new Error(
          `Expected integer in range [0, ${rank}] but received: ${JSON.stringify(rankObj)}`);
    }
    return rankObj as number;
  });
  const inputSpace = verifyOptionalObjectProperty(obj, 'inputDimensions', inputSpaceObj => {
    const space = coordinateSpaceFromJson(inputSpaceObj, true);
    if (space.rank !== rank) {
      throw new Error(`Expected rank of ${rank}, but received rank of: ${space.rank}`);
    }
    return space;
  });
  const transform = verifyOptionalObjectProperty(obj, 'matrix', x => {
    const transform = new Float64Array((rank + 1) ** 2);
    const a = expectArray(x, rank);
    transform[transform.length - 1] = 1;
    for (let i = 0; i < rank; ++i) {
      try {
        const row = expectArray(a[i], rank + 1);
        for (let j = 0; j <= rank; ++j) {
          transform[(rank + 1) * j + i] = verifyFiniteFloat(row[j]);
        }
      } catch (e) {
        throw new Error(`Error in row ${i}: ${e.message}`);
      }
    }
    return transform;
  });
  return {transform, outputSpace, inputSpace, sourceRank};
}

export function coordinateTransformSpecificationToJson(spec: CoordinateTransformSpecification|
                                                       undefined) {
  if (spec === undefined) return undefined;
  const {transform, outputSpace, inputSpace, sourceRank} = spec;
  let m: number[][]|undefined;
  const rank = outputSpace.rank;
  if (transform !== undefined) {
    m = [];
    for (let i = 0; i < rank; ++i) {
      const row: number[] = [];
      m[i] = row;
      for (let j = 0; j <= rank; ++j) {
        row[j] = transform[(rank + 1) * j + i];
      }
    }
  }
  return {
    sourceRank: sourceRank === rank ? undefined : sourceRank,
    matrix: m,
    outputDimensions: coordinateSpaceToJson(outputSpace),
    inputDimensions: inputSpace === undefined ? undefined : coordinateSpaceToJson(inputSpace),
  };
}

export function permuteTransformedBoundingBox(
    boundingBox: TransformedBoundingBox, newToOld: readonly number[],
    oldOutputRank: number): TransformedBoundingBox|undefined {
  const {box, transform} = boundingBox;
  const inputRank = boundingBox.box.lowerBounds.length;
  const outputRank = newToOld.length;
  const newTransform = new Float64Array((inputRank + 1) * outputRank);
  matrix.permuteRows(newTransform, outputRank, transform, oldOutputRank, newToOld, inputRank + 1);
  if (newTransform.every(x => x === 0)) return undefined;
  return {
    transform: newTransform,
    box,
  };
}

export function permuteCoordinateSpace(existing: CoordinateSpace, newToOld: readonly number[]) {
  const {ids, names, scales, units, timestamps, coordinateArrays} = existing;
  return makeCoordinateSpace({
    rank: newToOld.length,
    valid: existing.valid,
    ids: newToOld.map(i => ids[i]),
    names: newToOld.map(i => names[i]),
    timestamps: newToOld.map(i => timestamps[i]),
    scales: Float64Array.from(newToOld, i => scales[i]),
    units: newToOld.map(i => units[i]),
    coordinateArrays: newToOld.map(i => coordinateArrays[i]),
    boundingBoxes:
        existing.boundingBoxes.map(b => permuteTransformedBoundingBox(b, newToOld, existing.rank))
            .filter(b => b !== undefined) as TransformedBoundingBox[],
  });
}

export function insertDimensionAt(
    existing: CoordinateSpace, targetIndex: number, sourceIndex: number) {
  if (targetIndex === sourceIndex) return existing;
  return permuteCoordinateSpace(
      existing, getInsertPermutation(existing.rank, sourceIndex, targetIndex));
}

export function getInferredOutputScale(transform: CoordinateSpaceTransform, outputDim: number):
    {scale: number, unit: string}|undefined {
  const {transform: transformMatrix, rank} = transform;
  const inputDims = getDependentTransformInputDimensions(transformMatrix, rank, [outputDim]);
  if (inputDims.length !== 1) return undefined;
  const [inputDim] = inputDims;
  const coeff = Math.abs(transformMatrix[(rank + 1) * inputDim + outputDim]);
  const {inputSpace} = transform;
  return {scale: inputSpace.scales[inputDim] * coeff, unit: inputSpace.units[inputDim]};
}


export function getDefaultInputScale(
    transform: WatchableCoordinateSpaceTransform, inputDim: number): {scale: number, unit: string}|
    undefined {
  const {scales: defaultScales, units: defaultUnits} = transform.defaultInputSpace;
  return (inputDim < defaultScales.length) ?
      {scale: defaultScales[inputDim], unit: defaultUnits[inputDim]} :
      undefined;
}
