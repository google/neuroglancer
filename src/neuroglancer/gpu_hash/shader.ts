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

import {HashFunction, PRIME_MODULUS} from 'neuroglancer/gpu_hash/hash_function';
import {HashTable, NUM_ALTERNATIVES} from 'neuroglancer/gpu_hash/hash_table';
import {RefCounted} from 'neuroglancer/util/disposable';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_exactDot, glsl_imod, glsl_uint64} from 'neuroglancer/webgl/shader_lib';
import {setRawTextureParameters} from 'neuroglancer/webgl/texture';

export const glsl_hashFunction = [
  glsl_uint64, glsl_exactDot, glsl_imod, `
float computeHash(uint64_t x, vec4 a0, vec4 a1, float b, float c, float modulus, float scalar) {
  x.low *= 255.0;
  x.high *= 255.0;
  float dotResult = imod(exactDot(a0, x.low) + exactDot(a1, x.high), modulus);
  float dotResult2 = imod(dotResult * dotResult, modulus);
  float y = imod(dotResult2 * c, modulus);
  float modResult = imod(dotResult + y + b, modulus);
  return fract(modResult * scalar);
}
`
];

export class GPUHashTable extends RefCounted {
  a: Float32Array;
  b: Float32Array;
  hashFunctions: HashFunction[][]|null = null;
  generation = -1;
  textures = new Array<WebGLTexture|null>();

  constructor(public gl: GL, public hashTable: HashTable) {
    super();
    let numAlternatives = hashTable.hashFunctions.length;
    this.a = new Float32Array(4 * (numAlternatives * 4));
    this.b = new Float32Array(numAlternatives * 4 + 5);
    let {textures} = this;
    for (let i = 0; i < numAlternatives; ++i) {
      // createTexture should never actually return null.
      textures[i] = gl.createTexture();
    }
  }

  computeCoefficients() {
    let {hashTable} = this;
    let hashFunctions = hashTable.hashFunctions;
    if (this.hashFunctions === hashFunctions) {
      return;
    }
    this.hashFunctions = hashFunctions;
    let {a, b} = this;
    let numAlternatives = hashFunctions.length;
    let {width, height} = hashTable;
    let scalar = [1.0 / width, 1.0 / height];
    for (let i = 0; i < 2; ++i) {
      b[numAlternatives * 4 + i] = PRIME_MODULUS;
      b[numAlternatives * 4 + 3 + i] = scalar[i];
    }
    b[numAlternatives * 4 + 2] = 1 / (2 * width);
    for (let alt = 0; alt < numAlternatives; ++alt) {
      let curFunctions = hashFunctions[alt];
      for (let i = 0; i < 2; ++i) {
        let h = curFunctions[i];
        let bIndex = alt * 4 + 2 * i;
        let aIndex = 4 * (alt * 4 + 2 * i);
        // Add 0.5 to b to give maximum margin of error.
        //
        // For the x coordinate (i == 0), since each position is used to address two texels (for the
        // low and high uint32 values), we only add 0.25.
        b[bIndex] = h.b + (i === 0 ? 0.25 : 0.5);
        b[bIndex + 1] = h.c;
        for (let j = 0; j < 4; ++j) {
          a[aIndex + j] = h.a0[j];
          a[aIndex + 4 + j] = h.a1[j];
        }
      }
    }
  }


