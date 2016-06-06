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

import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {Disposable, RefCounted} from 'neuroglancer/util/disposable';
import {setRawTextureParameters} from 'neuroglancer/webgl/texture';
import {ChunkFormat, VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/frontend';

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

  /**
   * Called when starting to draw chunks.
   */
  beginDrawing(gl: GL, shader: ShaderProgram) {
    let textureUnit = shader.textureUnit(textureUnitSymbol);
    gl.activeTexture(gl.TEXTURE0 + textureUnit);
    (<any>shader)[textureLayoutSymbol] = null;
  }

  /**
   * Called once after all chunks have been drawn.
   */
  endDrawing(gl: GL, shader: ShaderProgram) {
    gl.bindTexture(gl.TEXTURE_2D, null);
    (<any>shader)[textureLayoutSymbol] = null;
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  abstract setupTextureLayout(gl: GL, shader: ShaderProgram, textureLayout: TextureLayout): void;

  /**
   * Called just before drawing each chunk.
   */
  bindChunk<Data>(
      gl: GL, shader: ShaderProgram, chunk: SingleTextureVolumeChunk<Data, TextureLayout>) {
    let {textureLayout} = chunk;
    let existingTextureLayout = (<any>shader)[textureLayoutSymbol];
    if (existingTextureLayout !== textureLayout) {
      (<any>shader)[textureLayoutSymbol] = textureLayout;
      this.setupTextureLayout(gl, shader, textureLayout);
    }
    gl.bindTexture(gl.TEXTURE_2D, chunk.texture);
  }
};

export abstract class SingleTextureVolumeChunk<Data, TextureLayout extends Disposable> extends
    VolumeChunk {
  texture: WebGLTexture = null;
  data: Data;
  textureLayout: TextureLayout;

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.data = x['data'];
  }

  abstract setTextureData(gl: GL): void;

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    let texture = this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    setRawTextureParameters(gl);
    this.setTextureData(gl);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.textureLayout.dispose();
    this.textureLayout = null;
  }
};
