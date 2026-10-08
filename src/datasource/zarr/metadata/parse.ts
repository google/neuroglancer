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

import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import type {
  ArrayMetadata,
  DimensionSeparator,
  Metadata,
  NodeType,
} from "#src/datasource/zarr/metadata/index.js";
import { ChunkKeyEncoding } from "#src/datasource/zarr/metadata/index.js";
import { parseNameAndConfiguration } from "#src/datasource/zarr/metadata/parse_util.js";
import { Endianness } from "#src/util/endian.js";
import {
  parseArray,
  parseFixedLengthArray,
  verifyConstant,
  verifyEnumString,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalFixedLengthArrayOfStringOrNull,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { parseNumpyDtype } from "#src/util/numpy_dtype.js";
import { allSiPrefixes } from "#src/util/si_units.js";
import { getSourceDataType } from "#src/util/source_data_type.js";

function parseShape(obj: unknown): number[] {
  return parseArray(obj, (x) => {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0) {
      throw new Error(
        `Expected non-negative integer, but received: ${JSON.stringify(x)}`,
      );
    }
    return x;
  });
}

export function parseChunkShape(obj: unknown, rank: number): number[] {
  return parseFixedLengthArray(new Array<number>(rank), obj, (x) => {
    if (typeof x !== "number" || !Number.isInteger(x) || x <= 0) {
      throw new Error(
        `Expected positive integer, but received: ${JSON.stringify(x)}`,
      );
    }
    return x;
  });
}

export function parseDimensionSeparator(value: unknown): "/" | "." {
  if (value !== "." && value !== "/") {
    throw new Error(
      `Expected "." or "/", but received: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const UNITS = new Map<string, { unit: string; scale: number }>([
  ["", { unit: "", scale: 1 }],
  ["angstrom", { unit: "m", scale: 1e-10 }],
  ["foot", { unit: "m", scale: 0.3048 }],
  ["inch", { unit: "m", scale: 0.0254 }],
  ["mile", { unit: "m", scale: 1609.34 }],
  // eslint-disable-next-line no-loss-of-precision
  ["parsec", { unit: "m", scale: 3.0856775814913673e16 }],
  ["yard", { unit: "m", scale: 0.9144 }],
  ["minute", { unit: "s", scale: 60 }],
  ["hour", { unit: "s", scale: 60 * 60 }],
  ["day", { unit: "s", scale: 60 * 60 * 24 }],
]);

for (const unit of ["meter", "second"]) {
  for (const siPrefix of allSiPrefixes) {
    const { longPrefix, prefix } = siPrefix;
    if (longPrefix === undefined) continue;
    const unitInfo = { unit: unit[0], scale: 10 ** siPrefix.exponent };
    UNITS.set(`${longPrefix}${unit}`, unitInfo);
    UNITS.set(`${prefix}${unit[0]}`, unitInfo);
  }
}

export function parseDimensionUnit(obj: unknown): {
  scale: number;
  unit: string;
} {
  if (obj === null) {
    // Default unit
    return { scale: 1, unit: "" };
  }
  if (typeof obj !== "string") {
    throw new Error(`Expected string but received: ${JSON.stringify(obj)}`);
  }
  const s = obj.trim();
  const numberPattern =
    /^([-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?\d+)?)\s*(.*)/;
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
  return { unit: unitInfo.unit, scale: scale * unitInfo.scale };
}

export function parseV3Metadata(
  obj: unknown,
  expectedNodeType: NodeType | undefined,
): Metadata {
  try {
    verifyObject(obj);
    verifyObjectProperty(obj, "zarr_format", (value) => {
      verifyConstant(value, 3);
    });
    const nodeType: NodeType = verifyObjectProperty(
      obj,
      "node_type",
      (value) => {
        if (expectedNodeType !== undefined) {
          verifyConstant(value, expectedNodeType);
        }
        if (value !== "array" && value !== "group") {
          throw new Error(
            `Expected "array" or "group" but received: ${JSON.stringify(
              value,
            )}`,
          );
        }
        return value;
      },
    );
    expectedNodeType = nodeType;

    if (nodeType === "group") {
      return {
        zarrVersion: 3,
        nodeType: "group",
        userAttributes: verifyOptionalObjectProperty(
          obj,
          "attributes",
          verifyObject,
          {},
        ),
      };
    }

    const shape = verifyObjectProperty(obj, "shape", parseShape);
    const rank = shape.length;

    const dimensionNames = verifyObjectProperty(
      obj,
      "dimension_names",
      (names) =>
        verifyOptionalFixedLengthArrayOfStringOrNull(names ?? undefined, rank),
    );

    const sourceDataType = verifyObjectProperty(obj, "data_type", (x) =>
      getSourceDataType(verifyString(x)),
    );
    const dataType = sourceDataType.dataType;
    if (sourceDataType.numComponents !== 1) {
      throw new Error(
        `Unsupported data type: ${JSON.stringify(sourceDataType.name)}`,
      );
    }

    const { configuration: chunkShape } = verifyObjectProperty(
      obj,
      "chunk_grid",
      (chunkGrid) =>
        parseNameAndConfiguration(
          chunkGrid,
          (name) => verifyConstant(name, "regular"),
          (configuration) =>
            verifyObjectProperty(configuration, "chunk_shape", (chunks) =>
              parseChunkShape(chunks, rank),
            ),
        ),
    );

    const { userAttributes, dimensionUnits } = verifyObjectProperty(
      obj,
      "attributes",
      (x) => {
        if (x === undefined) {
          x = {};
        }
        verifyObject(x);
        const dimensionUnits = verifyObjectProperty(
          x,
          "dimension_units",
          (units) => verifyOptionalFixedLengthArrayOfStringOrNull(units, rank),
        );
        return { userAttributes: x, dimensionUnits };
      },
    );

    const { configuration: dimensionSeparator, name: chunkKeyEncoding } =
      verifyObjectProperty(obj, "chunk_key_encoding", (value) =>
        parseNameAndConfiguration(
          value,
          (name) => verifyEnumString(name, ChunkKeyEncoding, /^(v2|default)$/),
          (configuration, chunkKeyEncoding) =>
            verifyOptionalObjectProperty(
              configuration,
              "separator",
              parseDimensionSeparator,
              chunkKeyEncoding === ChunkKeyEncoding.DEFAULT ? "/" : ".",
            ),
        ),
      );

    const fillValue = verifyObjectProperty(obj, "fill_value", (value) =>
      sourceDataType.parseFillValue(value),
    );

    const codecs = verifyObjectProperty(obj, "codecs", (value) =>
      parseCodecChainSpec(value, {
        sourceDataType: sourceDataType.name,
        chunkShape,
      }),
    );

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
  } catch (e: any) {
    const nodeStr =
      expectedNodeType === undefined ? "" : `${expectedNodeType} `;
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Error parsing zarr v3 ${nodeStr}metadata: ${message}`);
  }
}

