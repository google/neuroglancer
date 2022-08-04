/**
 * @license
 * Copyright 2022 Google Inc.
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

import {CoordinateSpace, makeCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {parseArray, parseFixedLengthArray, verifyFiniteFloat, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {allSiPrefixes} from 'neuroglancer/util/si_units';

export interface OmeMultiscaleScale {
  url: string;
  transform: Float64Array;
}

export interface OmeMultiscaleMetadata {
  scales: OmeMultiscaleScale[];
  coordinateSpace: CoordinateSpace;
}

const SUPPORTED_OME_MULTISCALE_VERSIONS = new Set(['0.4', '0.5-dev', '0.5']);

const OME_UNITS = new Map<string, {unit: string, scale: number}>([
  ['angstrom', {unit: 'm', scale: 1e-10}],
  ['foot', {unit: 'm', scale: 0.3048}],
  ['inch', {unit: 'm', scale: 0.0254}],
  ['mile', {unit: 'm', scale: 1609.34}],
  ['parsec', {unit: 'm', scale: 3.0856775814913673e16}],
  ['yard', {unit: 'm', scale: 0.9144}],
  ['minute', {unit: 's', scale: 60}],
  ['hour', {unit: 's', scale: 60 * 60}],
  ['day', {unit: 's', scale: 60 * 60 * 24}],
]);

for (const unit of ['meter', 'second']) {
  for (const siPrefix of allSiPrefixes) {
    const {longPrefix} = siPrefix;
    if (longPrefix === undefined) continue;
    OME_UNITS.set(`${longPrefix}${unit}`, {unit: unit[0], scale: Math.pow(10, siPrefix.exponent)});
  }
}

interface Axis {
  name: string;
  unit: string;
  scale: number;
  type: string|undefined;
}

function parseOmeAxis(axis: unknown): Axis {
  verifyObject(axis);
  const name = verifyObjectProperty(axis, 'name', verifyString);
  const type = verifyOptionalObjectProperty(axis, 'type', verifyString);
  const parsedUnit = verifyOptionalObjectProperty(axis, 'unit', unit => {
    const x = OME_UNITS.get(unit);
    if (x === undefined) {
      throw new Error(`Unsupported unit: ${JSON.stringify(unit)}`);
    }
    return x;
  }, {unit: '', scale: 1});
  return {name, unit: parsedUnit.unit, scale: parsedUnit.scale, type};
}

function parseOmeAxes(axes: unknown): CoordinateSpace {
  const parsedAxes = parseArray(axes, parseOmeAxis);
  return makeCoordinateSpace({
    names: parsedAxes.map(axis => {
      const {name, type} = axis;
      if (type === 'channel') {
        return `${name}'`;
      } else {
        return name;
      }
    }),
    scales: Float64Array.from(parsedAxes, axis => axis.scale),
    units: parsedAxes.map(axis => axis.unit),
  });
}

function parseScaleTransform(rank: number, obj: unknown) {
  const scales = verifyObjectProperty(
      obj, 'scale',
      values => parseFixedLengthArray(new Float64Array(rank), values, verifyFinitePositiveFloat));
  return matrix.createHomogeneousScaleMatrix(Float64Array, scales);
}

function parseIdentityTransform(rank: number, obj: unknown) {
  obj;
  return matrix.createIdentity(Float64Array, rank + 1);
}

function parseTranslationTransform(rank: number, obj: unknown) {
  const translation = verifyObjectProperty(
      obj, 'translation',
      values => parseFixedLengthArray(new Float64Array(rank), values, verifyFiniteFloat));
  return matrix.createHomogeneousTranslationMatrix(Float64Array, translation);
}

const coordinateTransformParsers = new Map([
  ["scale", parseScaleTransform],
  ["identity", parseIdentityTransform],
  ["translation", parseTranslationTransform],
]);

function parseOmeCoordinateTransform(rank: number, transformJson: unknown): Float64Array {
  verifyObject(transformJson);
  const transformType = verifyObjectProperty(transformJson, "type", verifyString);
  const parser = coordinateTransformParsers.get(transformType);
  if (parser === undefined) {
    throw new Error(`Unsupported coordinate transform type: ${JSON.stringify(transformType)}`);
  }
  return parser(rank, transformJson);
}

function parseOmeCoordinateTransforms(rank: number, transforms: unknown): Float64Array {
  let transform = matrix.createIdentity(Float64Array, rank + 1);
  if (transforms === undefined) return transform;
  parseArray(transforms, transformJson => {
    const newTransform = parseOmeCoordinateTransform(rank, transformJson);
    transform = matrix.multiply(
        new Float64Array(transform.length), rank + 1, newTransform, rank + 1, transform, rank + 1,
        rank + 1, rank + 1, rank + 1);
  });
  return transform;
}

function parseMultiscaleScale(rank: number, url: string, obj: unknown): OmeMultiscaleScale {
  const path = verifyObjectProperty(obj, 'path', verifyString);
  const transform = verifyObjectProperty(
    obj, 'coordinateTransformations', x => parseOmeCoordinateTransforms(rank, x));
  const scaleUrl = `${url}/${path}`;
  return {url: scaleUrl, transform};
}

function parseOmeMultiscale(url: string, multiscale: unknown): OmeMultiscaleMetadata {
  const coordinateSpace = verifyObjectProperty(multiscale, 'axes', parseOmeAxes);
  const rank = coordinateSpace.rank;
  const transform = verifyObjectProperty(
      multiscale, 'coordinateTransformations', x => parseOmeCoordinateTransforms(rank, x));
  const scales = verifyObjectProperty(
      multiscale, 'datasets', obj => parseArray(obj, x => {
                                const scale = parseMultiscaleScale(rank, url, x);
                                scale.transform = matrix.multiply(
                                    new Float64Array((rank + 1) ** 2), rank + 1, transform,
                                    rank + 1, scale.transform, rank + 1, rank + 1, rank + 1,
                                    rank + 1);
                                return scale;
                              }));
  if (scales.length === 0) {
    throw new Error(`At least one scale must be specified`);
  }

  const baseTransform = scales[0].transform;
  // Extract the scale factor from `baseTransform`.
  //
  // TODO(jbms): If coordinate transformations other than `scale` and `translation` are supported,
  // this will need to be modified.
  const baseScales = new Float64Array(rank);
  for (let i = 0; i < rank; ++i) {
    const scale = baseScales[i] = baseTransform[i * (rank + 1) + i];
    coordinateSpace.scales[i] *= scale;
  }
  for (const scale of scales) {
    const t = scale.transform;
    for (let i = 0; i < rank; ++i) {
      for (let j = 0; j <= rank; ++j) {
        t[j * (rank + 1) + i] /= baseScales[i];
      }
    }
  }
  return {coordinateSpace, scales};
}

export function parseOmeMetadata(url: string, attrs: any): OmeMultiscaleMetadata|undefined {
  const multiscales = attrs.multiscales;
  if (!Array.isArray(multiscales)) return undefined;
  let errors: string[] = [];
  for (const multiscale of multiscales) {
    if (typeof multiscale !== 'object' || multiscale == null || Array.isArray(multiscale)) {
      // Not valid OME multiscale spec.
      return undefined;
    }
    const version = multiscale.version;
    if (version === undefined) return undefined;
    if (!SUPPORTED_OME_MULTISCALE_VERSIONS.has(version)) {
      errors.push(`OME multiscale metadata version ${JSON.stringify(version)} is not supported`);
      continue;
    }
    return parseOmeMultiscale(url, multiscale);
  }
  if (errors.length !== 0) {
    throw new Error(errors[0]);
  }
  return undefined;
}
