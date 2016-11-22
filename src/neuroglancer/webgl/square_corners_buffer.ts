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

import {RefCountedValue} from 'neuroglancer/util/disposable';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL_ARRAY_BUFFER, GL_STATIC_DRAW} from 'neuroglancer/webgl/constants';
import {GL} from 'neuroglancer/webgl/context';

export function getSquareCornersBuffer(gl: GL, startX = -1, startY = -1, endX = 1, endY = 1) {
  return gl.memoize
      .get(
          `SquareCornersBuffer:${startX},${startY},${endX},${endY}`,
          () => new RefCountedValue(Buffer.fromData(
              gl, new Float32Array([
                startX, startY,  //
                startX, endY,    //
                endX, endY,      //
                endX, startY,    //
              ]),
              GL_ARRAY_BUFFER, GL_STATIC_DRAW)))
      .value;
}
