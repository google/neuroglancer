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

import {getDesiredMultiscaleMeshChunks, getMultiscaleChunksToDraw, MultiscaleMeshManifest} from 'neuroglancer/mesh/multiscale';
import {getFrustrumPlanes, mat4, vec3} from 'neuroglancer/util/geom';

interface MultiscaleChunkResult {
  lod: number;
  row: number;
  renderScale: number;
  empty: number;
}

function getDesiredChunkList(
    manifest: MultiscaleMeshManifest, modelViewProjection: mat4, detailCutoff: number,
    viewportWidth: number, viewportHeight: number): MultiscaleChunkResult[] {
  const results: MultiscaleChunkResult[] = [];
  getDesiredMultiscaleMeshChunks(
      manifest, modelViewProjection, getFrustrumPlanes(new Float32Array(24), modelViewProjection),
      detailCutoff, viewportWidth, viewportHeight, (lod, row, renderScale, empty) => {
        results.push({lod, row, renderScale, empty});
      });
  return results;
}

interface MultiscaleChunkDrawResult {
  lod: number;
  row: number;
  renderScale: number;
  subChunkBegin: number;
  subChunkEnd: number;
}

function getDrawChunkList(
    manifest: MultiscaleMeshManifest, modelViewProjection: mat4, detailCutoff: number,
    viewportWidth: number, viewportHeight: number,
    hasChunk: (row: number) => boolean): MultiscaleChunkDrawResult[] {
  const results: MultiscaleChunkDrawResult[] = [];
  getMultiscaleChunksToDraw(
      manifest, modelViewProjection, getFrustrumPlanes(new Float32Array(24), modelViewProjection),
      detailCutoff, viewportWidth, viewportHeight,
      (_lod, row, _renderScale) => {
        return hasChunk(row);
      },
      (lod, row, subChunkBegin, subChunkEnd, renderScale) => {
        results.push({lod, row, subChunkBegin, subChunkEnd, renderScale});
      });
  return results;
}

