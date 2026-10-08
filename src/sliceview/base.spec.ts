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

import { describe, it, expect } from "vitest";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type { TransformedSource } from "#src/sliceview/base.js";
import {
  estimateSliceAreaPerChunk,
  forEachVisibleVolumetricChunk,
  getNearIsotropicBlockSize,
} from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import { mat4, vec3 } from "#src/util/geom.js";

describe("sliceview/base", () => {
  it("getNearIsotropicBlockSize", () => {
    expect(
      getNearIsotropicBlockSize({
        rank: 3,
        displayRank: 3,
        chunkToViewTransform: Float32Array.of(
          1,
          0,
          0, //
          0,
          1,
          0, //
          0,
          0,
          1,
        ),
        maxVoxelsPerChunkLog2: 18,
      }),
    ).toEqual(Uint32Array.of(64, 64, 64));

    expect(
      getNearIsotropicBlockSize({
        rank: 3,
        displayRank: 3,
        chunkToViewTransform: Float32Array.of(
          2,
          0,
          0, //
          0,
          1,
          0, //
          0,
          0,
          1,
        ),
        maxVoxelsPerChunkLog2: 17,
      }),
    ).toEqual(Uint32Array.of(32, 64, 64));

    expect(
      getNearIsotropicBlockSize({
        rank: 3,
        displayRank: 3,
        chunkToViewTransform: Float32Array.of(
          3,
          0,
          0, //
          0,
          3,
          0, //
          0,
          0,
          30,
        ),
        maxVoxelsPerChunkLog2: 9,
      }),
    ).toEqual(Uint32Array.of(16, 16, 2));

    expect(
      getNearIsotropicBlockSize({
        rank: 4,
        displayRank: 3,
        chunkToViewTransform: Float32Array.of(
          3,
          0,
          0,
          0, //
          0,
          3,
          0,
          0, //
          0,
          0,
          30,
          0,
        ),
        maxVoxelsPerChunkLog2: 9,
        minBlockSize: Uint32Array.of(1, 1, 1, 8),
      }),
    ).toEqual(Uint32Array.of(8, 8, 1, 8));

    expect(
      getNearIsotropicBlockSize({
        rank: 3,
        displayRank: 3,
        chunkToViewTransform: Float32Array.of(
          3,
          0,
          0, //
          0,
          3,
          0, //
          0,
          0,
          30,
        ),
        upperVoxelBound: vec3.fromValues(1, 128, 128),
        maxVoxelsPerChunkLog2: 8,
      }),
    ).toEqual(Uint32Array.of(1, 64, 4));
  });
});

describe("estimateSliceAreaPerChunk", () => {
  it("works for identity chunk transform", () => {
    const chunkLayout = new ChunkLayout(
      vec3.fromValues(3, 4, 5),
      mat4.create(),
      3,
    );
    {
      const viewMatrix = Float32Array.from([
        1,
        0,
        0,
        0, //
        0,
        1,
        0,
        0, //
        0,
        0,
        1,
        0, //
        0,
        0,
        0,
        1, //
      ]) as mat4;
      expect(estimateSliceAreaPerChunk(chunkLayout, viewMatrix)).toEqual(3 * 4);
    }

    {
      const viewMatrix = Float32Array.from([
        0,
        1,
        0,
        0, //
        1,
        0,
        0,
        0, //
        0,
        0,
        1,
        0, //
        0,
        0,
        0,
        1, //
      ]) as mat4;
      expect(estimateSliceAreaPerChunk(chunkLayout, viewMatrix)).toEqual(3 * 4);
    }

    {
      const viewMatrix = Float32Array.from([
        1,
        0,
        0,
        0, //
        0,
        0,
        1,
        0, //
        0,
        1,
        0,
        0, //
        0,
        0,
        0,
        1, //
      ]) as mat4;
      expect(estimateSliceAreaPerChunk(chunkLayout, viewMatrix)).toEqual(3 * 5);
    }
  });
});

describe("forEachVisibleVolumetricChunk", () => {
  it("does not clamp zeroed display-dim positions to the chunk origin", () => {
    // `xy` slice view of a rank-3 volume whose origin is *not* at (0, 0, 0)
    const tsource = {
      source: {
        spec: {
          rank: 3,
          chunkDataSize: Uint32Array.of(1024, 1024, 1),
          // Stack origin at voxel (64056, 33042, 20) -> nonzero chunk bounds.
          lowerChunkBound: Float32Array.of(62, 32, 20),
          upperChunkBound: Float32Array.of(64, 34, 21),
        },
      },
      layerRank: 3,
      // The following data is prepared as would be done by
      // `getVolumetricTransformedSources`: display-dim rows (x, y) are zeroed and
      // z maps identically from global z with no translation.
      fixedLayerToChunkTransform: Float32Array.of(
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
      ),
      // Display dims (x, y) get infinite clip bounds; only z is finite.
      nonDisplayLowerClipBound: Float32Array.of(-Infinity, -Infinity, 20),
      nonDisplayUpperClipBound: Float32Array.of(Infinity, Infinity, 21),
      chunkLayout: new ChunkLayout(vec3.fromValues(1, 1, 1), mat4.create(), 3),
      lowerChunkDisplayBound: vec3.fromValues(62, 32, 20),
      upperChunkDisplayBound: vec3.fromValues(64, 34, 21),
      chunkDisplayDimensionIndices: [0, 1, 2],
      curPositionInChunks: new Float32Array(3),
      // Sentinel so an early return (source excluded) can't masquerade as a pass.
      fixedPositionWithinChunk: Uint32Array.of(999, 999, 999),
    } as unknown as TransformedSource;

    forEachVisibleVolumetricChunk(
      {
        // x/y are irrelevant (transform rows zeroed); z is at slice 20.
        globalPosition: Float32Array.of(70000, 40000, 20),
        viewProjectionMat: mat4.create(),
      } as unknown as ProjectionParameters,
      new Float32Array(0),
      tsource,
      () => {},
    );

    expect(Array.from(tsource.fixedPositionWithinChunk)).toEqual([0, 0, 0]);
  });
});
