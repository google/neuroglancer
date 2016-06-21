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
import {identityMat4} from 'neuroglancer/util/geom';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {resizeTexture} from 'neuroglancer/webgl/texture';
import {trivialTextureShader} from 'neuroglancer/webgl/trivial_shaders';

export class OffscreenFramebuffer extends RefCounted {
  width = Number.NaN;
  height = Number.NaN;
  framebuffer = this.gl.createFramebuffer();
  depthBuffer: WebGLRenderbuffer|null = null;
  dataTextures = new Array<WebGLTexture|null>();
  useStencilBuffer: boolean;
  private attachmentVerified = false;
  private tempPixel = new Uint8Array(4);
  private fullAttachmentList = new Array<number>();
  private singleAttachmentList = [this.gl.WEBGL_draw_buffers.COLOR_ATTACHMENT0_WEBGL];
  constructor(
      public gl: GL, {numDataBuffers = 1, depthBuffer = false, stencilBuffer = false} = {}) {
    super();
    let {dataTextures, fullAttachmentList} = this;
    for (let i = 0; i < numDataBuffers; ++i) {
      dataTextures[i] = gl.createTexture();
      fullAttachmentList[i] = gl.WEBGL_draw_buffers.COLOR_ATTACHMENT0_WEBGL + i;
    }
    if (depthBuffer || stencilBuffer) {
      this.depthBuffer = gl.createRenderbuffer();
    }
    this.useStencilBuffer = stencilBuffer;
  }

  disposed() {
    let {gl, depthBuffer} = this;
    gl.deleteFramebuffer(this.framebuffer);
    if (depthBuffer != null) {
      gl.deleteRenderbuffer(depthBuffer);
    }
    for (let dataTexture of this.dataTextures) {
      gl.deleteTexture(dataTexture);
    }
  }

  resize(width: number, height: number) {
    if (this.hasSize(width, height)) {
      return;
    }
    this.width = width;
    this.height = height;
    let {gl, useStencilBuffer, depthBuffer} = this;
    for (let dataTexture of this.dataTextures) {
      resizeTexture(gl, dataTexture, width, height);
    }

    if (depthBuffer) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
      gl.renderbufferStorage(
          gl.RENDERBUFFER, useStencilBuffer ? gl.DEPTH_STENCIL : gl.DEPTH_COMPONENT16, width,
          height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }
  }

  hasSize(width: number, height: number) { return this.width === width && this.height === height; }

  bind(width: number, height: number) {
    this.resize(width, height);
    let {gl, useStencilBuffer, depthBuffer} = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    if (depthBuffer) {
      gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER, useStencilBuffer ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT,
          gl.RENDERBUFFER, depthBuffer);
    }
    this.dataTextures.forEach((dataTexture, i) => {
      gl.framebufferTexture2D(
          gl.FRAMEBUFFER, gl.WEBGL_draw_buffers.COLOR_ATTACHMENT0_WEBGL + i, gl.TEXTURE_2D,
          dataTexture,
          /*level=*/0);
    });
    gl.WEBGL_draw_buffers.drawBuffersWEBGL(this.fullAttachmentList);
    this.verifyAttachment();
    gl.viewport(0, 0, width, height);
  }

  unbind() {
    let {gl} = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bindSingle(textureIndex: number) {
    let {gl} = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.dataTextures[textureIndex],
        /*level=*/0);
    gl.WEBGL_draw_buffers.drawBuffersWEBGL(this.singleAttachmentList);
  }

  readPixel(textureIndex: number, glWindowX: number, glWindowY: number): Uint8Array {
    let {gl, tempPixel} = this;
    try {
      this.bindSingle(textureIndex);
      gl.readPixels(glWindowX, glWindowY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, tempPixel);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return tempPixel;
  }

  /**
   * Calls readPixel, but interprets the RGBA result as a little-endian uint32 value.
   */
  readPixelAsUint32(textureIndex: number, glWindowX: number, glWindowY: number) {
    let result = this.readPixel(textureIndex, glWindowX, glWindowY);
    return result[0] + (result[1] << 8) + (result[2] << 16) + (result[3] << 24);
  }

  verifyAttachment() {
    if (this.attachmentVerified) {
      return;
    }
    let {gl} = this;
    let framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Framebuffer configuration not supported');
    }
    this.attachmentVerified = true;
  }
};


export class OffscreenCopyHelper extends RefCounted {
  constructor(public gl: GL) { super(); }
  private copyVertexPositionsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl, new Float32Array([
        -1, -1, 0, 1,  //
        -1, +1, 0, 1,  //
        +1, +1, 0, 1,  //
        +1, -1, 0, 1,  //
      ]),
      this.gl.ARRAY_BUFFER, this.gl.STATIC_DRAW));
  private copyTexCoordsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl, new Float32Array([
        0, 0,  //
        0, 1,  //
        1, 1,  //
        1, 0,  //
      ]),
      this.gl.ARRAY_BUFFER, this.gl.STATIC_DRAW));

  private trivialTextureShader = this.registerDisposer(trivialTextureShader(this.gl));

  draw(texture: WebGLTexture|null) {
    let {gl} = this;
    let shader = this.trivialTextureShader;
    shader.bind();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.uniform1i(shader.uniform('uSampler'), 0);
    gl.uniformMatrix4fv(shader.uniform('uProjectionMatrix'), false, identityMat4);

    let aVertexPosition = shader.attribute('aVertexPosition');
    this.copyVertexPositionsBuffer.bindToVertexAttrib(aVertexPosition, 4);

    let aTexCoord = shader.attribute('aTexCoord');
    this.copyTexCoordsBuffer.bindToVertexAttrib(aTexCoord, 2);

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    gl.disableVertexAttribArray(aVertexPosition);
    gl.disableVertexAttribArray(aTexCoord);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  static get(gl: GL) {
    return gl.memoize.get('OffscreenCopyHelper', () => { return new OffscreenCopyHelper(gl); });
  }
};
