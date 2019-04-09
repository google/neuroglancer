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

export const glsl_uint64 = `
struct uint64_t {
  highp uvec2 value;
};
struct uint64x2_t {
  highp uvec4 value;
};
uint64_t toUint64(uint64_t x) { return x; }
`;

export const glsl_unpackUint64leFromUint32 = [
  glsl_uint64, `
uint64_t unpackUint64leFromUint32(highp uvec2 x) {
  uint64_t result;
  result.value = x;
  return result;
}
uint64x2_t unpackUint64leFromUint32(highp uvec4 x) {
  uint64x2_t result;
  result.value = x;
  return result;
}
`];

export const glsl_equalUint64 = [
  glsl_uint64, `
bool equals(uint64_t a, uint64_t b) {
  return a.value == b.value;
}
`
];

export const glsl_uint8 = [
  glsl_uint64, `
struct uint8_t {
  highp uint value;
};
struct uint8x2_t {
  highp uvec2 value;
};
struct uint8x3_t {
  highp uvec3 value;
};
struct uint8x4_t {
  highp uvec4 value;
};
highp uint toRaw(uint8_t x) { return x.value; }
highp float toNormalized(uint8_t x) { return float(x.value) / 255.0; }
highp uvec2 toRaw(uint8x2_t x) { return x.value; }
highp vec2 toNormalized(uint8x2_t x) { return vec2(x.value) / 255.0; }
highp uvec3 toRaw(uint8x3_t x) { return x.value; }
vec3 toNormalized(uint8x3_t x) { return vec3(x.value) / 255.0; }
highp uvec4 toRaw(uint8x4_t x) { return x.value; }
vec4 toNormalized(uint8x4_t x) { return vec4(x.value) / 255.0; }
uint64_t toUint64(uint8_t x) {
  uint64_t result;
  result.value[0] = x.value;
  result.value[1] = 0u;
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
  glsl_uint64, `
struct uint16_t {
  highp uint value;
};
struct uint16x2_t {
  highp uvec2 value;
};
highp uint toRaw(uint16_t x) { return x.value; }
highp float toNormalized(uint16_t x) { return float(toRaw(x)) / 65535.0; }
highp uvec2 toRaw(uint16x2_t x) { return x.value; }
highp vec2 toNormalized(uint16x2_t x) { return vec2(toRaw(x)) / 65535.0; }
uint64_t toUint64(uint16_t x) {
  uint64_t result;
  result.value[0] = x.value;
  result.value[1] = 0u;
  return result;
}
`
];

export const glsl_uint32 = [
  glsl_uint64, `
struct uint32_t {
  highp uint value;
};
highp float toNormalized(uint32_t x) { return float(x.value) / 4294967295.0; }
highp uint toRaw(uint32_t x) { return x.value; }
uint64_t toUint64(uint32_t x) {
  uint64_t result;
  result.value[0] = x.value;
  result.value[1] = 0u;
  return result;
}
`
];

export var glsl_getFortranOrderIndex = `
highp int getFortranOrderIndex(ivec3 subscripts, ivec3 size) {
  return subscripts.x + size.x * (subscripts.y + size.y * subscripts.z);
}
`;

export function getShaderType(dataType: DataType, numComponents: number = 1) {
  switch (dataType) {
    case DataType.FLOAT32:
      if (numComponents === 1) {
        return 'float';
      }
      if (numComponents > 1 && numComponents <= 4) {
        return `vec${numComponents}`;
      }
      break;
    case DataType.UINT8:
      if (numComponents === 1) {
        return 'uint8_t';
      }
      if (numComponents > 1 && numComponents <= 4) {
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
