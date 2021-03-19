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
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_2D, WebGL2RenderingContext.TEXTURE_MIN_FILTER, WebGL2RenderingContext.NEAREST);
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_2D, WebGL2RenderingContext.TEXTURE_MAG_FILTER, WebGL2RenderingContext.NEAREST);
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_2D, WebGL2RenderingContext.TEXTURE_WRAP_S, WebGL2RenderingContext.CLAMP_TO_EDGE);
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_2D, WebGL2RenderingContext.TEXTURE_WRAP_T, WebGL2RenderingContext.CLAMP_TO_EDGE);
}

export function setRawTexture3DParameters(gl: WebGL2RenderingContext) {
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_3D, WebGL2RenderingContext.TEXTURE_MIN_FILTER, WebGL2RenderingContext.NEAREST);
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_3D, WebGL2RenderingContext.TEXTURE_MAG_FILTER, WebGL2RenderingContext.NEAREST);
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_3D, WebGL2RenderingContext.TEXTURE_WRAP_S, WebGL2RenderingContext.CLAMP_TO_EDGE);
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_3D, WebGL2RenderingContext.TEXTURE_WRAP_T, WebGL2RenderingContext.CLAMP_TO_EDGE);
  gl.texParameteri(WebGL2RenderingContext.TEXTURE_3D, WebGL2RenderingContext.TEXTURE_WRAP_R, WebGL2RenderingContext.CLAMP_TO_EDGE);
}

export function resizeTexture(
    gl: GL, texture: WebGLTexture|null, width: number, height: number,
    internalFormat: number = WebGL2RenderingContext.RGBA8, format: number = WebGL2RenderingContext.RGBA,
    dataType: number = WebGL2RenderingContext.UNSIGNED_BYTE) {
  gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + gl.tempTextureUnit);
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
  setRawTextureParameters(gl);
  gl.texImage2D(
      WebGL2RenderingContext.TEXTURE_2D, 0,
      /*internalformat=*/internalFormat,
      /*width=*/width,
      /*height=*/height,
      /*border=*/0,
      /*format=*/format, dataType, <any>null);
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
}

export function setTextureFromCanvas(
    gl: GL, texture: WebGLTexture|null, canvas: HTMLCanvasElement) {
  gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + gl.tempTextureUnit);
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
  gl.texParameteri(
      WebGL2RenderingContext.TEXTURE_2D, WebGL2RenderingContext.TEXTURE_MIN_FILTER,
      WebGL2RenderingContext.LINEAR);
  gl.texParameteri(
      WebGL2RenderingContext.TEXTURE_2D, WebGL2RenderingContext.TEXTURE_MAG_FILTER,
      WebGL2RenderingContext.LINEAR);
  // Prevents s-coordinate wrapping (repeating).  Repeating not permitted for non-power-of-2
  // textures.
  gl.texParameteri(
      WebGL2RenderingContext.TEXTURE_2D, WebGL2RenderingContext.TEXTURE_WRAP_S,
      WebGL2RenderingContext.CLAMP_TO_EDGE);
  // Prevents t-coordinate wrapping (repeating).  Repeating not permitted for non-power-of-2
  // textures.
  gl.texParameteri(
      WebGL2RenderingContext.TEXTURE_2D, WebGL2RenderingContext.TEXTURE_WRAP_T,
      WebGL2RenderingContext.CLAMP_TO_EDGE);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_FLIP_Y_WEBGL, 1);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(
      WebGL2RenderingContext.TEXTURE_2D, /*level=*/ 0,
      /*internalformat=*/ WebGL2RenderingContext.RGBA8,
      /*format=*/ WebGL2RenderingContext.RGBA, WebGL2RenderingContext.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_FLIP_Y_WEBGL, 0);
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
}
