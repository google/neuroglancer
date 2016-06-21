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
export function setRawTextureParameters(gl: WebGLRenderingContext) {
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
    gl: GL, texture: WebGLTexture|null, width: number, height: number, format: number = gl.RGBA,
    dataType: number = gl.UNSIGNED_BYTE) {
  gl.activeTexture(gl.TEXTURE0 + gl.tempTextureUnit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  setRawTextureParameters(gl);
  gl.texImage2D(
      gl.TEXTURE_2D, 0,
      /*internalformat=*/format,
      /*width=*/width,
      /*height=*/height,
      /*border=*/0,
      /*format=*/format, dataType, <any>null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}
