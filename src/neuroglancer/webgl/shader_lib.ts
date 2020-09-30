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
import {AttributeIndex, ShaderBuilder} from 'neuroglancer/webgl/shader';

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
`];

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
uint8_t mixLinear(uint8_t x, uint8_t y, float a) {
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
`
];


export const glsl_int8 = `
struct int8_t {
  highp uint value;
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
int8_t mixLinear(int8_t x, int8_t y, float a) {
  return int8_t(int(round(mix(float(x.value), float(y.value), a))));
}
highp int toRaw(int8_t x) { return x.value; }
highp ivec2 toRaw(int8x2_t x) { return x.value; }
highp ivec3 toRaw(int8x3_t x) { return x.value; }
highp ivec4 toRaw(int8x4_t x) { return x.value; }
`;


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
uint16_t mixLinear(uint16_t x, uint16_t y, float a) {
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
`
];

export const glsl_int16 = `
struct int16_t {
  highp int value;
};
struct int16x2_t {
  highp ivec2 value;
};
int16_t mixLinear(int16_t x, int16_t y, float a) {
  return int16_t(int(round(mix(float(x.value), float(y.value), a))));
}
highp int toRaw(int16_t x) { return x.value; }
highp ivec2 toRaw(int16x2_t x) { return x.value; }
`;

export const glsl_uint32 = [
  glsl_uint64, `
struct uint32_t {
  highp uint value;
};
uint32_t mixLinear(uint32_t x, uint32_t y, float a) {
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
`
];

export const glsl_int32 = `
struct int32_t {
  highp int value;
};
int32_t mixLinear(int32_t x, int32_t y, float a) {
  return int32_t(int(round(mix(float(x.value), float(y.value), a))));
}
highp int toRaw(int32_t x) { return x.value; }
`;

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
bool clipLineToDepthRange(inout vec4 a, inout vec4 b) {
  float tmin = 0.0, tmax = 1.0;
  float k1 = b.w - a.w + a.z - b.z;
  float k2 = a.w - b.w + a.z - b.z;
  float q1 = (a.z - a.w) / k1;
  float q2 = (a.z + a.w) / k2;
  if (k1 > 0.0) tmin = max(tmin, q1);
  else if (k1 < 0.0) tmax = min(tmax, q1);
  if (k2 > 0.0) tmax = min(tmax, q2);
  else if (k2 < 0.0) tmin = max(tmin, q2);
  if (tmin <= tmax) {
    vec4 tempA = a;
    vec4 tempB = b;
    a = mix(tempA, tempB, tmin);
    b = mix(tempA, tempB, tmax);
    return true;
  }
  return false;
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
