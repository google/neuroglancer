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

import {DATA_TYPE_BYTES, DATA_TYPE_SIGNED, DataType} from 'neuroglancer/util/data_type';
import {AttributeIndex, ShaderBuilder, ShaderCodePart} from 'neuroglancer/webgl/shader';

export const glsl_mixLinear = `
float mixLinear(float x, float y, float a) { return mix(x, y, a); }
`;

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
uint64_t mixLinear(uint64_t x, uint64_t y, float a) {
  return x;
}
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
`
];

export const glsl_equalUint64 = [
  glsl_uint64, `
bool equals(uint64_t a, uint64_t b) {
  return a.value == b.value;
}
`
];

export const glsl_compareLessThanUint64 = [
  glsl_uint64, `
bool compareLessThan(uint64_t a, uint64_t b) {
  return (a.value[1] < b.value[1])||
         (a.value[1] == b.value[1] && a.value[0] < b.value[0]);
}
`
];

export const glsl_subtractUint64 = [
  glsl_uint64, `
uint64_t subtract(uint64_t a, uint64_t b) {
  if (a.value[0] < b.value[0]) {
    --a.value[1];
  }
  a.value -= b.value;
  return a;
}
`
];

export const glsl_addUint64 = [
  glsl_uint64, `
uint64_t add(uint64_t a, uint64_t b) {
  a.value[0] += b.value[0];
  if (a.value[0] < b.value[0]) {
    ++a.value[1];
  }
  a.value[1] += b.value[1];
  return a;
}
`
];

export const glsl_addSaturateUint64 = [
  glsl_addUint64, glsl_compareLessThanUint64, `
uint64_t addSaturate(uint64_t a, uint64_t b) {
  a = add(a, b);
  if (compareLessThan(a, b)) {
    a.value = uvec2(0xffffffffu, 0xffffffffu);
  }
  return a;
}
`
];

export const glsl_subtractSaturateUint64 = [
  glsl_subtractUint64, glsl_compareLessThanUint64, `
uint64_t subtractSaturate(uint64_t a, uint64_t b) {
  b = subtract(a, b);
  if (compareLessThan(a, b)) {
    b.value = uvec2(0u, 0u);
  }
  return b;
}
`
];

export const glsl_shiftRightUint64 = [
  glsl_uint64, `
uint64_t shiftRight(uint64_t a, int shift) {
  if (shift >= 32) {
    return uint64_t(uvec2(a.value[1] >> (shift - 32), 0u));
  } else if (shift == 0) {
    return a;
  } else {
    return uint64_t(uvec2((a.value[0] >> shift) | (a.value[1] << (32 - shift)), a.value[1] >> shift));
  }
}
`
];

export const glsl_shiftLeftUint64 = [
  glsl_uint64, `
