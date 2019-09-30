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

import {RefCounted} from 'neuroglancer/util/disposable';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_uint32} from 'neuroglancer/webgl/shader_lib';

export class CountingBuffer extends RefCounted {
  length: number|undefined;
  webglType: number|undefined;
  buffer: Buffer;

  constructor(public gl: GL) {
    super();
    this.buffer = this.registerDisposer(new Buffer(gl));
  }

  resize(length: number) {
    let bufferData: ArrayBufferView;
    if (length < 256) {
      let data = bufferData = new Uint8Array(length);
      for (let i = 0; i < length; ++i) {
        data[i] = i;
      }
      this.webglType = WebGL2RenderingContext.UNSIGNED_BYTE;
    } else if (length < 65536) {
      const data = bufferData = new Uint16Array(length);
      for (let i = 0; i < length; ++i) {
        data[i] = i;
      }
      this.webglType = WebGL2RenderingContext.UNSIGNED_SHORT;
    } else {
      const data = bufferData = new Uint32Array(length);
      for (let i = 0; i < length; ++i) {
        data[i] = i;
      }
      this.webglType = WebGL2RenderingContext.UNSIGNED_INT;
    }
    this.buffer.setData(bufferData);
    this.length = length;
  }

  ensure(length: number) {
    if (this.length === undefined || this.length < length) {
      this.resize(length);
    }
    return this;
  }

  bindToVertexAttrib(location: number) {
    this.buffer.bindToVertexAttribI(location, 1, this.webglType);
  }

  bind(shader: ShaderProgram, divisor = 0) {
    const location = shader.attribute('aIndexRaw');
    if (location >= 0) {
      this.bindToVertexAttrib(location);
      if (divisor !== 0) {
        this.gl.vertexAttribDivisor(location, divisor);
      }
    }
  }
}

export function disableCountingBuffer(gl: GL, shader: ShaderProgram, instanced = false) {
  const location = shader.attribute('aIndexRaw');
  if (location >= 0) {
    if (instanced) {
      gl.vertexAttribDivisor(location, 0);
    }
    gl.disableVertexAttribArray(location);
  }
}

export function getCountingBuffer(gl: GL) {
  return gl.memoize.get('IndexBuffer', () => new CountingBuffer(gl));
}

export function countingBufferShaderModule(builder: ShaderBuilder) {
  builder.addAttribute('highp uint', 'aIndexRaw');
  builder.addVertexCode(glsl_uint32);
  builder.addVertexCode(`
uint getPrimitiveIndex() {
  return aIndexRaw;
}
`);
}

/**
 * Helper class for using a buffer containing uint32 index values as a vertex attribute.
 */
export class IndexBufferAttributeHelper {
  constructor(public name: string) {}

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp uint', this.name);
  }

  bind(buffer: Buffer, shader: ShaderProgram) {
    const attrib = shader.attribute(this.name);
    buffer.bindToVertexAttribI(attrib, /*components=*/ 1, WebGL2RenderingContext.UNSIGNED_INT);
  }

  disable(shader: ShaderProgram) {
    shader.gl.disableVertexAttribArray(shader.attribute(this.name));
  }
}

export function makeIndexBuffer(gl: WebGL2RenderingContext, data: Uint32Array) {
  return Buffer.fromData(
      gl, data, WebGL2RenderingContext.ARRAY_BUFFER, WebGL2RenderingContext.STATIC_DRAW);
}
