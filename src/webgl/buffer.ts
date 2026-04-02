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

import type { Disposable } from "#src/util/disposable.js";
import { RefCountedValue } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";
import { getObjectId } from "#src/util/object_id.js";
import type { GL } from "#src/webgl/context.js";
import type { AttributeIndex } from "#src/webgl/shader.js";

export type BufferType = number;
export type WebGLDataType = number;
export type WebGLBufferUsage = number;
export class GLBuffer implements Disposable {
  buffer: WebGLBuffer | null;
  constructor(
    public gl: WebGL2RenderingContext,
    public bufferType: BufferType = WebGL2RenderingContext.ARRAY_BUFFER,
  ) {
    // This should never return null.
    this.buffer = gl.createBuffer();
  }

  bind() {
    this.gl.bindBuffer(this.bufferType, this.buffer);
  }

  bindToVertexAttrib(
    location: AttributeIndex,
    componentsPerVertexAttribute: number,
    attributeType: WebGLDataType = WebGL2RenderingContext.FLOAT,
    normalized = false,
    stride = 0,
    offset = 0,
  ) {
    this.bind();
    this.gl.enableVertexAttribArray(location);
    this.gl.vertexAttribPointer(
      location,
      componentsPerVertexAttribute,
      attributeType,
      normalized,
      stride,
      offset,
    );
  }

  bindToVertexAttribI(
    location: AttributeIndex,
    componentsPerVertexAttribute: number,
    attributeType: WebGLDataType = WebGL2RenderingContext.UNSIGNED_INT,
    stride = 0,
    offset = 0,
  ) {
    this.bind();
    this.gl.enableVertexAttribArray(location);
    this.gl.vertexAttribIPointer(
      location,
      componentsPerVertexAttribute,
      attributeType,
      stride,
      offset,
    );
  }

  setData(
    data: ArrayBufferView,
    usage: WebGLBufferUsage = WebGL2RenderingContext.STATIC_DRAW,
  ) {
    const gl = this.gl;
    this.bind();
    gl.bufferData(this.bufferType, data, usage);
  }

  dispose() {
    this.gl.deleteBuffer(this.buffer);
    this.buffer = <any>undefined;
    this.gl = <any>undefined;
  }

  static fromData(
    gl: WebGL2RenderingContext,
    data: ArrayBufferView,
    bufferType?: BufferType,
    usage?: WebGLBufferUsage,
  ) {
    const buffer = new GLBuffer(gl, bufferType);
    buffer.setData(data, usage);
    return buffer;
  }
}

export function getMemoizedBuffer(
  gl: GL,
  bufferType: number,
  getter: (...args: any[]) => ArrayBufferView,
  ...args: any[]
) {
  return gl.memoize.get(
    stableStringify({
      id: "getMemoizedBuffer",
      getter: getObjectId(getter),
      args,
    }),
    () => {
      const result = new RefCountedValue(
        GLBuffer.fromData(
          gl,
          getter(...args),
          bufferType,
          WebGL2RenderingContext.STATIC_DRAW,
        ),
      );
      result.registerDisposer(result.value);
      return result;
    },
  );
}
