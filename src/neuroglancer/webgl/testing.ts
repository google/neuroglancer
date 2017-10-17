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

import {GL, initializeWebGL} from './context';

export function webglTest(f: (gl: GL, canvas: HTMLCanvasElement) => void) {
  let canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  try {
    let gl = initializeWebGL(canvas);
    f(gl, canvas);
  } finally {
    document.body.removeChild(canvas);
  }
}
