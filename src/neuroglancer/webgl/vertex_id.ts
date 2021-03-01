/**
 * @license
 * Copyright 2020 Google Inc.
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

/**
 * @file Workaround for Firefox requirement that at least one active vertex attribute have divisor
 * of 0.
 *
 * https://github.com/KhronosGroup/WebGL/pull/2662
 */

import {RefCounted} from 'neuroglancer/util/disposable';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';

export function defineVertexId(builder: ShaderBuilder) {
  // Define attribute for location 0 that will always equal 0.
  builder.addAttribute('int', 'aDummyVertexId', 0);
  // Ensure `aDummyVertexId` is actually used in the shader; otherwise, it will be optimized out.
  builder.addVertexCode(`
int getVertexId () {
  return aDummyVertexId + gl_VertexID;
}
#define gl_VertexID (getVertexId())
`);
}

export class VertexIdHelper extends RefCounted {
  size: number;
  buffer: Buffer;

  constructor(gl: WebGL2RenderingContext) {
    super();
    this.buffer = new Buffer(gl);
    this.size = 0;
  }

  disposed() {
    this.buffer.dispose();
  }

  enable(size: number = 256) {
    const {buffer} = this;
    const {gl} = buffer;
    buffer.bind();
    if (size > this.size) {
      this.size = size;
      gl.bufferData(
          WebGL2RenderingContext.ARRAY_BUFFER, new Int32Array(size),
          WebGL2RenderingContext.STATIC_DRAW);
    }
    gl.vertexAttribIPointer(0, 1, WebGL2RenderingContext.INT, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.enableVertexAttribArray(0);
  }

  disable() {
    const {gl} = this.buffer;
    gl.disableVertexAttribArray(0);
  }

  static get(gl: GL) {
    return gl.memoize.get('VertexIdHelper', () => new VertexIdHelper(gl));
  }
}
