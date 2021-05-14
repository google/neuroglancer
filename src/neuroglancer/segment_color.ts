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

import {hashCombine} from 'neuroglancer/gpu_hash/hash_function';
import {glsl_hashCombine, HashMapShaderManager, GPUHashTable} from 'neuroglancer/gpu_hash/shader';
import {HashTableBase} from 'neuroglancer/gpu_hash/hash_table';
import {hsvToRgb} from 'neuroglancer/util/colorspace';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_hsvToRgb, glsl_uint64} from 'neuroglancer/webgl/shader_lib';
import {getRandomUint32} from './util/random';
import {Trackable} from './util/trackable';

const NUM_COMPONENTS = 2;

export class SegmentColorShaderManager {
  seedName = this.prefix + '_seed';

  constructor(public prefix: string) {}

  defineShader(builder: ShaderBuilder) {
    const {seedName} = this;
    builder.addUniform('highp uint', seedName);
    builder.addFragmentCode(glsl_uint64);
    builder.addFragmentCode(glsl_hashCombine);
    builder.addFragmentCode(glsl_hsvToRgb);
    let s = `
vec3 ${this.prefix}(uint64_t x) {
  uint h = hashCombine(${seedName}, x);
  vec${NUM_COMPONENTS} v;
`;
    for (let i = 0; i < NUM_COMPONENTS; ++i) {
      s += `
  v[${i}] = float(h & 0xFFu) / 255.0;
  h >>= 8u;
`;
    }
    s += `
  vec3 hsv = vec3(v.x, 0.5 + v.y * 0.5, 1.0);
  return hsvToRgb(hsv);
}
`;
    builder.addFragmentCode(s);
  }

  enable(gl: GL, shader: ShaderProgram, segmentColorHash: number) {
    gl.uniform1ui(shader.uniform(this.seedName), segmentColorHash);
  }
}

let tempColor = new Float32Array(3);

export function getCssColor(color: Float32Array) {
  return `rgb(${color[0] * 100}%,${color[1] * 100}%,${color[2] * 100}%)`;
}

export class SegmentColorHash implements Trackable {
  changed = new NullarySignal();

  constructor(public hashSeed: number = getRandomUint32()) {}

  static getDefault() {
    return new SegmentColorHash(0);
  }

  get value() {
    return this.hashSeed;
  }

  set value(value: number) {
    if (value !== this.hashSeed) {
      this.hashSeed = value;
      this.changed.dispatch();
    }
  }

  compute(out: Float32Array, x: Uint64) {
    let h = hashCombine(this.hashSeed, x.low);
    h = hashCombine(h, x.high);
    const c0 = (h & 0xFF) / 255;
    const c1 = ((h >> 8) & 0xFF) / 255;
    hsvToRgb(out, c0, 0.5 + 0.5 * c1, 1.0);
    return out;
  }

  computeCssColor(x: Uint64) {
    this.compute(tempColor, x);
    return getCssColor(tempColor);
  }

  randomize() {
    this.hashSeed = getRandomUint32();
    this.changed.dispatch();
  }

  toString() {
    return `new SegmentColorHash(${this.hashSeed})`;
  }

  toJSON() {
    return this.hashSeed === 0 ? undefined : this.hashSeed;
  }

  reset() {
    this.restoreState(0);
  }

  restoreState(x: any) {
    const newSeed = x >>> 0;
    if (newSeed !== this.hashSeed) {
      this.hashSeed = newSeed;
      this.changed.dispatch();
    }
  }
}

/**
 * Adds the shader code to get a segment's color if it is present in the map.
 */
export class SegmentStatedColorShaderManager {
  private hashMapShaderManager = new HashMapShaderManager('segmentStatedColorHash');

  constructor(public prefix: string) {}

  defineShader(builder: ShaderBuilder) {
    this.hashMapShaderManager.defineShader(builder);
    let s = `
bool ${this.getFunctionName}(uint64_t x, out vec3 value) {
  uint64_t uint64Value;
  if (${this.hashMapShaderManager.getFunctionName}(x, uint64Value)) {
    uint uintValue = uint64Value.value[0];
    value.r = float((uintValue & 0x0000ffu))       / 255.0;
    value.g = float((uintValue & 0x00ff00u) >>  8) / 255.0;
    value.b = float((uintValue & 0xff0000u) >> 16) / 255.0;
    return true;
  }
  return false;
}
`;
    builder.addFragmentCode(s);
  }

  get getFunctionName() {
    return `${this.prefix}_get`;
  }

  enable<HashTable extends HashTableBase>(
    gl: GL, shader: ShaderProgram, hashTable: GPUHashTable<HashTable>) {
    this.hashMapShaderManager.enable(gl, shader, hashTable);
  }

  disable(gl: GL, shader: ShaderProgram) {
    this.hashMapShaderManager.disable(gl, shader);
  }
}
