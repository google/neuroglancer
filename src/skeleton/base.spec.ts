/**
 * @license
 * Copyright 2026 Google Inc.
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

import { describe, expect, it } from "vitest";

import { ProjectionParameters } from "#src/projection_parameters.js";
import {
  forEachSpatialSkeletonSourceScale,
  forEachVisibleSpatialSkeletonChunk,
} from "#src/skeleton/base.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import { mat4, vec3 } from "#src/util/geom.js";

describe("forEachVisibleSpatialSkeletonChunk", () => {
  function makeProjectionParameters() {
    const projectionParameters = new ProjectionParameters();
    projectionParameters.width = 1000;
    projectionParameters.height = 1000;
    projectionParameters.logicalWidth = 1000;
    projectionParameters.logicalHeight = 1000;
    projectionParameters.visibleWidthFraction = 1;
    projectionParameters.visibleHeightFraction = 1;
    projectionParameters.globalPosition = new Float32Array(0);
    projectionParameters.displayDimensionRenderInfo = {
      voxelPhysicalScales: Float32Array.of(1, 1, 1),
    } as any;
    return projectionParameters;
  }

  function makeTransformedSource(
    label: string,
    chunkSize: number,
    limit: number,
  ) {
    const chunkDataSize = Uint32Array.of(chunkSize, chunkSize, chunkSize);
    const chunkLayout = new ChunkLayout(
      vec3.fromValues(chunkSize, chunkSize, chunkSize),
      mat4.create(),
      3,
    );
    const spec = {
      ...makeSliceViewChunkSpecification({
        rank: 3,
        chunkDataSize,
        lowerVoxelBound: Float32Array.of(0, 0, 0),
        upperVoxelBound: Float32Array.of(chunkSize, chunkSize, chunkSize),
      }),
      chunkLayout,
      limit,
    };
    return {
      label,
      renderLayer: {
        localPosition: { value: new Float32Array(0) },
        renderScaleTarget: { value: 1 },
      },
      source: { label, spec, dispose: () => {} },
      effectiveVoxelSize: vec3.fromValues(1, 1, 1),
      chunkLayout,
      nonDisplayLowerClipBound: Float32Array.of(
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ),
      nonDisplayUpperClipBound: Float32Array.of(
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ),
      lowerClipBound: Float32Array.of(0, 0, 0),
      upperClipBound: Float32Array.of(chunkSize, chunkSize, chunkSize),
      lowerClipDisplayBound: vec3.fromValues(0, 0, 0),
      upperClipDisplayBound: vec3.fromValues(1, 1, 1),
      lowerChunkDisplayBound: vec3.fromValues(0, 0, 0),
      upperChunkDisplayBound: vec3.fromValues(1, 1, 1),
      chunkDisplayDimensionIndices: [0, 1, 2],
      layerRank: 3,
      combinedGlobalLocalToChunkTransform: Float32Array.of(0, 0, 0),
      fixedLayerToChunkTransform: Float32Array.of(0, 0, 0),
      curPositionInChunks: Float32Array.of(0, 0, 0),
      fixedPositionWithinChunk: new Uint32Array(3),
    };
  }

  it("visits only the selected source level", () => {
    const projectionParameters = makeProjectionParameters();
    const coarse = makeTransformedSource("coarse", 4, 1);
    const fine = makeTransformedSource("fine", 1, 1000);
    const begun: string[] = [];
    const visited: string[] = [];

    forEachVisibleSpatialSkeletonChunk(
      projectionParameters,
      new Float32Array(0),
      1,
      [coarse, fine],
      (source) => {
        begun.push((source as any).label);
      },
      (source) => {
        visited.push((source as any).label);
      },
    );

    expect(begun).toEqual(["fine"]);
    expect(visited).toEqual(["fine"]);
  });

  it("reports every source level scale while marking only the selected source", () => {
    const projectionParameters = makeProjectionParameters();
    const coarse = makeTransformedSource("coarse", 4, 1);
    const fine = makeTransformedSource("fine", 1, 1000);
    const reported: Array<{ label: string; selected: boolean }> = [];

    forEachSpatialSkeletonSourceScale(
      projectionParameters,
      1,
      [coarse, fine],
      (source, _index, _physicalSpacing, _pixelSpacing, selected) => {
        reported.push({
          label: (source as any).label,
          selected,
        });
      },
    );

    expect(reported).toEqual([
      { label: "coarse", selected: false },
      { label: "fine", selected: true },
    ]);
  });
});