describe('multiscale', () => {
  it('getDesiredMultiscaleMeshChunks simple', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(20, 23, -50),
      clipUpperBound: vec3.fromValues(40, 45, -20),
      lodScales: Float32Array.of(20, 40),
      vertexOffsets: new Float32Array(2 * 3),
      octree: Uint32Array.from([
        0, 0, 0, 0, 0,  // row 0, lod 0
        0, 0, 0, 0, 1,  // row 0, lod 1
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
        mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);
    expect(
        getDesiredChunkList(
            manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight))
        .toEqual([{
          lod: 1,
          renderScale: 960,
          row: 1,
          empty: 0,
        }]);

    expect(getDesiredChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 800, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 960,
            row: 1,
            empty: 0,
          },
          {
            lod: 0,
            renderScale: 480,
            row: 0,
            empty: 0,
          }
        ]);
  });

  it('getDesiredMultiscaleMeshChunks multiple chunks 2 lods', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(5, 6, -50),
      clipUpperBound: vec3.fromValues(100, 200, 10),
      lodScales: Float32Array.of(20, 40),
      vertexOffsets: new Float32Array(2 * 3),
      octree: Uint32Array.from([
        0, 0, 0, 0, 0,  // row 0, lod 0
        1, 0, 0, 0, 0,  // row 1, lod 0
        0, 1, 0, 0, 0,  // row 2, lod 0
        1, 1, 0, 0, 0,  // row 3, lod 0
        0, 0, 1, 0, 0,  // row 4, lod 0
        1, 0, 1, 0, 0,  // row 5, lod 0
        0, 1, 1, 0, 0,  // row 6, lod 0
        1, 1, 1, 0, 0,  // row 7, lod 0
        0, 0, 0, 0, 8,  // row 8, lod 1
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
        mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);

    expect(
        getDesiredChunkList(
            manifest, modelViewProjection, /*detailCutoff=*/ 4000, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            row: 8,
            empty: 0,
          },

        ]);

    expect(
        getDesiredChunkList(
            manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            row: 8,
            empty: 0,
          },
          {
            lod: 0,
            renderScale: 1920,
            row: 4,
            empty: 0,
          },
          {
            lod: 0,
            renderScale: 1920,
            row: 5,
            empty: 0,
          },

        ]);

    expect(getDesiredChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 800, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            row: 8,
            empty: 0,
          },
          {
            lod: 0,
            renderScale: 480,
            row: 0,
            empty: 0,
          },
          {
            lod: 0,
            renderScale: 480,
            row: 1,
            empty: 0,
          },
          {
            lod: 0,
            renderScale: 480,
            empty: 0,
            row: 2,
          },
          {
            lod: 0,
            renderScale: 480,
            empty: 0,
            row: 3,
          },
          {
            lod: 0,
            renderScale: 1920,
            empty: 0,
            row: 4,
          },
          {
            lod: 0,
            renderScale: 1920,
            empty: 0,
            row: 5,
          },
        ]);
  });

  it('getMultiscaleChunksToDraw multiple chunks 2 lods', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(5, 6, -50),
      clipUpperBound: vec3.fromValues(100, 200, 10),
      lodScales: Float32Array.of(20, 40),
      vertexOffsets: new Float32Array(2 * 3),
      octree: Uint32Array.from([
        0, 0, 0, 0, 0,  // row 0, lod 0
        1, 0, 0, 0, 0,  // row 1, lod 0
        0, 1, 0, 0, 0,  // row 2, lod 0
        1, 1, 0, 0, 0,  // row 3, lod 0
        0, 0, 1, 0, 0,  // row 4, lod 0
        1, 0, 1, 0, 0,  // row 5, lod 0
        0, 1, 1, 0, 0,  // row 6, lod 0
        1, 1, 1, 0, 0,  // row 7, lod 0
        0, 0, 0, 0, 8,  // row 8, lod 1
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
        mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);

    expect(getDrawChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 4000, viewportWidth, viewportHeight,
               () => true))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            row: 8,
            subChunkBegin: 0,
            subChunkEnd: 8,
          },

        ]);

    expect(getDrawChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight,
               row => row !== 4))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            row: 8,
            subChunkBegin: 0,
            subChunkEnd: 5,
          },
          {
            lod: 0,
            renderScale: 1920,
            row: 5,
            subChunkBegin: 0,
            subChunkEnd: 1,
          },
          {
            lod: 1,
            renderScale: 3840,
            row: 8,
            subChunkBegin: 6,
            subChunkEnd: 8,
          },

        ]);
  });

  it('getMultiscaleChunksToDraw multiple chunks 2 lods with missing', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(5, 6, -50),
      clipUpperBound: vec3.fromValues(100, 200, 10),
      lodScales: Float32Array.of(20, 40),
      vertexOffsets: new Float32Array(2 * 3),
      octree: Uint32Array.from([
        0, 0, 0, 0, 0,  // row 0, lod 0
        1, 0, 0, 0, 0,  // row 1, lod 0
        0, 1, 0, 0, 0,  // row 2, lod 0
        1, 1, 0, 0, 0,  // row 3, lod 0
        0, 0, 1, 0, 0,  // row 4, lod 0
        1, 0, 1, 0, 0,  // row 5, lod 0
        0, 1, 1, 0, 0,  // row 6, lod 0
        1, 1, 1, 0, 0,  // row 7, lod 0
        0, 0, 0, 0, 8,  // row 8, lod 1
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
        mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);

    expect(getDrawChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight,
               row => row !== 8))
        .toEqual([]);
  });

  it('getMultiscaleChunksToDraw multiple chunks 2 lods with empty', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(5, 6, -50),
      clipUpperBound: vec3.fromValues(100, 200, 10),
      lodScales: Float32Array.of(20, 40),
      vertexOffsets: new Float32Array(2 * 3),
      octree: Uint32Array.from([
        0, 0, 0, 0, 0,           // row 0, lod 0
        1, 0, 0, 0, 0,           // row 1, lod 0
        0, 1, 0, 0, 0,           // row 2, lod 0
        1, 1, 0, 0, 0,           // row 3, lod 0
        0, 0, 1, 0, 0,           // row 4, lod 0
        1, 0, 1, 0, 0,           // row 5, lod 0
        0, 1, 1, 0, 0,           // row 6, lod 0
        1, 1, 1, 0, 0,           // row 7, lod 0
        0, 0, 0, 0, 0x80000008,  // row 8, lod 1
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
        mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);

    expect(getDrawChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight,
               () => true))
        .toEqual([
          {
            lod: 0,
            renderScale: 1920,
            row: 4,
            subChunkBegin: 0,
            subChunkEnd: 1,
          },
          {
            lod: 0,
            renderScale: 1920,
            row: 5,
            subChunkBegin: 0,
            subChunkEnd: 1,
          },
        ]);
    expect(getDrawChunkList(
               manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight,
               row => row !== 4))
        .toEqual([
          {
            lod: 0,
            renderScale: 1920,
            row: 5,
            subChunkBegin: 0,
            subChunkEnd: 1,
          },
        ]);
  });

  it('getDesiredMultiscaleMeshChunks multiple chunks 2 lods with empty', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(5, 6, -50),
      clipUpperBound: vec3.fromValues(100, 200, 10),
      lodScales: Float32Array.of(20, 40),
      vertexOffsets: new Float32Array(2 * 3),
      octree: Uint32Array.from([
        0, 0, 0, 0, 0,           // row 0, lod 0
        1, 0, 0, 0, 0,           // row 1, lod 0
        0, 1, 0, 0, 0,           // row 2, lod 0
        1, 1, 0, 0, 0,           // row 3, lod 0
        0, 0, 1, 0, 0x80000000,  // row 4, lod 0
        1, 0, 1, 0, 0,           // row 5, lod 0
        0, 1, 1, 0, 0,           // row 6, lod 0
        1, 1, 1, 0, 0,           // row 7, lod 0
        0, 0, 0, 0, 8,           // row 8, lod 1
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
        mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);

    expect(
        getDesiredChunkList(
            manifest, modelViewProjection, /*detailCutoff=*/ 1000, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 1,
            renderScale: 3840,
            row: 8,
            empty: 0,
          },
          {
            lod: 0,
            renderScale: 1920,
            row: 4,
            empty: 1,
          },
          {
            lod: 0,
            renderScale: 1920,
            row: 5,
            empty: 0,
          },

        ]);
  });

  it('getDesiredMultiscaleMeshChunks multiple chunks 4 lods', () => {
    const manifest: MultiscaleMeshManifest = {
      chunkShape: vec3.fromValues(10, 20, 30),
      chunkGridSpatialOrigin: vec3.fromValues(5, 6, -50),
      clipLowerBound: vec3.fromValues(5, 6, -50),
      clipUpperBound: vec3.fromValues(100, 200, 10),
      lodScales: Float32Array.of(20, 40, 80, 160, 0),
      vertexOffsets: new Float32Array(5 * 3),
      octree: Uint32Array.from([
        5,  3, 0, 0,  0,   // row 0: lod=0
        7,  0, 3, 0,  0,   // row 1: lod=0
        7,  1, 3, 0,  0,   // row 2: lod=0
        7,  3, 2, 0,  0,   // row 3: lod=0
        1,  7, 0, 0,  0,   // row 4: lod=0
        2,  7, 0, 0,  0,   // row 5: lod=0
        5,  4, 0, 0,  0,   // row 6: lod=0
        6,  4, 0, 0,  0,   // row 7: lod=0
        6,  4, 1, 0,  0,   // row 8: lod=0
        6,  5, 1, 0,  0,   // row 9: lod=0
        7,  5, 1, 0,  0,   // row 10: lod=0
        4,  7, 1, 0,  0,   // row 11: lod=0
        5,  7, 1, 0,  0,   // row 12: lod=0
        6,  6, 1, 0,  0,   // row 13: lod=0
        7,  6, 1, 0,  0,   // row 14: lod=0
        6,  7, 1, 0,  0,   // row 15: lod=0
        7,  7, 1, 0,  0,   // row 16: lod=0
        7,  4, 2, 0,  0,   // row 17: lod=0
        7,  5, 2, 0,  0,   // row 18: lod=0
        6,  7, 2, 0,  0,   // row 19: lod=0
        7,  7, 2, 0,  0,   // row 20: lod=0
        7,  7, 3, 0,  0,   // row 21: lod=0
        7,  6, 4, 0,  0,   // row 22: lod=0
        7,  7, 4, 0,  0,   // row 23: lod=0
        10, 3, 0, 0,  0,   // row 24: lod=0
        11, 3, 0, 0,  0,   // row 25: lod=0
        8,  1, 2, 0,  0,   // row 26: lod=0
        9,  1, 2, 0,  0,   // row 27: lod=0
        8,  0, 3, 0,  0,   // row 28: lod=0
        9,  0, 3, 0,  0,   // row 29: lod=0
        8,  1, 3, 0,  0,   // row 30: lod=0
        9,  1, 3, 0,  0,   // row 31: lod=0
        10, 0, 2, 0,  0,   // row 32: lod=0
        2,  1, 0, 0,  1,   // row 33: lod=1
        3,  0, 1, 1,  3,   // row 34: lod=1
        3,  1, 1, 3,  4,   // row 35: lod=1
        0,  3, 0, 4,  5,   // row 36: lod=1
        1,  3, 0, 5,  6,   // row 37: lod=1
        2,  2, 0, 6,  7,   // row 38: lod=1
        3,  2, 0, 7,  11,  // row 39: lod=1
        2,  3, 0, 11, 13,  // row 40: lod=1
        3,  3, 0, 13, 17,  // row 41: lod=1
        3,  2, 1, 17, 19,  // row 42: lod=1
        3,  3, 1, 19, 22,  // row 43: lod=1
        3,  3, 2, 22, 24,  // row 44: lod=1
        5,  1, 0, 24, 26,  // row 45: lod=1
        4,  0, 1, 26, 32,  // row 46: lod=1
        5,  0, 1, 32, 33,  // row 47: lod=1
        1,  0, 0, 33, 36,  // row 48: lod=2
        0,  1, 0, 36, 38,  // row 49: lod=2
        1,  1, 0, 38, 44,  // row 50: lod=2
        1,  1, 1, 44, 45,  // row 51: lod=2
        2,  0, 0, 45, 48,  // row 52: lod=2
        0,  0, 0, 48, 52,  // row 53: lod=3
        1,  0, 0, 52, 53,  // row 54: lod=3
        0,  0, 0, 53, 55,  // row 55: lod=4
      ]),
    };
    const viewportWidth = 640;
    const viewportHeight = 480;
    const modelViewProjection =
        mat4.perspective(mat4.create(), Math.PI / 2, viewportWidth / viewportHeight, 5, 100);

    expect(
        getDesiredChunkList(
            manifest, modelViewProjection, /*detailCutoff=*/ 100000, viewportWidth, viewportHeight))
        .toEqual([
          {
            lod: 3,
            renderScale: 15360,
            row: 53,
            empty: 0,
          },

        ]);
  });
});