  copyToGPU() {
    this.computeCoefficients();
    let {hashTable} = this;
    let {generation} = hashTable;
    if (this.generation === generation) {
      return;
    }
    this.generation = generation;
    let {width, height, tables} = hashTable;
    let {gl, textures} = this;
    let numAlternatives = textures.length;
    gl.activeTexture(gl.TEXTURE0 + gl.tempTextureUnit);
    for (let alt = 0; alt < numAlternatives; ++alt) {
      gl.bindTexture(gl.TEXTURE_2D, textures[alt]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      setRawTextureParameters(gl);

      const format = gl.RGBA;

      gl.texImage2D(
          gl.TEXTURE_2D,
          /*level=*/0, format,
          /*width=*/width * 2,
          /*height=*/height,
          /*border=*/0, format, gl.UNSIGNED_BYTE, new Uint8Array(tables[alt].buffer));
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  disposed() {
    let {gl} = this;
    this.textures.forEach((texture) => { gl.deleteTexture(texture); });
    this.textures = <any>undefined;
    this.gl = <any>undefined;
    this.hashTable = <any>undefined;
    this.hashFunctions = null;
  }

  static get(gl: GL, hashTable: HashTable) {
    return gl.memoize.get(hashTable, () => new GPUHashTable(gl, hashTable));
  }
};

export class HashTableShaderManager {
  textureUnitSymbol = Symbol('gpuhashtable:' + this.prefix);
  aName = this.prefix + '_a';
  bName = this.prefix + '_b';
  samplerName = this.prefix + '_sampler';

  constructor(public prefix: string, public numAlternatives = NUM_ALTERNATIVES) {}

  defineShader(builder: ShaderBuilder) {
    let {aName, bName, samplerName, numAlternatives} = this;
    builder.addUniform('highp vec4', aName, numAlternatives * 4);
    builder.addUniform('highp float', bName, numAlternatives * 4 + 5);
    builder.addTextureSampler2D(samplerName, this.textureUnitSymbol, numAlternatives);
    builder.addFragmentCode(glsl_hashFunction);
    let s = '';
    for (let alt = 0; alt < numAlternatives; ++alt) {
      for (let i = 0; i < 2; ++i) {
        let bIndex = alt * 4 + 2 * i;
        let aIndex = alt * 4 + 2 * i;
        s += `
float ${this.prefix}_computeHash_${alt}_${i}(uint64_t x) {
  float primeModulus = ${bName}[${numAlternatives * 4 + i}];
  float scalar = ${bName}[${numAlternatives * 4 + 3 + i}];
  return computeHash(x, ${aName}[${aIndex}], ${aName}[${aIndex + 1}], ${bName}[${bIndex}], ${bName}[${bIndex + 1}], primeModulus, scalar);
}
`;
      }
      s += `
vec2 ${this.prefix}_computeHash_${alt}(uint64_t x) {
  vec2 v;
  v[0] = ${this.prefix}_computeHash_${alt}_0(x);
  v[1] = ${this.prefix}_computeHash_${alt}_1(x);
  return v;
}
`;
    }
    s += `
bool ${this.hasFunctionName}(uint64_t x) {
  float highOffset = ${bName}[${numAlternatives * 4 + 2}];
`;
    for (let alt = 0; alt < numAlternatives; ++alt) {
      s += `
  {
    vec2 v = ${this.prefix}_computeHash_${alt}(x);
    vec4 lowResult = texture2D(${samplerName}[${alt}], v);
    vec4 highResult = texture2D(${samplerName}[${alt}], vec2(v.x + highOffset, v.y));
    if (lowResult == x.low && highResult == x.high) {
      return true;
    }
  }
`;
    }
    s += `
  return false;
}
`;
    builder.addFragmentCode(s);
  }

  get hasFunctionName() { return `${this.prefix}_has`; }

  enable(gl: GL, shader: ShaderProgram, hashTable: GPUHashTable) {
    let {numAlternatives} = this;
    let {textures} = hashTable;
    hashTable.copyToGPU();
    let textureUnit = shader.textureUnit(this.textureUnitSymbol);
    for (let alt = 0; alt < numAlternatives; ++alt) {
      let unit = alt + textureUnit;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[alt]);
    }
    gl.uniform4fv(shader.uniform(this.aName), hashTable.a);
    gl.uniform1fv(shader.uniform(this.bName), hashTable.b);
  }

  disable(gl: GL, shader: ShaderProgram) {
    let {numAlternatives} = this;
    let textureUnit = shader.textureUnit(this.textureUnitSymbol);
    for (let alt = 0; alt < numAlternatives; ++alt) {
      let unit = alt + textureUnit;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
};
