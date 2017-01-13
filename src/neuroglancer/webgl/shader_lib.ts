/**
 * @license
 * Copyright 2016 Google Inc.
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

import {DataType} from 'neuroglancer/util/data_type';
import {Endianness, ENDIANNESS} from 'neuroglancer/util/endian';


/**
 * GLSL function for converting a float in [0,1) to 32-bit little endian fixed point representation
 * (encoded as a vector of four floats in [0,1]).  This is fast but may not be completely accurate.
 * For a slower function that handles the full floating point finite range, use glsl_packFloat.
 */
export var glsl_packFloat01ToFixedPoint = `
vec4 packFloat01ToFixedPoint(const float value) {
  const vec4 shift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
  const vec4 mask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
  vec4 result = fract(value * shift);
  result -= result.xxyz * mask;
  return result * 256.0 / 255.0;
}
`;

export function unpackFloat01FromFixedPoint(data: Uint8Array) {
  return (data[3] + data[2] * (1.0 / 256.0) + data[1] * (1.0 / 65536.0) +
          data[0] * (1.0 / 16777216.0)) /
      256.0;
}

// Hue, saturation, and value are in [0, 1] range.
export var glsl_hsvToRgb = `
vec3 hueToRgb(float hue) {
  float hue6 = hue * 6.0;
  float r = abs(hue6 - 3.0) - 1.0;
  float g = 2.0 - abs(hue6 - 2.0);
  float b = 2.0 - abs(hue6 - 4.0);
  return clamp(vec3(r, g, b), 0.0, 1.0);
}
vec3 hsvToRgb(vec3 c) {
  vec3 hueRgb = hueToRgb(c.x);
  return c.z * ((hueRgb - 1.0) * c.y + 1.0);
}
`;

/**
 * Converts a float value containing a uint8 value normalized to [0, 1] (by dividing by 255) back to
 * an integer in [0, 255] (but still stored as a float).  The rounding is needed because on certain
 * graphics hardware, in particular Intel HD Graphics 4000, the normalization done by the texture
 * system is not exactly reversed by multiplying by 255.
 */
export const glsl_unnormalizeUint8 = ['float', 'vec2', 'vec3', 'vec4']
                                         .map(t => `
${t} unnormalizeUint8(${t} value) {
  return floor(value * 255.0 + 0.5);
}
`).join('');


/**
 * Converts a little-endian or big-endian integer value encoded as a normalized float, vec2, vec3 or
 * vec4 to an integer stored in a float.
 */
export const glsl_uintleToFloat = [
  glsl_unnormalizeUint8, `
float uintleToFloat(float v) {
  return unnormalizeUint8(v);
}
float uintleToFloat(vec2 v) {
  v = unnormalizeUint8(v);
  return v.x + v.y * 256.0;
}
float uintleToFloat(vec3 v) {
  v = unnormalizeUint8(v);
  return v.x + v.y * 256.0 + v.z * 256.0 * 256.0;
}
`
];

export const glsl_uintbeToFloat = [
  glsl_unnormalizeUint8, `
float uintbeToFloat(float v) {
  return unnormalizeUint8(v);
}
float uintbeToFloat(vec2 v) {
  v = unnormalizeUint8(v);
  return v.y + v.x * 256.0;
}
float uintbeToFloat(vec3 v) {
  v = unnormalizeUint8(v);
  return v.z + v.y * 256.0 + v.x * 256.0 * 256.0;
}
`
];

/**
 * Converts a native-endian integer value encoded as a float, vec2, vec3 or vec4 to an integer
 * stores as a float.
 */
export const glsl_uintToFloat = (() => {
  const suffix = ENDIANNESS === Endianness.BIG ? 'be' : 'le';
  return [
    ENDIANNESS === Endianness.BIG ? glsl_uintbeToFloat : glsl_uintleToFloat, `
float uintToFloat(float v) {
  return uint${suffix}ToFloat(v);
}
float uintToFloat(vec2 v) {
  return uint${suffix}ToFloat(v);
}
float uintToFloat(vec3 v) {
  return uint${suffix}ToFloat(v);
}
`
  ];
})();

export const glsl_uint64 = `
struct uint64_t {
  vec4 low, high;
};
uint64_t toUint64(uint64_t x) { return x; }
`;

export const glsl_uint8 = [
  glsl_unnormalizeUint8, glsl_uint64, `
struct uint8_t {
  float value;
};
struct uint8x2_t {
  vec2 value;
};
struct uint8x3_t {
  vec3 value;
};
struct uint8x4_t {
  vec4 value;
};
float toRaw(uint8_t x) { return unnormalizeUint8(x.value); }
float toNormalized(uint8_t x) { return x.value; }
vec2 toRaw(uint8x2_t x) { return unnormalizeUint8(x.value); }
vec2 toNormalized(uint8x2_t x) { return x.value; }
vec3 toRaw(uint8x3_t x) { return unnormalizeUint8(x.value); }
vec3 toNormalized(uint8x3_t x) { return x.value; }
vec4 toRaw(uint8x4_t x) { return unnormalizeUint8(x.value); }
vec4 toNormalized(uint8x4_t x) { return x.value; }
uint64_t toUint64(uint8_t x) {
  uint64_t result;
  result.low = vec4(x.value, 0.0, 0.0, 0.0);
  result.high = vec4(0.0, 0.0, 0.0, 0.0);
  return result;
}
`
];

