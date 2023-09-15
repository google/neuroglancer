/**
 * @license
 * Copyright 2023 Google Inc.
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

import {parseCodecChainSpec} from 'neuroglancer/datasource/zarr/codec/resolve';
import {ArrayMetadata, ChunkKeyEncoding, DimensionSeparator, Metadata, NodeType} from 'neuroglancer/datasource/zarr/metadata';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {Endianness} from 'neuroglancer/util/endian';
import {parseArray, parseFixedLengthArray, verifyConstant, verifyEnumString, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalFixedLengthArrayOfStringOrNull, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {parseNumpyDtype} from 'neuroglancer/util/numpy_dtype';
import {allSiPrefixes} from 'neuroglancer/util/si_units';

function parseShape(obj: unknown): number[] {
  return parseArray(obj, x => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) {
      throw new Error(`Expected non-negative integer, but received: ${JSON.stringify(x)}`);
    }
    return x;
  });
}

export function parseChunkShape(obj: unknown, rank: number): number[] {
  return parseFixedLengthArray(new Array<number>(rank), obj, x => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x <= 0) {
      throw new Error(`Expected positive integer, but received: ${JSON.stringify(x)}`);
    }
    return x;
  });
}

export function parseDimensionSeparator(value: unknown): '/'|'.' {
  if (value !== '.' && value !== '/') {
    throw new Error(`Expected "." or "/", but received: ${JSON.stringify(value)}`);
  }
  return value;
}

const UNITS = new Map<string, {unit: string, scale: number}>([
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
    UNITS.set(`${longPrefix}${unit}`, {unit: unit[0], scale: Math.pow(10, siPrefix.exponent)});
    UNITS.set(`${longPrefix}${unit[0]}`, {unit: unit[0], scale: Math.pow(10, siPrefix.exponent)});
  }
}

export function parseDimensionUnit(obj: unknown): {scale: number, unit: string} {
  if (obj === null) {
    // Default unit
    return {scale: 1, unit: ''};
  }
  if (typeof obj !== 'string') {
    throw new Error(`Expected string but received: ${JSON.stringify(obj)}`);
  }
  const s = obj.trim();
  const numberPattern = /^([-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?\d+)?)\s*(.*)/;
  const m = s.match(numberPattern);
  let scale: number;
  let derivedUnit: string;
  if (m === null) {
    scale = 1;
    derivedUnit = s;
  } else {
    scale = Number(m[1]);
    derivedUnit = m[2];
  }
  const unitInfo = UNITS.get(derivedUnit);
  if (unitInfo === undefined) {
    throw new Error(`Unsupported unit: ${JSON.stringify(derivedUnit)}`);
  }
  return {unit: unitInfo.unit, scale: scale * unitInfo.scale};
}

function parseFillValue(dataType: DataType, value: unknown) {
  switch (dataType) {
    case DataType.UINT8:
    case DataType.INT8:
    case DataType.UINT16:
    case DataType.INT16:
    case DataType.UINT32:
    case DataType.INT32:
    case DataType.UINT64:
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`Expected integer but received: ${JSON.stringify(value)}`);
      }
      return value;
    case DataType.FLOAT32:
      if (typeof value === 'number') {
        return value;
      }
      if (typeof value === 'string') {
        if (value === 'Infinity') {
          return Number.POSITIVE_INFINITY;
        }
        if (value === '-Infinity') {
          return Number.NEGATIVE_INFINITY;
        }
        if (value === 'NaN') {
          return new Float32Array(Uint32Array.of(0x7fc00000).buffer)[0];
        }
        if (value.match(/^0x[a-fA-F0-9]+$/)) {
          return new Float32Array(Uint32Array.of(Number(value)).buffer)[0];
        }
      }
      throw new Error(
          `Expected number, "Infinity", "-Infinity", "NaN", or hex string but received: ${
              JSON.stringify(value)}`);
  }
}

export function parseNameAndConfiguration<Name, Configuration>(
    obj: unknown, parseName: (name: string) => Name,
    parseConfiguration: (configuration: unknown, name: Name) =>
        Configuration): {name: Name, configuration: Configuration} {
  verifyObject(obj);
  const name = verifyObjectProperty(obj, 'name', value => parseName(verifyString(value)));
  const configuration = verifyObjectProperty(obj, 'configuration', value => {
    if (value === undefined) {
      value = {};
    } else {
      verifyObject(value);
    }
    return parseConfiguration(value, name);
  });
  return {name, configuration};
}

export function parseV3Metadata(obj: unknown, expectedNodeType: NodeType|undefined): Metadata {
  try {
    verifyObject(obj);
    verifyObjectProperty(obj, 'zarr_format', value => {
      verifyConstant(value, 3);
    });
    const nodeType: NodeType = verifyObjectProperty(obj, 'node_type', value => {
      if (expectedNodeType !== undefined) {
        verifyConstant(value, expectedNodeType);
      }
      if (value !== 'array' && value !== 'group') {
        throw new Error(`Expected "array" or "group" but received: ${JSON.stringify(value)}`);
      }
      return value;
    });
    expectedNodeType = nodeType;

    if (nodeType === 'group') {
      return {
        zarrVersion: 3,
        nodeType: 'group',
        userAttributes: verifyOptionalObjectProperty(obj, 'attributes', verifyObject, {}),
      };
    }

    const shape = verifyObjectProperty(obj, 'shape', parseShape);
    const rank = shape.length;

    const dimensionNames = verifyObjectProperty(
        obj, 'dimension_names',
        names => verifyOptionalFixedLengthArrayOfStringOrNull(names ?? undefined, rank));

    const dataType =
        verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType, /^[a-z0-9]+$/));

    const {configuration: chunkShape} = verifyObjectProperty(
        obj, 'chunk_grid',
        chunkGrid => parseNameAndConfiguration(
            chunkGrid, name => verifyConstant(name, 'regular'),
            configuration => verifyObjectProperty(
                configuration, 'chunk_shape', chunks => parseChunkShape(chunks, rank))));

    const {userAttributes, dimensionUnits} = verifyObjectProperty(obj, 'attributes', x => {
      if (x === undefined) {
        x = {};
      }
      verifyObject(x);
      const dimensionUnits = verifyObjectProperty(
          x, 'dimension_units', units => verifyOptionalFixedLengthArrayOfStringOrNull(units, rank));
      return {userAttributes: x, dimensionUnits};
    });

    const {configuration: dimensionSeparator, name: chunkKeyEncoding} = verifyObjectProperty(
        obj, 'chunk_key_encoding',
        value => parseNameAndConfiguration(
            value, name => verifyEnumString(name, ChunkKeyEncoding, /^(v2|default)$/),
            (configuration, chunkKeyEncoding) => verifyOptionalObjectProperty(
                configuration, 'separator', parseDimensionSeparator,
                chunkKeyEncoding === ChunkKeyEncoding.DEFAULT ? '/' : '.')));

    const fillValue =
        verifyObjectProperty(obj, 'fill_value', value => parseFillValue(dataType, value));

    const codecs = verifyObjectProperty(
        obj, 'codecs', value => parseCodecChainSpec(value, {dataType, chunkShape}));

    return {
      zarrVersion: 3,
      nodeType,
      rank,
      shape,
      chunkShape,
      dataType,
      fillValue,
      dimensionNames,
      dimensionUnits,
      chunkKeyEncoding,
      dimensionSeparator,
      userAttributes,
      codecs,
    };
  } catch (e) {
    const nodeStr = expectedNodeType === undefined ? '' : `${expectedNodeType} `;
    throw new Error(`Error parsing zarr v3 ${nodeStr}metadata: ${e.message}`);
  }
}

export function parseV2Metadata(
    obj: unknown, attrs: Record<string, unknown>,
    explicitDimensionSeparator: '.'|'/'|undefined): ArrayMetadata {
  try {
    verifyObject(obj);
    verifyObjectProperty(obj, 'zarr_format', value => {
      verifyConstant(value, 2);
    });
    const shape = verifyObjectProperty(obj, 'shape', parseShape);
    const rank = shape.length;
    const chunkShape = verifyObjectProperty(obj, 'chunks', chunks => parseChunkShape(chunks, rank));
    const order = verifyObjectProperty(obj, 'order', order => {
      if (order !== 'C' && order !== 'F') {
        throw new Error(`Expected "C" or "F", but received: ${JSON.stringify(order)}`);
      }
      return order;
    });
    const dimensionSeparator: DimensionSeparator = verifyOptionalObjectProperty(
        obj, 'dimension_separator',
        explicitDimensionSeparator === undefined ?
            parseDimensionSeparator :
            value => verifyConstant(value, explicitDimensionSeparator),
        explicitDimensionSeparator ?? '.');
    const numpyDtype =
        verifyObjectProperty(obj, 'dtype', dtype => parseNumpyDtype(verifyString(dtype)));

    const dataType = numpyDtype.dataType;
    const fillValue = verifyObjectProperty(obj, 'fill_value', value => {
      if (value === null) {
        return 0;
      }
      return parseFillValue(dataType, value);
    });

    const codecs = [];
    if (order === 'F') {
      codecs.push({
        'name': 'transpose',
        'configuration': {'order': Array.from(shape, (_, i) => rank - i - 1)},
      });
    }
    codecs.push({
      'name': 'bytes',
      'configuration': {'endian': numpyDtype.endianness === Endianness.LITTLE ? 'little' : 'big'}
    });
    verifyObjectProperty(obj, 'compressor', compressor => {
      if (compressor === null) return;
      verifyObject(compressor);
      const id = verifyObjectProperty(compressor, 'id', verifyString);
      switch (id) {
        case 'blosc':
          codecs.push({
            'name': 'blosc',
            'configuration': {
              'cname': verifyObjectProperty(compressor, 'cname', verifyString),
              'clevel': verifyObjectProperty(compressor, 'clevel', verifyInt),
              'typesize': DATA_TYPE_BYTES[dataType],
              'shuffle': verifyObjectProperty(
                  compressor, 'shuffle',
                  shuffle => {
                    switch (shuffle) {
                      case -1:
                        return (DATA_TYPE_BYTES[dataType] === 1) ? 'bitshuffle' : 'shuffle';
                      case 0:
                        return 'noshuffle';
                      case 1:
                        return 'shuffle';
                      case 2:
                        return 'bitshuffle';
                    }
                    throw new Error(`Invalid value: ${JSON.stringify(shuffle)}`);
                  }),
              'blocksize': verifyOptionalObjectProperty(compressor, 'blocksize', verifyInt, 0),
            },
          });
          break;
        case 'zlib':
        case 'gzip':
          codecs.push({
            'name': 'gzip',
            'configuration': {'level': verifyObjectProperty(compressor, 'level', verifyInt)}
          });
          break;
        case 'zstd':
          codecs.push({
            'name': 'zstd',
            'configuration': {'level': verifyObjectProperty(compressor, 'level', verifyInt)}
          });
          break;
        default:
          throw new Error(`Unsupported compressor: ${JSON.stringify(id)}`);
      }
    });

    const codecChainSpec = parseCodecChainSpec(codecs, {dataType, chunkShape});

    return {
      zarrVersion: 2,
      nodeType: 'array',
      rank,
      shape,
      chunkShape,
      dataType,
      fillValue,
      dimensionNames: verifyObjectProperty(
          attrs, '_ARRAY_DIMENSIONS',
          names => verifyOptionalFixedLengthArrayOfStringOrNull(names, rank)),
      dimensionUnits: verifyObjectProperty(
          attrs, 'dimension_units',
          units => verifyOptionalFixedLengthArrayOfStringOrNull(units, rank)),
      userAttributes: attrs,
      dimensionSeparator,
      chunkKeyEncoding: ChunkKeyEncoding.V2,
      codecs: codecChainSpec,
    };
  } catch (e) {
    throw new Error(`Error parsing zarr v2 metadata: ${e.message}`);
  }
}
