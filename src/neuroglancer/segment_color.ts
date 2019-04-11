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
import {glsl_hashCombine} from 'neuroglancer/gpu_hash/shader';
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

  enable(gl: GL, shader: ShaderProgram, segmentColorHash: SegmentColorHash) {
    gl.uniform1ui(shader.uniform(this.seedName), segmentColorHash.hashSeed);
  }
}

let tempColor = new Float32Array(3);

export class SegmentColorHash implements Trackable {
  changed = new NullarySignal();

  constructor(public hashSeed: number = getRandomUint32()) {}

  static getDefault() {
    return new SegmentColorHash(0);
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
    return `rgb(${tempColor[0] * 100}%,${tempColor[1] * 100}%,${tempColor[2] * 100}%)`;
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