export const glsl_float = `
float toRaw(float x) { return x; }
float toNormalized(float x) { return x; }
vec2 toRaw(vec2 x) { return x; }
vec2 toNormalized(vec2 x) { return x; }
vec3 toRaw(vec3 x) { return x; }
vec3 toNormalized(vec3 x) { return x; }
vec4 toRaw(vec4 x) { return x; }
vec4 toNormalized(vec4 x) { return x; }
`;

export const glsl_uint16 = [
  glsl_uint64, glsl_uintleToFloat, `
struct uint16_t {
  vec2 value;
};
struct uint16x2_t {
  vec4 value;
};
float toRaw(uint16_t x) { return uintleToFloat(x.value); }
float toNormalized(uint16_t x) { return toRaw(x) / 65535.0; }
vec2 toRaw(uint16x2_t x) { return vec2(uintleToFloat(x.value.xy), uintleToFloat(x.value.zw)); }
vec2 toNormalized(uint16x2_t x) { return toRaw(x) / 65535.0; }
uint64_t toUint64(uint16_t x) {
  uint64_t result;
  result.low = vec4(x.value, 0.0, 0.0);
  result.high = vec4(0.0, 0.0, 0.0, 0.0);
  return result;
}
`
];

export const glsl_uint32 = [
  glsl_uint64, `
struct uint32_t {
  vec4 value;
};
uint64_t toUint64(uint32_t x) {
  uint64_t result;
  result.low = x.value;
  result.high = vec4(0.0, 0.0, 0.0, 0.0);
  return result;
}
`
];

export var glsl_getSubscriptsFromNormalized = `
vec3 getSubscriptsFromNormalized(vec3 normalizedPosition, vec3 size) {
  return floor(min(normalizedPosition * size, size - 1.0));
}
`;

export var glsl_getFortranOrderIndex = `
float getFortranOrderIndex(vec3 subscripts, vec3 size) {
  return subscripts.x + size.x * (subscripts.y + size.y * subscripts.z);
}
`;

export var glsl_getFortranOrderIndexFromNormalized = [
  glsl_getSubscriptsFromNormalized, glsl_getFortranOrderIndex, `
float getFortranOrderIndexFromNormalized(vec3 normalizedPosition, vec3 size) {
  return getFortranOrderIndex(getSubscriptsFromNormalized(normalizedPosition, size), size);
}
`
];

export var glsl_imod = `
float imod(float x, float y) {
  return x - y * floor(x / y);
}
`;

// Chrome 49 on NVIDIA Quadro K600 gives inexact results when using the built-in dot function.
export var glsl_exactDot = `
float exactDot(vec4 a, vec4 b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}
float exactDot(vec3 a, vec3 b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
`;

export function fract(x: number) {
  return x - Math.floor(x);
}

export function step(edge: number, x: number) {
  return x < edge ? 0 : 1;
}

export function mod(x: number, y: number) {
  return x % y;
}

export function exp2(x: number) {
  return Math.pow(2, x);
}


/* WebGL 1.0 does not provide a convenient way to directly output float values from fragment
 * shaders; only 4-channel uint8 values (represented as floats in the range [0,1]) are supported.
 * Obtaining float values is particularly useful for debugging and unit testing.  This GLSL function
 * encodes a floating point value into a vector of 4 floats in the range [0,1] such that the
 * corresponding uint8 representation is the little endian IEEE 754 32-bit floating point format.
 *
 * Infinity and NaN values are not supported.  This function is not particularly efficient; it is
 * intended to be used only for debugging and testing.
 *
 * The GLSL function packFloatIntoVec4 is based on code posted to StackOverflow by user hrehfeld at
 * http://stackoverflow.com/a/14729074 and user Arjan at http://stackoverflow.com/a/11158534
 * licensed under CC BY-SA 3.0 ( http://creativecommons.org/licenses/by-sa/3.0/ ).
 */
