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
import {Memoize} from 'neuroglancer/util/memoize';

export interface GL extends WebGL2RenderingContext {
  memoize: Memoize<any, RefCounted>;
  maxTextureSize: number;
  maxTextureImageUnits: number;
  max3dTextureSize: number;
  tempTextureUnit: number;
}

export const DEBUG_SHADERS = false;

export function initializeWebGL(canvas: HTMLCanvasElement) {
  let options: any = {
    'antialias': false,
    'stencil': true,
  };
  if (DEBUG_SHADERS) {
    console.log('DEBUGGING via preserveDrawingBuffer');
    options['preserveDrawingBuffer'] = true;
  }
  let gl =
      <GL>canvas.getContext('webgl2', options);
  if (gl == null) {
    throw new Error('WebGL not supported.');
  }
  gl.memoize = new Memoize<any, RefCounted>();
  gl.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  gl.max3dTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  gl.maxTextureImageUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  gl.tempTextureUnit = gl.maxTextureImageUnits - 1;

  // FIXME: verify that we received a stencil buffer
  // var contextAttributes = gl.getContextAttributes();
  // var haveStencilBuffer = contextAttributes.stencil;

  for (const extension of ['EXT_color_buffer_float']) {
    if (!gl.getExtension(extension)) {
      throw new Error(`${extension} extension not available`);
    }
  }

  // Extensions to attempt to add but not fail if they are not available.
  for (const extension of [
           // Some versions of Firefox 67.0 seem to require this extension being added in addition
           // to EXT_color_buffer_float, despite the note here indicating it is unnecessary:
           // https://developer.mozilla.org/en-US/docs/Web/API/EXT_float_blend
           //
           // See https://github.com/google/neuroglancer/issues/140
           'EXT_float_blend',
  ]) {
    gl.getExtension(extension);
  }
  return gl;
}
