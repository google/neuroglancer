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

import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import { ProjectionParameters } from "#src/projection_parameters.js";
import { RenderScaleHistogram } from "#src/render_scale_statistics.js";
import {
  forEachSpatialSkeletonSourceScale,
  forEachVisibleSpatialSkeletonChunk,
  getSpatialSkeletonLevelSpecs,
  getSpatialSkeletonSourceScalesByLimit,
  selectSpatialSkeletonSourceByLimit,
  SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR,
} from "#src/skeleton/spatial/base.js";
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

describe("skeleton/source_selection", () => {
  it("selects exactly one coarse source when it satisfies the density target", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 200,
          sliceFraction: 1,
        },
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 500,
          sliceFraction: 1,
        },
      ],
      0.1,
      1000,
      100,
    );

    expect(selection?.source).toBe("coarse");
    expect(selection?.physicalDensity).toBeCloseTo(0.2);
  });

  it("selects a finer positive-limit source when coarser sources are too sparse", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 10,
          sliceFraction: 1,
        },
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 500,
          sliceFraction: 1,
        },
      ],
      0.1,
      1000,
      100,
    );

    expect(selection?.source).toBe("fine");
    expect(selection?.physicalDensity).toBeCloseTo(4);
  });

  it("falls back to the finest positive-limit source when no source satisfies the target", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 10,
          sliceFraction: 1,
        },
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 10,
          sliceFraction: 1,
        },
      ],
      100,
      1000,
      100,
    );

    expect(selection?.source).toBe("fine");
    expect(selection?.physicalDensity).toBeCloseTo(0.08);
  });

  it("selects a finest zero-limit source when positive-limit sources are too sparse", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 10,
          sliceFraction: 1,
        },
        {
          source: "complete-finest",
          index: 1,
          physicalVolume: 125,
          limit: 0,
          sliceFraction: 1,
        },
      ],
      100,
      1000,
      100,
    );

    expect(selection?.source).toBe("complete-finest");
    expect(selection?.physicalDensity).toBe(Number.POSITIVE_INFINITY);
    expect(selection?.physicalSpacing).toBe(0);
    expect(selection?.pixelSpacing).toBe(0);
  });

  it("places the zero-limit finest source left of every capped source in the histogram", () => {
    const [coarse, finest] = getSpatialSkeletonSourceScalesByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 10,
          sliceFraction: 1,
        },
        {
          source: "complete-finest",
          index: 1,
          physicalVolume: 125,
          limit: 0,
          sliceFraction: 1,
        },
      ],
      1000,
      100,
    );
    const histogram = new RenderScaleHistogram();
    histogram.add(coarse.physicalSpacing, coarse.pixelSpacing, 1, 0);
    histogram.add(finest.physicalSpacing, finest.pixelSpacing, 1, 0);

    const binOf = (spacing: number) => {
      const rowStart =
        histogram.spatialScales.get(spacing)! * 2 * histogram.numBins;
      return histogram.value
        .slice(rowStart, rowStart + histogram.numBins)
        .findIndex((count) => count > 0);
    };
    expect(binOf(finest.physicalSpacing)).toBe(0);
    expect(binOf(coarse.physicalSpacing)).toBeGreaterThan(0);
  });

  it("does not select a finest zero-limit source if a coarser source satisfies the target", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 200,
          sliceFraction: 1,
        },
        {
          source: "complete-finest",
          index: 1,
          physicalVolume: 125,
          limit: 0,
          sliceFraction: 1,
        },
      ],
      0.1,
      1000,
      100,
    );

    expect(selection?.source).toBe("coarse");
  });

  it("rejects a non-finest zero-limit source", () => {
    expect(() =>
      selectSpatialSkeletonSourceByLimit(
        [
          {
            source: "complete-coarse",
            index: 0,
            physicalVolume: 1000,
            limit: 0,
            sliceFraction: 1,
          },
          {
            source: "fine",
            index: 1,
            physicalVolume: 125,
            limit: 500,
            sliceFraction: 1,
          },
        ],
        0.1,
        1000,
        100,
      ),
    ).toThrow(SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR);
  });

  it("rejects multiple zero-limit sources unless there is only one source", () => {
    expect(() =>
      selectSpatialSkeletonSourceByLimit(
        [
          {
            source: "complete-coarse",
            index: 0,
            physicalVolume: 1000,
            limit: 0,
            sliceFraction: 1,
          },
          {
            source: "complete-fine",
            index: 1,
            physicalVolume: 125,
            limit: 0,
            sliceFraction: 1,
          },
        ],
        0.1,
        1000,
        100,
      ),
    ).toThrow(SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR);

    expect(
      selectSpatialSkeletonSourceByLimit(
        [
          {
            source: "single-complete",
            index: 0,
            physicalVolume: 1000,
            limit: 0,
            sliceFraction: 1,
          },
        ],
        0.1,
        1000,
        100,
      )?.source,
    ).toBe("single-complete");
  });

  it("uses the provided source order rather than sorting by physical volume", () => {
    const selection = selectSpatialSkeletonSourceByLimit(
      [
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 500,
          sliceFraction: 1,
        },
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 200,
          sliceFraction: 1,
        },
      ],
      0.1,
      1000,
      100,
    );

    expect(selection?.source).toBe("fine");
  });

  it("reports all source scales in source order for histogram indicators", () => {
    const scales = getSpatialSkeletonSourceScalesByLimit(
      [
        {
          source: "fine",
          index: 1,
          physicalVolume: 125,
          limit: 500,
          sliceFraction: 1,
        },
        {
          source: "coarse",
          index: 0,
          physicalVolume: 1000,
          limit: 200,
          sliceFraction: 1,
        },
      ],
      1000,
      100,
    );

    expect(scales.map((scale) => scale.source)).toEqual(["fine", "coarse"]);
    expect(scales[0].physicalDensity).toBeCloseTo(4);
    expect(scales[1].physicalDensity).toBeCloseTo(0.2);
  });
});