export function parseV2Metadata(
  obj: unknown,
  attrs: Record<string, unknown>,
  explicitDimensionSeparator: "." | "/" | undefined,
): ArrayMetadata {
  try {
    verifyObject(obj);
    verifyObjectProperty(obj, "zarr_format", (value) => {
      verifyConstant(value, 2);
    });
    const shape = verifyObjectProperty(obj, "shape", parseShape);
    const rank = shape.length;
    const chunkShape = verifyObjectProperty(obj, "chunks", (chunks) =>
      parseChunkShape(chunks, rank),
    );
    const order = verifyObjectProperty(obj, "order", (order) => {
      if (order !== "C" && order !== "F") {
        throw new Error(
          `Expected "C" or "F", but received: ${JSON.stringify(order)}`,
        );
      }
      return order;
    });
    const dimensionSeparator: DimensionSeparator = verifyOptionalObjectProperty(
      obj,
      "dimension_separator",
      explicitDimensionSeparator === undefined
        ? parseDimensionSeparator
        : (value) => verifyConstant(value, explicitDimensionSeparator),
      explicitDimensionSeparator ?? ".",
    );
    const numpyDtype = verifyObjectProperty(obj, "dtype", (dtype) =>
      parseNumpyDtype(verifyString(dtype)),
    );

    const sourceDataType = numpyDtype.sourceDataType;
    const dataType = sourceDataType.dataType;
    if (sourceDataType.numComponents !== 1) {
      throw new Error(
        `Unsupported data type: ${JSON.stringify(sourceDataType.name)}`,
      );
    }
    const bytesPerElement = sourceDataType.bitsPerElement / 8;
    const fillValue = verifyObjectProperty(obj, "fill_value", (value) => {
      if (value === null) {
        return 0;
      }
      return sourceDataType.parseFillValue(value);
    });

    const codecs = [];
    if (order === "F") {
      codecs.push({
        name: "transpose",
        configuration: { order: Array.from(shape, (_, i) => rank - i - 1) },
      });
    }
    codecs.push({
      name: "bytes",
      configuration: {
        endian: numpyDtype.endianness === Endianness.LITTLE ? "little" : "big",
      },
    });
    verifyObjectProperty(obj, "compressor", (compressor) => {
      if (compressor === null) return;
      verifyObject(compressor);
      const id = verifyObjectProperty(compressor, "id", verifyString);
      switch (id) {
        case "blosc":
          codecs.push({
            name: "blosc",
            configuration: {
              cname: verifyObjectProperty(compressor, "cname", verifyString),
              clevel: verifyObjectProperty(compressor, "clevel", verifyInt),
              typesize: bytesPerElement,
              shuffle: verifyObjectProperty(
                compressor,
                "shuffle",
                (shuffle) => {
                  switch (shuffle) {
                    case -1:
                      return bytesPerElement === 1 ? "bitshuffle" : "shuffle";
                    case 0:
                      return "noshuffle";
                    case 1:
                      return "shuffle";
                    case 2:
                      return "bitshuffle";
                  }
                  throw new Error(`Invalid value: ${JSON.stringify(shuffle)}`);
                },
              ),
              blocksize: verifyOptionalObjectProperty(
                compressor,
                "blocksize",
                verifyInt,
                0,
              ),
            },
          });
          break;
        case "zlib":
        case "gzip":
        case "zstd":
          codecs.push({
            name: id,
            configuration: {
              level: verifyObjectProperty(compressor, "level", verifyInt),
            },
          });
          break;
        default:
          throw new Error(`Unsupported compressor: ${JSON.stringify(id)}`);
      }
    });

    const codecChainSpec = parseCodecChainSpec(codecs, {
      sourceDataType: sourceDataType.name,
      chunkShape,
    });

    return {
      zarrVersion: 2,
      nodeType: "array",
      rank,
      shape,
      chunkShape,
      dataType,
      fillValue,
      dimensionNames: verifyObjectProperty(
        attrs,
        "_ARRAY_DIMENSIONS",
        (names) => verifyOptionalFixedLengthArrayOfStringOrNull(names, rank),
      ),
      dimensionUnits: verifyObjectProperty(attrs, "dimension_units", (units) =>
        verifyOptionalFixedLengthArrayOfStringOrNull(units, rank),
      ),
      userAttributes: attrs,
      dimensionSeparator,
      chunkKeyEncoding: ChunkKeyEncoding.V2,
      codecs: codecChainSpec,
    };
  } catch (e: any) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Error parsing zarr v2 metadata: ${message}`);
  }
}
