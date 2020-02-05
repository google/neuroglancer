/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2020 Howard Hughes Medical Institute
 *
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

import {SkeletonChunk} from 'neuroglancer/skeleton/backend';

export function decodeSwcSkeletonChunk(chunk: SkeletonChunk, swcStr: string) {
  let swcObjects: Array<PointObj> = parseSwc(swcStr);

  if (swcObjects.length < 1) {
    throw new Error(`ERROR parsing swc data`);
  }

  let indexMap = new Uint32Array(swcObjects.length);

  let nodeCount = 0;
  let edgeCount = 0;
  swcObjects.forEach((swcObj, i) => {
    if (swcObj) {
      indexMap[i] = nodeCount++;
      if (swcObj.parent >= 0) {
        ++edgeCount;
      }
    }
  });

  let glVertices = new Float32Array(3 * nodeCount);
  let glIndices = new Uint32Array(2 * edgeCount);

  let nodeIndex = 0;
  let edgetIndex = 0;
  swcObjects.forEach(function(swcObj) {
    if (swcObj) {
      glVertices[3 * nodeIndex] = swcObj.x;
      glVertices[3 * nodeIndex + 1] = swcObj.y;
      glVertices[3 * nodeIndex + 2] = swcObj.z;

      if (swcObj.parent >= 0) {
        glIndices[2 * edgetIndex] = nodeIndex;
        glIndices[2 * edgetIndex + 1] = indexMap[swcObj.parent];
        ++edgetIndex;
      }
      ++nodeIndex;
    }
  });

  chunk.indices = glIndices;
  chunk.vertexPositions = glVertices;
}

/*
 * Parses a standard SWC file into an array of point objects
 * modified from
 * https://github.com/JaneliaSciComp/SharkViewer/blob/d9969a7c513beee32ff9650b00bf79cda8f3c76a/html/js/sharkviewer_loader.js
 */
function parseSwc(swcStr: string) {
  let swcInputAr = swcStr.split('\n');
  let swcObjectsAr: Array<PointObj> = new Array();
  let float = '-?\\d*(?:\\.\\d+)?';
  let pattern = new RegExp('^[ \\t]*(' + [
    '\\d+',    // index
    '\\d+',    // type
    float,     // x
    float,     // y
    float,     // z
    float,     // radius
    '-1|\\d+'  // parent
  ].join(')[ \\t]+(') + ')[ \\t]*$');

  swcInputAr.forEach(function(e) {
    // if line meets swc point criteria, add it to the array
    let match = e.match(pattern);
    if (match) {
      let point = swcObjectsAr[parseInt(match[1], 10)] = new PointObj();
      point.type = parseInt(match[2], 10);
      point.x = parseFloat(match[3]);
      point.y = parseFloat(match[4]);
      point.z = parseFloat(match[5]);
      point.radius = parseFloat(match[6]);
      point.parent = parseInt(match[7], 10);
    }
  });
  return swcObjectsAr;
}

class PointObj {
  type: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  parent: number;
}
