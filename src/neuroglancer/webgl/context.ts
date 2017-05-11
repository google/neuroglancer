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

export interface GL extends WebGLRenderingContext {
  memoize: Memoize<any, RefCounted>;
  WEBGL_draw_buffers: any;
  ANGLE_instanced_arrays: any;
  maxTextureSize: number;
  maxTextureImageUnits: number;
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
      <GL>(canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options));
  if (gl == null) {
    throw new Error('WebGL not supported.');
  }
  gl.memoize = new Memoize<any, RefCounted>();
  gl.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  gl.maxTextureImageUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  gl.tempTextureUnit = gl.maxTextureImageUnits - 1;

  // FIXME: verify that we received a stencil buffer
  // var contextAttributes = gl.getContextAttributes();
  // var haveStencilBuffer = contextAttributes.stencil;

  gl.WEBGL_draw_buffers = gl.getExtension('WEBGL_draw_buffers');
  if (!gl.WEBGL_draw_buffers) {
    throw new Error('WEBGL_draw_buffers extension not available');
  }

  gl.ANGLE_instanced_arrays = gl.getExtension('ANGLE_instanced_arrays');
  if (!gl.ANGLE_instanced_arrays) {
    throw new Error('ANGLE_instanced_ararys extension not available');
  }

  for (let extension of ['OES_texture_float', 'OES_element_index_uint']) {
    if (!gl.getExtension(extension)) {
      throw new Error(`${extension} extension not available`);
    }
  }

  return gl;
}
