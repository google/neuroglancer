/**
 * @file Registry describing how data types supported by data sources map onto the much smaller set
 * of `DataType` representations that can be uploaded to the GPU.
 *
 * Data sources refer to entries by `name`, since chunk source parameters are transferred to the
 * backend by structured clone and therefore cannot contain functions.
 */

import type { TypedNumberArray } from "#src/util/array.js";
import {
  DATA_TYPE_BYTES,
  DataType,
  makeDataTypeArrayView,
} from "#src/util/data_type.js";
import { convertEndian, Endianness } from "#src/util/endian.js";

export interface SourceDataType {
  readonly name: string;

  /**
   * Width of a single stored element, including all of its components.
   */
  readonly bitsPerElement: number;

  /**
   * Representation used for rendering.
   */
  readonly dataType: DataType;

  /**
   * Number of `dataType` values produced per stored element. Values greater than 1 require the
   * caller to add a corresponding innermost dimension to the array.
   */
  readonly numComponents: number;

  /**
   * Whether the conversion to `dataType` loses information.
   */
  readonly lossy: boolean;

  /**
   * Converts `numElements` stored elements to `numElements * numComponents` values of `dataType`.
   * May return a view of `encoded` rather than a copy.
   */
  decode(
    encoded: Uint8Array<ArrayBuffer>,
    numElements: number,
    endianness: Endianness,
  ): TypedNumberArray<ArrayBuffer>;

  parseFillValue(value: unknown): number | bigint;
}

const registry = new Map<string, SourceDataType>();

function register(sourceDataType: SourceDataType) {
  registry.set(sourceDataType.name, sourceDataType);
}

export function getSourceDataType(name: string): SourceDataType {
  const sourceDataType = registry.get(name);
  if (sourceDataType === undefined) {
    throw new Error(`Unsupported data type: ${JSON.stringify(name)}`);
  }
  return sourceDataType;
}

/**
 * Returns the registry entry for a data type that is stored in its native representation.
 */
export function getNativeSourceDataType(dataType: DataType): SourceDataType {
  return getSourceDataType(DataType[dataType].toLowerCase());
}

export function encodedByteLength(
  sourceDataType: SourceDataType,
  numElements: number,
): number {
  return Math.ceil((numElements * sourceDataType.bitsPerElement) / 8);
}

function parseIntegerFillValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Expected integer but received: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseFloatFillValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    switch (value) {
      case "Infinity":
        return Number.POSITIVE_INFINITY;
      case "-Infinity":
        return Number.NEGATIVE_INFINITY;
      case "NaN":
        return Number.NaN;
    }
  }
  throw new Error(
    `Expected number, "Infinity", "-Infinity", or "NaN" but received: ${JSON.stringify(
      value,
    )}`,
  );
}

function registerNative(
  dataType: DataType,
  options: { name?: string; lossy?: boolean } = {},
) {
  const bytesPerElement = DATA_TYPE_BYTES[dataType];
  register({
    name: options.name ?? DataType[dataType].toLowerCase(),
    bitsPerElement: bytesPerElement * 8,
    dataType,
    numComponents: 1,
    lossy: options.lossy ?? false,
    decode(encoded, numElements, endianness) {
      numElements;
      const data = makeDataTypeArrayView(
        dataType,
        encoded.buffer,
        encoded.byteOffset,
        encoded.byteLength,
      ) as TypedNumberArray<ArrayBuffer>;
      convertEndian(data, endianness, bytesPerElement);
      return data;
    },
    parseFillValue(value) {
      if (dataType === DataType.FLOAT32) {
        if (typeof value === "string" && value.match(/^0x[a-fA-F0-9]+$/)) {
          return new Float32Array(Uint32Array.of(Number(value)).buffer)[0];
        }
        return parseFloatFillValue(value);
      }
      const integerValue = parseIntegerFillValue(value);
      if (dataType === DataType.UINT64) {
        return BigInt(integerValue);
      }
      return integerValue;
    },
  });
}

registerNative(DataType.UINT8);
registerNative(DataType.INT8);
registerNative(DataType.UINT16);
registerNative(DataType.INT16);
registerNative(DataType.UINT32);
registerNative(DataType.INT32);
registerNative(DataType.UINT64);
registerNative(DataType.FLOAT32);

// Signed 64-bit integers are reinterpreted as unsigned; negative values display incorrectly.
registerNative(DataType.UINT64, { name: "int64", lossy: true });

register({
  name: "float64",
  bitsPerElement: 64,
  dataType: DataType.FLOAT32,
  numComponents: 1,
  lossy: true,
  decode(encoded, numElements, endianness) {
    const littleEndian = endianness === Endianness.LITTLE;
    const dv = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength,
    );
    const data = new Float32Array(numElements);
    for (let i = 0; i < numElements; ++i) {
      data[i] = dv.getFloat64(i * 8, littleEndian);
    }
    return data;
  },
  parseFillValue(value) {
    if (typeof value === "string" && value.match(/^0x[a-fA-F0-9]+$/)) {
      const buffer = new ArrayBuffer(8);
      const dv = new DataView(buffer);
      dv.setBigUint64(0, BigInt(value), true);
      return dv.getFloat64(0, true);
    }
    return parseFloatFillValue(value);
  },
});

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

function float16ToFloat32(h: number): number {
  const sign = (h & 0x8000) << 16;
  const exponent = (h >>> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  if (exponent === 0x1f) {
    // Infinity or NaN.
    u32Scratch[0] = sign | 0x7f800000 | (mantissa << 13);
  } else if (exponent === 0) {
    if (mantissa === 0) {
      u32Scratch[0] = sign;
    } else {
      // Subnormal as float16, normal as float32.
      const shift = 31 - Math.clz32(mantissa);
      u32Scratch[0] =
        sign |
        ((shift + 103) << 23) |
        ((mantissa - (1 << shift)) << (23 - shift));
    }
  } else {
    u32Scratch[0] = sign | ((exponent + 112) << 23) | (mantissa << 13);
  }
  return f32Scratch[0];
}

function bfloat16ToFloat32(h: number): number {
  u32Scratch[0] = h << 16;
  return f32Scratch[0];
}

function registerHalf(name: string, convert: (h: number) => number) {
  register({
    name,
    bitsPerElement: 16,
    dataType: DataType.FLOAT32,
    numComponents: 1,
    lossy: false,
    decode(encoded, numElements, endianness) {
      const littleEndian = endianness === Endianness.LITTLE;
      const dv = new DataView(
        encoded.buffer,
        encoded.byteOffset,
        encoded.byteLength,
      );
      const data = new Float32Array(numElements);
      for (let i = 0; i < numElements; ++i) {
        data[i] = convert(dv.getUint16(i * 2, littleEndian));
      }
      return data;
    },
    parseFillValue(value) {
      if (typeof value === "string" && value.match(/^0x[a-fA-F0-9]+$/)) {
        return convert(Number(value));
      }
      return parseFloatFillValue(value);
    },
  });
}

registerHalf("float16", float16ToFloat32);
registerHalf("bfloat16", bfloat16ToFloat32);
