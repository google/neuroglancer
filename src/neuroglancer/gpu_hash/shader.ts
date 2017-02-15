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
import {HashTableBase, NUM_ALTERNATIVES} from 'neuroglancer/gpu_hash/hash_table';
import {RefCounted} from 'neuroglancer/util/disposable';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_exactDot, glsl_imod, glsl_uint64, glsl_unnormalizeUint8} from 'neuroglancer/webgl/shader_lib';
import {setRawTextureParameters} from 'neuroglancer/webgl/texture';

export const glsl_hashFunction = [
  glsl_unnormalizeUint8, glsl_uint64, glsl_exactDot, glsl_imod, `
float computeHash(uint64_t x, vec4 a0, vec4 a1, float b, float c, float modulus, float scalar) {
  x.low = unnormalizeUint8(x.low);
  x.high = unnormalizeUint8(x.high);
  float dotResult = imod(exactDot(a0, x.low) + exactDot(a1, x.high), modulus);
  float dotResult2 = imod(dotResult * dotResult, modulus);
  float y = imod(dotResult2 * c, modulus);
  float modResult = imod(dotResult + y + b, modulus);
  return fract(modResult * scalar);
}
`
];

export class GPUHashTable<HashTable extends HashTableBase> extends RefCounted {
  a: Float32Array;
  b: Float32Array;
  hashFunctions: HashFunction[][]|null = null;
  generation = -1;
  texture: WebGLTexture|null = null;

  constructor(public gl: GL, public hashTable: HashTable) {
    super();
    let numAlternatives = hashTable.hashFunctions.length;
    this.a = new Float32Array(4 * (numAlternatives * 4));
    this.b = new Float32Array(numAlternatives * 4 + 5);
    // createTexture should never actually return null.
    this.texture = gl.createTexture();
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
    b[numAlternatives * 4 + 2] = 1 / (hashTable.entryStride * width);
    for (let alt = 0; alt < numAlternatives; ++alt) {
      let curFunctions = hashFunctions[alt];
      for (let i = 0; i < 2; ++i) {
        let h = curFunctions[i];
        let bIndex = alt * 4 + 2 * i;
        let aIndex = 4 * (alt * 4 + 2 * i);
        // Add 0.5 to b to give maximum margin of error.
        //
        // For the x coordinate (i == 0), since each position is used to address entryStride texels
        // (for the low and high uint32 key values, and possibly associated entry values), we only
        // add 0.5 / entryStride.
        b[bIndex] = h.b + (i === 0 ? 0.5 / hashTable.entryStride : 0.5);
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
    let {width, height} = hashTable;
    let {gl, texture} = this;
    gl.activeTexture(gl.TEXTURE0 + gl.tempTextureUnit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    setRawTextureParameters(gl);

    const format = gl.RGBA;

    hashTable.tableWithMungedEmptyKey(table => {
      gl.texImage2D(
          gl.TEXTURE_2D,
          /*level=*/0, format,
          /*width=*/width * hashTable.entryStride,
          /*height=*/height,
          /*border=*/0, format, gl.UNSIGNED_BYTE, new Uint8Array(table.buffer));
    });
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  disposed() {
    let {gl} = this;
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.gl = <any>undefined;
    this.hashTable = <any>undefined;
    this.hashFunctions = null;
    super.disposed();
  }

  static get<HashTable extends HashTableBase>(gl: GL, hashTable: HashTable) {
    return gl.memoize.get(hashTable, () => new this(gl, hashTable));
  }
};

export class HashSetShaderManager {
  textureUnitSymbol = Symbol.for (`gpuhashtable:${this.prefix}`);
  aName = this.prefix + '_a';
  bName = this.prefix + '_b';
  samplerName = this.prefix + '_sampler';

  constructor(public prefix: string, public numAlternatives = NUM_ALTERNATIVES) {}

  defineShader(builder: ShaderBuilder) {
    let {aName, bName, samplerName, numAlternatives} = this;
    builder.addUniform('highp vec4', aName, numAlternatives * 4);
    builder.addUniform('highp float', bName, numAlternatives * 4 + 5);
    builder.addTextureSampler2D(samplerName, this.textureUnitSymbol);
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
    vec4 lowResult = texture2D(${samplerName}, v);
    vec4 highResult = texture2D(${samplerName}, vec2(v.x + highOffset, v.y));
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

  enable<HashTable extends HashTableBase>(
      gl: GL, shader: ShaderProgram, hashTable: GPUHashTable<HashTable>) {
    hashTable.copyToGPU();
    let textureUnit = shader.textureUnit(this.textureUnitSymbol);
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, hashTable.texture);
    gl.uniform4fv(shader.uniform(this.aName), hashTable.a);
    gl.uniform1fv(shader.uniform(this.bName), hashTable.b);
  }

  disable(gl: GL, shader: ShaderProgram) {
    let textureUnit = shader.textureUnit(this.textureUnitSymbol);
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
};

export class HashMapShaderManager extends HashSetShaderManager {
  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    let {bName, samplerName, numAlternatives} = this;
    let s = `
bool ${this.getFunctionName}(uint64_t x, out uint64_t value) {
  float highOffset = ${bName}[${numAlternatives * 4 + 2}];
`;
    for (let alt = 0; alt < numAlternatives; ++alt) {
      s += `
  {
    vec2 v = ${this.prefix}_computeHash_${alt}(x);
    vec4 lowResult = texture2D(${samplerName}, v);
    vec4 highResult = texture2D(${samplerName}, vec2(v.x + highOffset, v.y));
    if (lowResult == x.low && highResult == x.high) {
      value.low = texture2D(${samplerName}, vec2(v.x + 2.0 * highOffset, v.y));
      value.high = texture2D(${samplerName}, vec2(v.x + 3.0 * highOffset, v.y));
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

  get getFunctionName() { return `${this.prefix}_get`; }
};
