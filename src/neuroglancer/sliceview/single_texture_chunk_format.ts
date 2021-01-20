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

import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {ChunkFormat} from 'neuroglancer/sliceview/volume/frontend';
import {TypedArray} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {Disposable, RefCounted} from 'neuroglancer/util/disposable';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram, ShaderSamplerType, textureTargetForSamplerType} from 'neuroglancer/webgl/shader';

const textureUnitSymbol = Symbol('SingleTextureVolumeChunk.textureUnit');
const textureLayoutSymbol = Symbol('SingleTextureVolumeChunk.textureLayout');

export abstract class SingleTextureChunkFormat<TextureLayout extends Disposable> extends RefCounted
    implements ChunkFormat {
  constructor(public shaderKey: string, public dataType: DataType) {
    super();
  }

  defineShader(builder: ShaderBuilder, numChannelDimensions: number) {
    numChannelDimensions;
    builder.addTextureSampler(this.shaderSamplerType, 'uVolumeChunkSampler', textureUnitSymbol);
  }

  abstract get shaderSamplerType(): ShaderSamplerType;

  beginDrawing(gl: GL, shader: ShaderProgram) {
    let textureUnit = shader.textureUnit(textureUnitSymbol);
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
      gl: GL, shader: ShaderProgram, textureLayout: TextureLayout, fixedChunkPosition: Uint32Array,
      chunkDisplaySubspaceDimensions: readonly number[],
      channelDimensions: readonly number[]): void;

  bindChunk<Data>(
      gl: GL, shader: ShaderProgram, chunk: SingleTextureVolumeChunk<Data, TextureLayout>,
      fixedChunkPosition: Uint32Array, chunkDisplaySubspaceDimensions: readonly number[],
      channelDimensions: readonly number[], newSource: boolean) {
    let textureLayout = chunk.textureLayout!;
    let existingTextureLayout = (<any>shader)[textureLayoutSymbol];
    if (existingTextureLayout !== textureLayout || newSource) {
      (<any>shader)[textureLayoutSymbol] = textureLayout;
      this.setupTextureLayout(
          gl, shader, textureLayout, fixedChunkPosition, chunkDisplaySubspaceDimensions,
          channelDimensions);
    }
    gl.bindTexture(textureTargetForSamplerType[this.shaderSamplerType], chunk.texture);
  }

  abstract setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray): void;

  /**
   * Does nothing, but may be overridden by subclass.
   */
  beginSource(_gl: GL, _shader: ShaderProgram) {}
}

export abstract class SingleTextureVolumeChunk<Data, TextureLayout extends Disposable> extends
    VolumeChunk {
  texture: WebGLTexture|null = null;
  data: Data;
  textureLayout: TextureLayout|null;
  CHUNK_FORMAT_TYPE: SingleTextureChunkFormat<TextureLayout>;

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.data = x['data'];
  }

  abstract setTextureData(gl: GL): void;

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    let texture = this.texture = gl.createTexture();
    const textureTarget = textureTargetForSamplerType[this.chunkFormat.shaderSamplerType];
    gl.bindTexture(textureTarget, texture);
    this.setTextureData(gl);
    gl.bindTexture(textureTarget, null);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.textureLayout!.dispose();
    this.textureLayout = null;
  }
}
