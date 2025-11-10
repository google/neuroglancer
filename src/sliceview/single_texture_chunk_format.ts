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

import type {
  VolumeChunkSource,
  ChunkFormat,
} from "#src/sliceview/volume/frontend.js";
import { VolumeChunk } from "#src/sliceview/volume/frontend.js";
import type { TypedArray } from "#src/util/array.js";
import type { DataType } from "#src/util/data_type.js";
import type { Disposable } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import type {
  ShaderBuilder,
  ShaderProgram,
  ShaderSamplerType,
} from "#src/webgl/shader.js";
import { textureTargetForSamplerType } from "#src/webgl/shader.js";

const textureUnitSymbol = Symbol("SingleTextureVolumeChunk.textureUnit");
const textureLayoutSymbol = Symbol("SingleTextureVolumeChunk.textureLayout");

export abstract class SingleTextureChunkFormat<TextureLayout extends Disposable>
  extends RefCounted
  implements ChunkFormat
{
  constructor(
    public shaderKey: string,
    public dataType: DataType,
  ) {
    super();
  }

  defineShader(builder: ShaderBuilder, numChannelDimensions: number) {
    numChannelDimensions;
    builder.addTextureSampler(
      this.shaderSamplerType,
      "uVolumeChunkSampler",
      textureUnitSymbol,
    );
  }

  abstract get shaderSamplerType(): ShaderSamplerType;

  beginDrawing(gl: GL, shader: ShaderProgram) {
    const textureUnit = shader.textureUnit(textureUnitSymbol);
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    (<any>shader)[textureLayoutSymbol] = null;
  }

  endDrawing(gl: GL, shader: ShaderProgram) {
    gl.bindTexture(textureTargetForSamplerType[this.shaderSamplerType], null);
    (<any>shader)[textureLayoutSymbol] = null;
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  abstract setupTextureLayout(
    gl: GL,
    shader: ShaderProgram,
    textureLayout: TextureLayout,
    fixedChunkPosition: Uint32Array,
    chunkDisplaySubspaceDimensions: readonly number[],
    channelDimensions: readonly number[],
  ): void;

  bindChunk<Data>(
    gl: GL,
    shader: ShaderProgram,
    chunk: SingleTextureVolumeChunk<Data, TextureLayout>,
    fixedChunkPosition: Uint32Array,
    chunkDisplaySubspaceDimensions: readonly number[],
    channelDimensions: readonly number[],
    newSource: boolean,
  ) {
    const textureLayout = chunk.textureLayout!;
    const existingTextureLayout = (<any>shader)[textureLayoutSymbol];
    if (existingTextureLayout !== textureLayout || newSource) {
      (<any>shader)[textureLayoutSymbol] = textureLayout;
      this.setupTextureLayout(
        gl,
        shader,
        textureLayout,
        fixedChunkPosition,
        chunkDisplaySubspaceDimensions,
        channelDimensions,
      );
    }
    gl.bindTexture(
      textureTargetForSamplerType[this.shaderSamplerType],
      chunk.texture,
    );
  }

  abstract setTextureData(
    gl: GL,
    textureLayout: TextureLayout,
    data: TypedArray,
  ): void;

  /**
   * Does nothing, but may be overridden by subclass.
   */
  beginSource(_gl: GL, _shader: ShaderProgram) {}
}

export abstract class SingleTextureVolumeChunk<
  Data,
  TextureLayout extends Disposable,
> extends VolumeChunk {
  texture: WebGLTexture | null = null;
  data: Data | null;
  textureLayout: TextureLayout | null;
  declare CHUNK_FORMAT_TYPE: SingleTextureChunkFormat<TextureLayout>;

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.data = x.data;
  }

  abstract setTextureData(gl: GL): void;

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    if (this.data === null) return;
    const texture = (this.texture = gl.createTexture());
    const textureTarget =
      textureTargetForSamplerType[this.chunkFormat.shaderSamplerType];
    gl.bindTexture(textureTarget, texture);
    this.setTextureData(gl);
    gl.bindTexture(textureTarget, null);
  }

  updateFromCpuData(
    gl: GL,
    _region?: { offset: Uint32Array; size: Uint32Array },
  ) {
    if (this.data == null) return;

    // If there is no existing texture, just perform the normal upload path.
    if (this.texture == null) {
      this.copyToGPU(gl);
      return;
    }

    const fmt = this.chunkFormat as any; // Both uncompressed and compressed implement TextureFormat-like fields
    const textureTarget =
      textureTargetForSamplerType[this.chunkFormat.shaderSamplerType];
    gl.bindTexture(textureTarget, this.texture);
    gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 1);

    // If we have a textureLayout with a definite shape (uncompressed path), we can sub-update.
    const layout: any = this.textureLayout;
    const hasShape =
      layout && layout.textureShape && layout.textureShape.length >= 2;

    try {
      // Prefer texSubImage path when we can compute exact sizes (uncompressed formats):
      if (hasShape && typeof fmt.textureDims === "number") {
        const texelsPerElement = fmt.texelsPerElement ?? 1;
        const w = layout.textureShape[0] * texelsPerElement;
        const h = layout.textureShape[1] ?? 1;
        const d =
          fmt.textureDims === 3 ? (layout.textureShape[2] ?? 1) : undefined;

        // Ensure typed array type matches GL expectations
        let data: any = this.data;
        const ctor = fmt.arrayConstructor as
          | { new (b: ArrayBuffer, o: number, l: number): any }
          | undefined;
        if (ctor && data.constructor !== ctor) {
          data = new (ctor as any)(
            data.buffer,
            data.byteOffset,
            data.byteLength / (ctor as any).BYTES_PER_ELEMENT,
          );
        }

        if (fmt.textureDims === 3 && d !== undefined) {
          // 3D update
          gl.texSubImage3D(
            WebGL2RenderingContext.TEXTURE_3D,
            /*level=*/ 0,
            /*xoffset=*/ 0,
            /*yoffset=*/ 0,
            /*zoffset=*/ 0,
            /*width=*/ w,
            /*height=*/ h,
            /*depth=*/ d,
            fmt.textureFormat,
            fmt.texelType,
            data,
          );
        } else {
          // 2D update
          gl.texSubImage2D(
            WebGL2RenderingContext.TEXTURE_2D,
            /*level=*/ 0,
            /*xoffset=*/ 0,
            /*yoffset=*/ 0,
            /*width=*/ w,
            /*height=*/ h,
            fmt.textureFormat,
            fmt.texelType,
            data,
          );
        }
      } else {
        // Fallback: re-specify the texture contents onto the existing texture object.
        // This still avoids delete+create and the associated driver sync.
        this.setTextureData(gl);
      }
    } finally {
      gl.bindTexture(textureTarget, null);
    }
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    if (this.data === null) return;
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.textureLayout!.dispose();
    this.textureLayout = null;
  }
}
