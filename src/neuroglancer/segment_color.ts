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
import {glsl_hashFunction} from 'neuroglancer/gpu_hash/shader';
import {hsvToRgb} from 'neuroglancer/util/colorspace';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_hsvToRgb, glsl_uint64} from 'neuroglancer/webgl/shader_lib';

const NUM_COMPONENTS = 2;

export class SegmentColorShaderManager {
  aName = this.prefix + '_a';
  bName = this.prefix + '_b';

  constructor(public prefix: string) {}

  defineShader(builder: ShaderBuilder) {
    let {aName, bName} = this;
    builder.addUniform('highp vec4', aName, 2 * NUM_COMPONENTS);
    builder.addUniform('highp float', bName, 2 * NUM_COMPONENTS);
    builder.addFragmentCode(glsl_uint64);
    builder.addFragmentCode(glsl_hashFunction);
    builder.addFragmentCode(glsl_hsvToRgb);
    let s = `
vec3 ${this.prefix}(uint64_t x) {
  vec${NUM_COMPONENTS} v;
  float primeModulus = float(${PRIME_MODULUS});
`;
    for (let i = 0; i < NUM_COMPONENTS; ++i) {
      let bIndex = 2 * i;
      let aIndex = 2 * i;
      s += `
  v[${i}] = computeHash(x, ${aName}[${aIndex}], ${aName}[${aIndex + 1}], ${bName}[${bIndex}], ${bName}[${bIndex + 1}], primeModulus, 1.0 / 256.0);
`;
    }
    s += `
  vec3 hsv = vec3(v.x, 0.5 + v.y * 0.5, 1.0);
  return hsvToRgb(hsv);
}
`;
    builder.addFragmentCode(s);
  }

  enable(gl: GL, shader: ShaderProgram, segmentColorHash: SegmentColorHash) {
    gl.uniform4fv(shader.uniform(this.aName), segmentColorHash.a_);
    gl.uniform1fv(shader.uniform(this.bName), segmentColorHash.b_);
  }
};

function fract(x: number) {
  return x - Math.floor(x);
}

let tempOutput = new Float32Array(NUM_COMPONENTS);
let tempColor = new Float32Array(3);

export class SegmentColorHash {
  hashFunctions: HashFunction[];
  a_ = new Float32Array(4 * 2 * NUM_COMPONENTS);
  b_ = new Float32Array(2 * NUM_COMPONENTS);
  changed = new NullarySignal();

  constructor(hashFunctions?: HashFunction[]) {
    if (hashFunctions == null) {
      this.hashFunctions = new Array(NUM_COMPONENTS);
      this.randomize_();
    } else {
      this.hashFunctions = hashFunctions;
    }
    this.computeGPUCoefficients_();
  }

  static getDefault() {
    return new SegmentColorHash([
      new HashFunction(
          Float32Array.of(609, 2364, 3749, 2289), Float32Array.of(2840, 1186, 3660, 1833), 1718,
          1109),
      new HashFunction(
          Float32Array.of(3466, 3835, 3345, 2040), Float32Array.of(3382, 901, 18, 3444), 1534, 1432)
    ]);
  }

  compute(out: Float32Array, x: Uint64) {
    let {low, high} = x;
    let {hashFunctions} = this;
    for (let i = 0; i < 2; ++i) {
      tempOutput[i] = fract(hashFunctions[i].compute(low, high) / 256.0);
    }
    hsvToRgb(out, tempOutput[0], 0.5 + 0.5 * tempOutput[1], 1.0);
    return out;
  }

  computeCssColor(x: Uint64) {
    this.compute(tempColor, x);
    return `rgb(${tempColor[0] * 100}%,${tempColor[1] * 100}%,${tempColor[2] * 100}%)`;
  }

  debugCompute(out: Float32Array, x: Uint64) {
    function mod(a: number, b: number) { return a % b; }
    let {low, high} = x;
    let b = this.b_;
    let modulus = PRIME_MODULUS;
    for (let i = 0; i < 2; ++i) {
      let bIndex = 2 * i;
      let aIndex = 2 * i;
      let sums = new Float32Array(2);
      for (let j = 0; j < 4; ++j) {
        sums[0] += this.a_[aIndex * 4 + j] * (((low >> (j * 8)) & 0xFF));
        sums[1] += this.a_[(aIndex + 1) * 4 + j] * (((high >> (j * 8)) & 0xFF));
      }
      let dotResult = mod(sums[0] + sums[1], modulus);
      let dotResult2 = mod(dotResult * dotResult, modulus);
      let y = mod(dotResult2 * b[bIndex + 1], modulus);
      let modResult = mod(b[bIndex] + dotResult + y, modulus);
      console.log(
          `b = ${b[bIndex]}, sums=${sums[0]} ${sums[1]}, dotResult=${dotResult}, prod = ${dotResult * dotResult} dotResult2=${dotResult2}, y=${y}, modResult=${modResult}`);
      out[i] = fract(modResult * (1.0 / 256.0));
    }
    return out;
  }

  randomize_() {
    for (let i = 0; i < 2; ++i) {
      this.hashFunctions[i] = HashFunction.generate();
    }
  }
  randomize() {
    this.randomize_();
    this.computeGPUCoefficients_();
    this.changed.dispatch();
  }

  toString() { return `new SegmentColorHash([${this.hashFunctions}])`; }

  computeGPUCoefficients_() {
    let hashFunctions = this.hashFunctions;
    let a = this.a_;
    let b = this.b_;
    let aScalar = 1.0;
    let bScalar = 1.0;
    for (let i = 0; i < NUM_COMPONENTS; ++i) {
      let h = hashFunctions[i];
      let bIndex = 2 * i;
      let aIndex = 4 * (2 * i);
      b[bIndex] = h.b * bScalar;
      b[bIndex + 1] = h.c * bScalar;
      for (let j = 0; j < 4; ++j) {
        a[aIndex + j] = h.a0[j] * aScalar;
        a[aIndex + 4 + j] = h.a1[j] * aScalar;
      }
    }
  }
};