uint64_t shiftLeft(uint64_t a, int shift) {
  if (shift >= 32) {
    return uint64_t(uvec2(0u, a.value[0] << (shift - 32)));
  } else if (shift == 0) {
    return a;
  } else {
    return uint64_t(uvec2(a.value[0] << shift, (a.value[1] << shift) | (a.value[0] >> (32 - shift))));
  }
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
uint8_t mixLinear(uint8_t x, uint8_t y, highp float a) {
  return uint8_t(uint(round(mix(float(x.value), float(y.value), a))));
}
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
uint8_t uint8FromFloat(highp float x) {
  return uint8_t(uint(clamp(x, 0.0, 255.0)));
}
`
];


export const glsl_int8 = [
  glsl_uint64, `
struct int8_t {
  highp int value;
};
struct int8x2_t {
  highp ivec2 value;
};
struct int8x3_t {
  highp ivec3 value;
};
struct int8x4_t {
  highp ivec4 value;
};
int8_t mixLinear(int8_t x, int8_t y, highp float a) {
  return int8_t(int(round(mix(float(x.value), float(y.value), a))));
}
highp int toRaw(int8_t x) { return x.value; }
highp ivec2 toRaw(int8x2_t x) { return x.value; }
highp ivec3 toRaw(int8x3_t x) { return x.value; }
highp ivec4 toRaw(int8x4_t x) { return x.value; }
uint64_t toUint64(int8_t x) {
  uint64_t result;
  result.value[0] = uint(x.value);
  result.value[1] = uint(x.value >> 31);
  return result;
}
int8_t int8FromFloat(highp float x) {
  return int8_t(int(clamp(x, -128.0, 127.0)));
}
`
];


export const glsl_float = `
highp float toRaw(highp float x) { return x; }
highp float toNormalized(highp float x) { return x; }
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
uint16_t mixLinear(uint16_t x, uint16_t y, highp float a) {
  return uint16_t(uint(round(mix(float(x.value), float(y.value), a))));
}
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
uint16_t uint16FromFloat(highp float x) {
  return uint16_t(uint(clamp(x, 0.0, 65535.0)));
}
`
];

export const glsl_int16 = [
  glsl_uint64, `
struct int16_t {
  highp int value;
};
struct int16x2_t {
  highp ivec2 value;
};
int16_t mixLinear(int16_t x, int16_t y, highp float a) {
  return int16_t(int(round(mix(float(x.value), float(y.value), a))));
}
highp int toRaw(int16_t x) { return x.value; }
highp ivec2 toRaw(int16x2_t x) { return x.value; }
uint64_t toUint64(int16_t x) {
  uint64_t result;
  result.value[0] = uint(x.value);
  result.value[1] = uint(x.value >> 31);
  return result;
}
int16_t int16FromFloat(highp float x) {
  return int16_t(int(clamp(x, -32768.0, 32767.0)));
}
`
];

export const glsl_uint32 = [
  glsl_uint64, `
struct uint32_t {
  highp uint value;
};
uint32_t mixLinear(uint32_t x, uint32_t y, highp float a) {
  return uint32_t(uint(round(mix(float(x.value), float(y.value), a))));
}
highp float toNormalized(uint32_t x) { return float(x.value) / 4294967295.0; }
highp uint toRaw(uint32_t x) { return x.value; }
uint64_t toUint64(uint32_t x) {
  uint64_t result;
  result.value[0] = x.value;
  result.value[1] = 0u;
  return result;
}
uint32_t uint32FromFloat(highp float x) {
  return uint32_t(uint(clamp(x, 0.0, 4294967295.0)));
}
`
];

export const glsl_int32 = [
  glsl_uint64, `
struct int32_t {
  highp int value;
};
int32_t mixLinear(int32_t x, int32_t y, highp float a) {
  return int32_t(int(round(mix(float(x.value), float(y.value), a))));
}
highp int toRaw(int32_t x) { return x.value; }
uint64_t toUint64(int32_t x) {
  uint64_t result;
  result.value[0] = uint(x.value);
  result.value[1] = uint(x.value >> 31);
  return result;
}
int32_t int32FromFloat(highp float x) {
  return int32_t(int(clamp(x, 2147483648.0, 2147483647.0)));
}
`
];

export var glsl_getFortranOrderIndex = `
highp int getFortranOrderIndex(ivec3 subscripts, ivec3 size) {
  return subscripts.x + size.x * (subscripts.y + size.y * subscripts.z);
}
`;

export const glsl_log2Exact = `
highp uint log2Exact(highp uint i) {
  highp uint r;
  r = uint((i & 0xAAAAAAAAu) != 0u);
  r |= uint((i & 0xFFFF0000u) != 0u) << 4;
  r |= uint((i & 0xFF00FF00u) != 0u) << 3;
  r |= uint((i & 0xF0F0F0F0u) != 0u) << 2;
  r |= uint((i & 0xCCCCCCCCu) != 0u) << 1;
  return r;
}
`;

// Clip line endpoints to the OpenGL viewing volume depth range.
// https://www.khronos.org/opengl/wiki/Vertex_Post-Processing#Clipping
//
// This is similar to the clipping that the OpenGL implementation itself would do for lines, except
// that we only clip based on `z`.
export const glsl_clipLineToDepthRange = `
bool clipLineToDepthRange(inout highp vec4 a, inout highp vec4 b) {
  highp float tmin = 0.0, tmax = 1.0;
  highp float k1 = b.w - a.w + a.z - b.z;
  highp float k2 = a.w - b.w + a.z - b.z;
  highp float q1 = (a.z - a.w) / k1;
  highp float q2 = (a.z + a.w) / k2;
  if (k1 > 0.0) tmin = max(tmin, q1);
  else if (k1 < 0.0) tmax = min(tmax, q1);
  if (k2 > 0.0) tmax = min(tmax, q2);
  else if (k2 < 0.0) tmin = max(tmin, q2);
  if (tmin <= tmax) {
    highp vec4 tempA = a;
    highp vec4 tempB = b;
    a = mix(tempA, tempB, tmin);
    b = mix(tempA, tempB, tmax);
    return true;
  }
  return false;
}
`;

// https://stackoverflow.com/questions/4200224/random-noise-functions-for-glsl
export const glsl_simpleFloatHash = `
highp float simpleFloatHash(highp vec2 co) {
    return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
}
`;

export const glsl_shiftLeftSaturateUint32 = `
highp uint shiftLeftSaturate(highp uint x, int shiftAmount) {
  highp uint result = x << shiftAmount;
  if ((result >> shiftAmount) != x) return 0xffffffffu;
  return result;
}
`;

export const glsl_addSaturateUint32 = `
highp uint addSaturate(highp uint x, highp uint y) {
  highp uint result = x + y;
  if (result < x) return 0xffffffffu;
  return result;
}
`;

export const glsl_subtractSaturateUint32 = `
highp uint subtractSaturate(highp uint x, highp uint y) {
  highp uint result = x - y;
  if (result > x) return 0u;
  return result;
}
`;

export const glsl_addSaturateInt32 = [
  glsl_addSaturateUint32, `
highp int addSaturate(highp int x, highp uint y) {
  if (x >= 0) {
    return int(min(addSaturate(y, uint(x)), 0x7fffffffu));
  } else if (y >= uint(-x)) {
    return int(min(y - uint(-x), 0x7fffffffu));
  } else {
    return -int(min(uint(-x) - y, 0x80000000u));
  }
}
`
];

export const glsl_subtractSaturateInt32 = [
  glsl_addSaturateUint32, `
highp int subtractSaturate(highp int x, highp uint y) {
  if (x < 0) {
    return -int(min(addSaturate(uint(-x), uint(y)), 0x80000000u));
  } else if (uint(x) >= y) {
    return x - int(y);
  } else {
    return -int(min(y - uint(x), 0x80000000u));
  }
}
`
];

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
    case DataType.INT8:
    case DataType.UINT16:
    case DataType.INT16:
    case DataType.UINT32:
    case DataType.INT32:
    case DataType.UINT64: {
      const prefix = DATA_TYPE_SIGNED[dataType] ? '' : 'u';
      const bits = DATA_TYPE_BYTES[dataType] * 8;
      if (numComponents === 1) {
        return `${prefix}int${bits}_t`;
      }
      if (numComponents > 1 && numComponents * bits <= 32) {
        return `${prefix}int${bits}x${numComponents}_t`;
      }
      break;
    }
  }
  throw new Error(`No shader type for ${DataType[dataType]}[${numComponents}].`);
}

export const dataTypeShaderDefinition: Record<DataType, ShaderCodePart> = {
  [DataType.UINT8]: glsl_uint8,
  [DataType.INT8]: glsl_int8,
  [DataType.UINT16]: glsl_uint16,
  [DataType.INT16]: glsl_int16,
  [DataType.UINT32]: glsl_uint32,
  [DataType.INT32]: glsl_int32,
  [DataType.UINT64]: glsl_uint64,
  [DataType.FLOAT32]: glsl_float,
};

export function getShaderVectorType(typeName: 'float'|'int'|'uint', n: number) {
  if (n === 1) return typeName;
  if (typeName === 'float') return `vec${n}`;
  return `${typeName[0]}vec${n}`;
}

export const webglTypeSizeInBytes: {[webglType: number]: number} = {
  [WebGL2RenderingContext.UNSIGNED_BYTE]: 1,
  [WebGL2RenderingContext.BYTE]: 1,
  [WebGL2RenderingContext.UNSIGNED_SHORT]: 2,
  [WebGL2RenderingContext.SHORT]: 2,
  [WebGL2RenderingContext.FLOAT]: 4,
  [WebGL2RenderingContext.INT]: 4,
  [WebGL2RenderingContext.UNSIGNED_INT]: 4,
};

export function defineVectorArrayVertexShaderInput(
    builder: ShaderBuilder, typeName: 'float'|'int'|'uint', attributeType: number,
    normalized: boolean, name: string, vectorRank: number, arraySize: number = 1) {
  let numAttributes = 0;
  let n = vectorRank * arraySize;
  while (n > 0) {
    const components = Math.min(4, n);
    const t = getShaderVectorType(typeName, components);
    n -= components;
    builder.addAttribute('highp ' + t, `a${name}${numAttributes}`);
    ++numAttributes;
  }
  n = vectorRank * arraySize;
  let code = '';
  for (let arrayIndex = 0; arrayIndex < arraySize; ++arrayIndex) {
    code += `highp ${typeName}[${vectorRank}] get${name}${arrayIndex}() {
  highp ${typeName}[${vectorRank}] result;
`;
    for (let vectorIndex = 0; vectorIndex < vectorRank; ++vectorIndex) {
      const i = arrayIndex * vectorRank + vectorIndex;
      const attributeIndex = Math.floor(i / 4);
      const componentIndex = i % 4;
      code += `  result[${vectorIndex}] = a${name}${attributeIndex}`;
      if (componentIndex !== 0 || i !== n - 1) {
        code += `[${componentIndex}]`;
      }
      code += `;\n`;
    }
    code += `  return result;\n`;
    code += `}\n`;
  }
  builder.addVertexCode(code);
  const elementSize = webglTypeSizeInBytes[attributeType];
  builder.addInitializer(shader => {
    const locations: AttributeIndex[] = [];
    for (let attributeIndex = 0; attributeIndex < numAttributes; ++attributeIndex) {
      locations[attributeIndex] = shader.attribute(`a${name}${attributeIndex}`);
    }
    shader.vertexShaderInputBinders[name] = {
      enable(divisor: number) {
        const {gl} = shader;
        for (let attributeIndex = 0; attributeIndex < numAttributes; ++attributeIndex) {
          const location = locations[attributeIndex];
          gl.enableVertexAttribArray(location);
          gl.vertexAttribDivisor(location, divisor);
        }
      },
      disable() {
        const {gl} = shader;
        for (let attributeIndex = 0; attributeIndex < numAttributes; ++attributeIndex) {
          const location = locations[attributeIndex];
          gl.vertexAttribDivisor(location, 0);
          gl.disableVertexAttribArray(location);
        }
      },
      bind(stride: number, offset: number) {
        const {gl} = shader;
        for (let attributeIndex = 0; attributeIndex < numAttributes; ++attributeIndex) {
          const location = locations[attributeIndex];
          const numComponents = Math.min(4, n - 4 * attributeIndex);
          if (typeName === 'float') {
            gl.vertexAttribPointer(
                location, /*size=*/ numComponents, attributeType, normalized, stride, offset);
          } else {
            gl.vertexAttribIPointer(
                location, /*size=*/ Math.min(4, n - 4 * attributeIndex), attributeType, stride,
                offset);
          }
          offset += elementSize * numComponents;
        }
      },
    };
  });
}
