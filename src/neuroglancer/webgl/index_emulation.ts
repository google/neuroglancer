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
import {GL_ARRAY_BUFFER, GL_STATIC_DRAW, GL_UNSIGNED_BYTE} from 'neuroglancer/webgl/constants';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_uint32} from 'neuroglancer/webgl/shader_lib';

export class CountingBuffer extends RefCounted {
  length: number|undefined;
  numComponents: number|undefined;
  buffer: Buffer;

  constructor(public gl: GL) {
    super();
    this.buffer = this.registerDisposer(new Buffer(gl));
  }

  resize(length: number) {
    let bufferData: ArrayBufferView;
    let numComponents: number;
    if (length < 256) {
      let data = bufferData = new Uint8Array(length);
      for (let i = 0; i < length; ++i) {
        data[i] = i;
      }
      numComponents = 1;
    } else if (length < 65536) {
      const data = bufferData = new Uint8Array(length * 2);
      let j = 0;
      const count = length * 2;
      for (let i = 0; i < count; i += 2) {
        data[i] = j;
        data[i + 1] = j >> 8;
        ++j;
      }
      numComponents = 2;
    } else if (length < 16777216) {
      const data = bufferData = new Uint8Array(length * 3);
      const count = length * 3;
      let j = 0;
      for (let i = 0; i < count; i += 3) {
        data[i] = j;
        data[i + 1] = (j >> 8);
        data[i + 2] = (j >> 16);
        ++j;
      }
      numComponents = 3;
    } else {
      throw new Error(`Length of index buffer must not exceed 2^24.`);
    }
    this.buffer.setData(bufferData);
    this.numComponents = numComponents;
    this.length = length;
  }

  ensure(length: number) {
    if (this.length === undefined || this.length < length) {
      this.resize(length);
    }
    return this;
  }

  bindToVertexAttrib(location: number) {
    this.buffer.bindToVertexAttrib(
        location, this.numComponents!, GL_UNSIGNED_BYTE, /*normalized=*/true);
  }

  bind(shader: ShaderProgram, divisor = 0) {
    const location = shader.attribute('aIndexRaw');
    if (location >= 0) {
      this.bindToVertexAttrib(location);
      if (divisor !== 0) {
        this.gl.ANGLE_instanced_arrays.vertexAttribDivisorANGLE(location, divisor);
      }
    }
  }
}

export function disableCountingBuffer(gl: GL, shader: ShaderProgram, instanced = false) {
  const location = shader.attribute('aIndexRaw');
  if (location >= 0) {
    if (instanced) {
      gl.ANGLE_instanced_arrays.vertexAttribDivisorANGLE(location, 0);
    }
    gl.disableVertexAttribArray(location);
  }
}

export function getCountingBuffer(gl: GL) {
  return gl.memoize.get('IndexBuffer', () => new CountingBuffer(gl));
}

export function countingBufferShaderModule(builder: ShaderBuilder) {
  builder.addAttribute('highp vec3', 'aIndexRaw');
  builder.addVertexCode(glsl_uint32);
  builder.addVertexCode(`
uint32_t getPrimitiveIndex() {
  uint32_t result;
  result.value = vec4(aIndexRaw, 0.0);
  return result;
}
`);
}

/**
 * Helper class for using a buffer containing uint32 index values as a vertex attribute.
 */
export class IndexBufferAttributeHelper {
  attributeName = 'a' + this.name;
  getterName = 'get' + this.name;
  constructor(public name: string) {}

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec4', this.attributeName);
    builder.addVertexCode(`
float ${this.getterName} () {
  vec4 temp = ${this.attributeName};
  return temp.x + temp.y * 256.0 + temp.z * 65536.0;
}
`);
  }

  bind(buffer: Buffer, shader: ShaderProgram) {
    buffer.bindToVertexAttrib(
        shader.attribute(this.attributeName), /*components=*/4, GL_UNSIGNED_BYTE,
        /*normalized=*/false);
  }

  disable(shader: ShaderProgram) {
    shader.gl.disableVertexAttribArray(shader.attribute(this.attributeName));
  }
}

export function makeIndexBuffer(gl: WebGLRenderingContext, data: Uint32Array) {
  return Buffer.fromData(
      gl, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), GL_ARRAY_BUFFER,
      GL_STATIC_DRAW);
}
