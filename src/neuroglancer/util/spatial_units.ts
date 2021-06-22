/**
 * @license
 * Copyright 2018 Google Inc.
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

import {mat3, mat4, prod3, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {pickLengthUnit, pickVolumeUnit} from 'neuroglancer/widget/scale_bar';

export function formatIntegerPoint(point: Float32Array) {
  let result = `(`;
  for (let i = 0, rank = point.length; i < rank; ++i) {
    if (i !== 0) result += ', ';
    result += Math.floor(point[i]).toString();
  }
  result += ')';
  return result;
}

export function formatIntegerBounds(bounds: Float32Array) {
  let result = '';
  for (let i = 0, rank = bounds.length; i < rank; ++i) {
    if (i !== 0) {
      result += ' × ';
    }
    result += Math.round(Math.abs(bounds[i]));
  }
  return result;
}

export function formatLength(lengthInNanometers: number) {
  const unit = pickLengthUnit(lengthInNanometers);
  const value = lengthInNanometers / unit.lengthInNanometers;
  return `${value.toPrecision(3)}\u202f${unit.unit}`;
}

export function formatVolume(volumeInCubicNanometers: number) {
  const unit = pickVolumeUnit(volumeInCubicNanometers);
  const value = volumeInCubicNanometers / Math.pow(unit.lengthInNanometers, 3);
  return `${value.toPrecision(6)}\u202f${unit.unit}³`;
}

export function formatBoundingBoxVolume(pointA: vec3, pointB: vec3, transform: mat4) {
  let dimensionText = '';
  const vector = vec3.create();
  for (let axis = 0; axis < 3; ++axis) {
    vec3.set(vector, 0, 0, 0);
    vector[axis] = pointB[axis] - pointA[axis];
    const spatialVector = transformVectorByMat4(vector, vector, transform);
    const length = vec3.length(spatialVector);
    if (axis !== 0) {
      dimensionText += ' × ';
    }
    dimensionText += formatLength(length);
  }

  const preTransformVolume = Math.abs(prod3(vec3.subtract(vector, pointB, pointA)));
  const det = Math.abs(mat3.determinant(mat3.fromMat4(mat3.create(), transform)));
  const postTransformVolume = det * preTransformVolume;

  return `${dimensionText}  [${formatVolume(postTransformVolume)}]`;
}
