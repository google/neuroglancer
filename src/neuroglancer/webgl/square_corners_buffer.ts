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

import {tile2dArray} from 'neuroglancer/util/array';
import {getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';

export function getSquareCornersArray(
    startX = -1, startY = -1, endX = 1, endY = 1, minorTiles = 1, majorTiles = 1) {
  return tile2dArray(
      new Float32Array([
        startX, startY,  //
        startX, endY,    //
        endX, endY,      //
        endX, startY,    //
      ]),
      /*majorDimension=*/2, minorTiles, majorTiles);
}

export function getCubeCornersArray(
    startX = -1, startY = -1, startZ = -1, endX = 1, endY = 1, endZ = 1, minorTiles = 1,
    majorTiles = 1) {
  return tile2dArray(
      new Float32Array([
        startX, startY, startZ,  //
        endX,   startY, startZ,  //
        startX, endY,   startZ,  //
        endX,   endY,   startZ,  //
        startX, startY, endZ,    //
        endX,   startY, endZ,    //
        startX, endY,   endZ,    //
        endX,   endY,   endZ,    //
      ]),
      /*majorDimension=*/3, minorTiles, majorTiles);
}

export function getSquareCornersBuffer(
    gl: GL, startX = -1, startY = -1, endX = 1, endY = 1, minorTiles = 1, majorTiles = 1) {
  return getMemoizedBuffer(
             gl, WebGL2RenderingContext.ARRAY_BUFFER, getSquareCornersArray, startX, startY, endX,
             endY, minorTiles, majorTiles)
      .value;
}