function makeNanometerSpace(
  lowerBounds: number[],
  upperBounds: number[],
  rank = 3,
) {
  return makeCoordinateSpace({
    names: ["x", "y", "z", "t"].slice(0, rank),
    units: Array(rank).fill("m"),
    scales: Float64Array.from(Array(rank).fill(1e-9)),
    boundingBoxes: [
      {
        box: {
          lowerBounds: Float64Array.from(lowerBounds),
          upperBounds: Float64Array.from(upperBounds),
        },
        transform: Float64Array.from(
          Array.from({ length: rank * (rank + 1) }, (_, index) =>
            index % rank === Math.floor(index / rank) ? 1 : 0,
          ),
        ),
      },
    ],
  });
}

describe("getSpatialSkeletonLevelSpecs", () => {
  it("draws levels that share one cell size in the order the metadata gives", () => {
    const specs = getSpatialSkeletonLevelSpecs({
      modelSpace: makeNanometerSpace([0, 0, 0], [120, 120, 120]),
      levels: [
        { chunkSize: [40, 40, 40], limit: 10 },
        { chunkSize: [40, 40, 40], limit: 100 },
        { chunkSize: [40, 40, 40], limit: 0 },
      ],
    });

    expect(specs.map((spec) => spec.limit)).toEqual([10, 100, 0]);
  });

  it("numbers cells from the origin, not from the lower bound", () => {
    const [spec] = getSpatialSkeletonLevelSpecs({
      modelSpace: makeNanometerSpace([100, 100, 100], [220, 220, 220]),
      levels: [{ chunkSize: [30, 30, 30], limit: 0 }],
    });

    expect(Array.from(spec.lowerChunkBound)).toEqual([3, 3, 3]);
    expect(Array.from(spec.upperChunkBound)).toEqual([8, 8, 8]);
  });

  it("places cells in the units of the coordinate space", () => {
    const [spec] = getSpatialSkeletonLevelSpecs({
      modelSpace: makeNanometerSpace([0, 0, 0], [120, 120, 120]),
      levels: [{ chunkSize: [30, 30, 30], limit: 0 }],
    });

    const { transform } = spec.chunkLayout;
    expect([transform[0], transform[5], transform[10]]).toEqual([
      Math.fround(1e-9),
      Math.fround(1e-9),
      Math.fround(1e-9),
    ]);
  });

  it("rejects limit 0 on any level but the finest", () => {
    expect(() =>
      getSpatialSkeletonLevelSpecs({
        modelSpace: makeNanometerSpace([0, 0, 0], [120, 120, 120]),
        levels: [
          { chunkSize: [40, 40, 40], limit: 0 },
          { chunkSize: [20, 20, 20], limit: 100 },
        ],
      }),
    ).toThrow(
      "Spatial skeleton limit: 0 is only supported on the finest source level.",
    );
  });

  it("rejects a coordinate space that is not 3-D", () => {
    expect(() =>
      getSpatialSkeletonLevelSpecs({
        modelSpace: makeNanometerSpace([0, 0, 0, 0], [120, 120, 120, 1], 4),
        levels: [{ chunkSize: [30, 30, 30, 1], limit: 0 }],
      }),
    ).toThrow("Spatial skeleton coordinate space must have rank 3, not 4.");
  });

  it("rejects a coordinate space with infinite bounds", () => {
    expect(() =>
      getSpatialSkeletonLevelSpecs({
        modelSpace: makeNanometerSpace(
          [0, 0, 0],
          [120, 120, Number.POSITIVE_INFINITY],
        ),
        levels: [{ chunkSize: [30, 30, 30], limit: 0 }],
      }),
    ).toThrow("Spatial skeleton coordinate space bounds must be finite.");
  });
});
