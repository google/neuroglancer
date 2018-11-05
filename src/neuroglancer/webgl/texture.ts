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

/**
 * Sets parameters to make a texture suitable for use as a raw array: NEAREST
 * filtering, clamping.
 */
export function setRawTextureParameters(gl: WebGL2RenderingContext) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

export function resizeTexture(
    gl: GL, texture: WebGLTexture|null, width: number, height: number,
    internalFormat: number = gl.RGBA8, format: number = gl.RGBA,
    dataType: number = gl.UNSIGNED_BYTE) {
  gl.activeTexture(gl.TEXTURE0 + gl.tempTextureUnit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  setRawTextureParameters(gl);
  gl.texImage2D(
      gl.TEXTURE_2D, 0,
      /*internalformat=*/internalFormat,
      /*width=*/width,
      /*height=*/height,
      /*border=*/0,
      /*format=*/format, dataType, <any>null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

export function setTextureFromCanvas(
    gl: GL, texture: WebGLTexture|null, canvas: HTMLCanvasElement) {
  gl.activeTexture(gl.TEXTURE0 + gl.tempTextureUnit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(
      gl.TEXTURE_2D, /*level=*/0,
      /*internalformat=*/gl.RGBA8,
      /*format=*/gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.bindTexture(gl.TEXTURE_2D, null);
}
