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
import {Disposable, RefCounted} from 'neuroglancer/util/disposable';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

const textureUnitSymbol = Symbol('SingleTextureVolumeChunk.textureUnit');
const textureLayoutSymbol = Symbol('SingleTextureVolumeChunk.textureLayout');

export abstract class SingleTextureChunkFormat<TextureLayout extends Disposable> extends RefCounted
    implements ChunkFormat {
  arrayElementsPerTexel: number;
  texelType: number;
  textureFormat: number;

  constructor(public shaderKey: string) { super(); }

  defineShader(builder: ShaderBuilder) {
    builder.addTextureSampler2D('uVolumeChunkSampler', textureUnitSymbol);
  }

  beginDrawing(gl: GL, shader: ShaderProgram) {
    let textureUnit = shader.textureUnit(textureUnitSymbol);
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    (<any>shader)[textureLayoutSymbol] = null;
  }

  endDrawing(gl: GL, shader: ShaderProgram) {
    gl.bindTexture(gl.TEXTURE_2D, null);
    (<any>shader)[textureLayoutSymbol] = null;
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  abstract setupTextureLayout(gl: GL, shader: ShaderProgram, textureLayout: TextureLayout): void;

  bindChunk<Data>(
      gl: GL, shader: ShaderProgram, chunk: SingleTextureVolumeChunk<Data, TextureLayout>) {
    let textureLayout = chunk.textureLayout!;
    let existingTextureLayout = (<any>shader)[textureLayoutSymbol];
    if (existingTextureLayout !== textureLayout) {
      (<any>shader)[textureLayoutSymbol] = textureLayout;
      this.setupTextureLayout(gl, shader, textureLayout);
    }
    gl.bindTexture(gl.TEXTURE_2D, chunk.texture);
  }

  abstract setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray): void;

  /**
   * Does nothing, but may be overridden by subclass.
   */
  beginSource(_gl: GL, _shader: ShaderProgram) {}
};

export abstract class SingleTextureVolumeChunk<Data, TextureLayout extends Disposable> extends
    VolumeChunk {
  texture: WebGLTexture|null = null;
  data: Data;
  textureLayout: TextureLayout|null;

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.data = x['data'];
  }

  abstract setTextureData(gl: GL): void;

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    let texture = this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.setTextureData(gl);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.textureLayout!.dispose();
    this.textureLayout = null;
  }
};
