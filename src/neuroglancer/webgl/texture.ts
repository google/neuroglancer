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

import {GL_CLAMP_TO_EDGE, GL_LINEAR, GL_NEAREST, GL_RGBA, GL_TEXTURE0, GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_TEXTURE_MIN_FILTER, GL_TEXTURE_WRAP_S, GL_TEXTURE_WRAP_T, GL_UNPACK_ALIGNMENT, GL_UNPACK_FLIP_Y_WEBGL, GL_UNSIGNED_BYTE} from 'neuroglancer/webgl/constants';
import {GL} from 'neuroglancer/webgl/context';

/**
 * Sets parameters to make a texture suitable for use as a raw array: NEAREST
 * filtering, clamping.
 */
export function setRawTextureParameters(gl: WebGLRenderingContext) {
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}

export function resizeTexture(
    gl: GL, texture: WebGLTexture|null, width: number, height: number, format: number = GL_RGBA,
    dataType: number = GL_UNSIGNED_BYTE) {
  gl.activeTexture(GL_TEXTURE0 + gl.tempTextureUnit);
  gl.bindTexture(GL_TEXTURE_2D, texture);
  setRawTextureParameters(gl);
  gl.texImage2D(
      GL_TEXTURE_2D, 0,
      /*internalformat=*/format,
      /*width=*/width,
      /*height=*/height,
      /*border=*/0,
      /*format=*/format, dataType, <any>null);
  gl.bindTexture(GL_TEXTURE_2D, null);
}

export function setTextureFromCanvas(
    gl: GL, texture: WebGLTexture|null, canvas: HTMLCanvasElement) {
  gl.activeTexture(GL_TEXTURE0 + gl.tempTextureUnit);
  gl.bindTexture(GL_TEXTURE_2D, texture);
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  gl.pixelStorei(GL_UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(GL_UNPACK_ALIGNMENT, 4);
  gl.texImage2D(
      GL_TEXTURE_2D, /*level=*/0,
      /*internalformat=*/GL_RGBA,
      /*format=*/GL_RGBA, GL_UNSIGNED_BYTE, canvas);
  gl.pixelStorei(GL_UNPACK_FLIP_Y_WEBGL, false);
  gl.bindTexture(GL_TEXTURE_2D, null);
}
