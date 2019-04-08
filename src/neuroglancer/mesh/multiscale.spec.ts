/**
 * @license
 * Copyright 2019 Google Inc.
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

import {getDesiredMultiscaleMeshChunks, MultiscaleMeshManifest} from 'neuroglancer/mesh/multiscale';
import {getFrustrumPlanes, mat4, vec3} from 'neuroglancer/util/geom';

interface MultiscaleChunkResult {
  lod: number;
  renderScale: number;
  beginIndex: number;
  endIndex: number;
}

function getChunkList(
    manifest: MultiscaleMeshManifest, modelViewProjection: mat4, detailCutoff: number,
    viewportWidth: number, viewportHeight: number): MultiscaleChunkResult[] {
  const results: MultiscaleChunkResult[] = [];
  getDesiredMultiscaleMeshChunks(
      manifest, modelViewProjection, getFrustrumPlanes(new Float32Array(24), modelViewProjection),
      detailCutoff, viewportWidth, viewportHeight, (lod, beginIndex, endIndex, renderScale) => {
        results.push({lod, renderScale, beginIndex, endIndex});
      });
  return results;
}


describe('multiscale', () => {
  it('getMultiscaleChunksToDraw simple', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(20, 23, -50),
      clipUpperBound: vec3.fromValues(40, 45, -20),
      lodScales: [20, 40],
      chunkCoordinates: Uint32Array.from([
        0, 0, 0,  //
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
        mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);
    expect(getChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight))
        .toEqual([{
          lod: 1,
          renderScale: 960,
          beginIndex: 0,
          endIndex: 1,
        }]);

    expect(getChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 800, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 960,
            beginIndex: 0,
            endIndex: 1,
          },
          {
            lod: 0,
            renderScale: 480,
            beginIndex: 0,
            endIndex: 1,
          }
        ]);
  });

  it('getMultiscaleChunksToDraw multiple chunks 2 lods', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(5, 6, -50),
      clipUpperBound: vec3.fromValues(100, 200, 10),
      lodScales: [20, 40],
      chunkCoordinates: Uint32Array.from([
        0, 0, 0,  //
        1, 0, 0, //
        0, 1, 0, //
        1, 1, 0, //
        0, 0, 1,  //
        1, 0, 1, //
        0, 1, 1, //
        1, 1, 1, //
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
      mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);

    expect(
        getChunkList(
            manifest, modelViewProjection, /*detailCutoff=*/ 4000, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            beginIndex: 0,
            endIndex: 8,
          },

        ]);

    expect(
        getChunkList(
            manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            beginIndex: 0,
            endIndex: 8,
          },
          {
            lod: 0,
            renderScale: 1920,
            beginIndex: 4,
            endIndex: 5,
          },
          {
            lod: 0,
            renderScale: 1920,
            beginIndex: 5,
            endIndex: 6,
          },

        ]);

    expect(getChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 800, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            beginIndex: 0,
            endIndex: 8,
          },
          {
            lod: 0,
            renderScale: 480,
            beginIndex: 0,
            endIndex: 1,
          },
          {
            lod: 0,
            renderScale: 480,
            beginIndex: 1,
            endIndex: 2,
          },
          {
            lod: 0,
            renderScale: 480,
            beginIndex: 2,
            endIndex: 3,
          },
          {
            lod: 0,
            renderScale: 480,
            beginIndex: 3,
            endIndex: 4,
          },
          {
            lod: 0,
            renderScale: 1920,
            beginIndex: 4,
            endIndex: 5,
          },
          {
            lod: 0,
            renderScale: 1920,
            beginIndex: 5,
            endIndex: 6,
          },
        ]);
  });

  it('getMultiscaleChunksToDraw multiple chunks 4 lods', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(5, 6, -50),
      clipUpperBound: vec3.fromValues(100, 200, 10),
      lodScales: [20, 40, 80, 160, 0],
      chunkCoordinates: Uint32Array.from([
        5,  3, 0,  //
        7,  0, 3,  //
        7,  1, 3,  //
        7,  3, 2,  //
        1,  7, 0,  //
        2,  7, 0,  //
        5,  4, 0,  //
        6,  4, 0,  //
        6,  4, 1,  //
        6,  5, 1,  //
        7,  5, 1,  //
        4,  7, 1,  //
        5,  7, 1,  //
        6,  6, 1,  //
        7,  6, 1,  //
        6,  7, 1,  //
        7,  7, 1,  //
        7,  4, 2,  //
        7,  5, 2,  //
        6,  7, 2,  //
        7,  7, 2,  //
        7,  7, 3,  //
        7,  6, 4,  //
        7,  7, 4,  //
        10, 3, 0,  //
        11, 3, 0,  //
        8,  1, 2,  //
        9,  1, 2,  //
        8,  0, 3,  //
        9,  0, 3,  //
        8,  1, 3,  //
        9,  1, 3,  //
        10, 0, 2,  //
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
      mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);

    expect(
        getChunkList(
            manifest, modelViewProjection, /*detailCutoff=*/ 100000, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 3,
            renderScale: 15360,
            beginIndex: 0,
            endIndex: 24,
          },

        ]);
  });
});