export var glsl_packFloat = `
vec4 packFloatIntoVec4(float f) {
  float magnitude = abs(f); 
  if (magnitude == 0.0) {
     return vec4(0,0,0,0);
  }
  float sign =  step(0.0, -f);
  float exponent = floor(log2(magnitude)); 
  float mantissa = magnitude / exp2(exponent); 
  // Denormalized values if all exponent bits are zero
  if (mantissa < 1.0) {
     exponent -= 1.0;
  }

  exponent +=  127.0;

  vec4 result;
  result[3] = 128.0 * sign + floor(exponent / 2.0);
  result[2] = 128.0 * mod(exponent, 2.0) +  mod(floor(mantissa * float(128.0)),128.0);
  result[1] = floor( mod(floor(mantissa* exp2(float(23.0 - 8.0))), exp2(8.0)));
  result[0] = floor( exp2(23.0)* mod(mantissa, exp2(-15.0)));
  return result / 255.0;
}
`;

export var glsl_debugFunctions = [glsl_packFloat];

export function encodeBytesToFloat32(x: ArrayBufferView) {
  let xBytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  let length = xBytes.length;
  let result = new Float32Array(length);
  for (let i = 0; i < length; ++i) {
    result[i] = xBytes[i] / 255;
  }
  return result;
}

export function setVec4FromUint32(out: Float32Array, x: number) {
  for (let j = 0; j < 4; ++j) {
    out[j] = ((x >> (j * 8)) & 0xFF) / 255.0;
  }
  return out;
}

export function getUint32FromVec4(v: Float32Array): number {
  return v[0] * 255 + v[1] * 255 * 256 + v[2] * 255 * 256 * 256 + v[3] * 255 * 256 * 256 * 256;
}

export function getShaderType(dataType: DataType, numComponents: number = 1) {
  switch (dataType) {
    case DataType.FLOAT32:
      if (numComponents === 1) {
        return 'float';
      }
      if (numComponents > 1 && numComponents < 4) {
        return `vec${numComponents}`;
      }
      break;
    case DataType.UINT8:
      if (numComponents === 1) {
        return 'uint8_t';
      }
      if (numComponents > 1 && numComponents < 4) {
        return `uint8x${numComponents}_t`;
      }
      break;
    case DataType.UINT16:
      if (numComponents === 1) {
        return 'uint16_t';
      }
      if (numComponents === 2) {
        return `uint16x2_t`;
      }
      break;
    case DataType.UINT32:
      if (numComponents === 1) {
        return 'uint32_t';
      }
      break;
    case DataType.UINT64:
      if (numComponents === 1) {
        return 'uint64_t';
      }
      break;
  }
  throw new Error(`No shader type for ${DataType[dataType]}[${numComponents}].`);
}

export const glsl_addUint32 = [
  glsl_uint32, `
uint32_t add(uint32_t a, uint32_t b) {
  uint32_t result;
  float partial = 0.0;

  partial += a.value.x * 255.0 + b.value.x * 255.0;
  {
    float byte0 = mod(partial, 256.0);
    result.value.x = byte0 / 255.0;
    partial = (partial - byte0) / 256.0;
  }

  partial += a.value.y * 255.0 + b.value.y * 255.0;
  {
    float byte1 = mod(partial, 256.0);
    result.value.y = byte1 / 255.0;
    partial = (partial - byte1) / 256.0;
  }

  partial += a.value.z * 255.0 + b.value.z * 255.0;
  {
    float byte2 = mod(partial, 256.0);
    result.value.z = byte2 / 255.0;
    partial = (partial - byte2) / 256.0;
  }

  partial += a.value.w * 255.0 + b.value.w * 255.0;
  {
    float byte3 = mod(partial, 256.0);
    result.value.w = byte3 / 255.0;
    partial = (partial - byte3) / 256.0;
  }
  return result;
}
`
];

export const glsl_floatToUint32 = [
  glsl_uint32, `
uint32_t floatToUint32(float x) {
  uint32_t result;
  float v;
  
  v = mod(x, 256.0);
  result.x = v / 255.0;
  x = (x - v) / 256.0;

  v = mod(x, 256.0);
  result.y = v / 255.0;
  x = (x - v) / 256.0;

  v = mod(x, 256.0);
  result.z = v / 255.0;
  result.w = 0.0;
  
  return result;
}
`
];

/**
 * This requires that divisor is an integer and 0 < divisor < 2^16.
 */
export const glsl_divmodUint32 = [
  glsl_uint32, `
float divmod(uint32_t dividend, float divisor, out uint32_t quotient) {

  float partial = dividend.value.w * 255.0;
  float remainder;

  remainder = mod(partial, divisor);
  quotient.value.w = (partial - remainder) / divisor / 255.0;
  partial = remainder * 256.0 + dividend.value.z * 255.0;

  remainder = mod(partial, divisor);
  quotient.value.z = (partial - remainder) / divisor / 255.0;
  partial = remainder * 256.0 + dividend.value.y * 255.0;

  remainder = mod(partial, divisor);
  quotient.value.y = (partial - remainder) / divisor / 255.0;
  partial = remainder * 256.0 + dividend.value.x * 255.0;

  remainder = mod(partial, divisor);
  quotient.value.x = (partial - remainder) / divisor / 255.0;

  return remainder;
}
`
];
