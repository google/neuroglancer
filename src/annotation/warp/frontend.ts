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

/**
 * @file Warped annotations, frontend side (see `warp/base.ts`): a multiscale
 * annotation subsource of a warped data source becomes a read-only annotation
 * source in the field's space, computed in the worker by `warp/backend.ts`.
 */

import type { AnnotationGeometryChunkSpecification } from "#src/annotation/base.js";
import {
  AnnotationGeometryChunkSource,
  MultiscaleAnnotationSource,
} from "#src/annotation/frontend_source.js";
import {
  WarpedAnnotationSourceParameters,
  WarpedAnnotationSpatialIndexParameters,
} from "#src/annotation/warp/base.js";
import type { ChunkManager, ChunkSource } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import {
  applyAffine3,
  columnMajor4,
  inverse4,
  mul4,
  rowMajorFromColumnMajor,
  scale4,
  transformBox,
} from "#src/sliceview/volume/warp/affine.js";
import type {
  DisplacementField,
  WarpGeometry,
} from "#src/sliceview/volume/warp/field.js";
import { canonicalSourceOptions } from "#src/sliceview/volume/warp/field.js";
import type { PointWarpParameters } from "#src/sliceview/volume/warp/point_warp.js";
import {
  attachDependencies,
  inverseWarpPoints,
  makePointWarpSetup,
} from "#src/sliceview/volume/warp/point_warp_frontend.js";

class WarpedAnnotationSpatialIndexSource extends WithParameters(
  AnnotationGeometryChunkSource,
  WarpedAnnotationSpatialIndexParameters,
) {
  dependencies: ChunkSource[] | undefined;
}

class WarpedAnnotationSource extends WithParameters(
  MultiscaleAnnotationSource,
  WarpedAnnotationSourceParameters,
) {
  declare OPTIONS: {
    parameters: WarpedAnnotationSourceParameters;
    moving: MultiscaleAnnotationSource;
    extent: { lower: number[]; upper: number[] };
  };
  dependencies: ChunkSource[] | undefined;
  moving: MultiscaleAnnotationSource;
  // Where moved annotations can be (output coordinates).
  extent: { lower: number[]; upper: number[] };

  constructor(chunkManager: ChunkManager, options: any) {
    const { parameters, moving } = options;
    super(chunkManager, {
      rank: parameters.rank,
      relationships: moving.relationships,
      properties: parameters.properties,
      parameters,
    } as any);
    this.moving = moving;
    this.extent = options.extent;
    this.readonly = true;
  }

  /**
   * The cells of a grid that hold moved annotations: those of the moving
   * source, and those covering where its annotations land (they move by up to
   * the field's displacement, beyond the source's own bounds).
   */
  private cellBounds(
    spec: AnnotationGeometryChunkSpecification,
    warpedToMultiscale: Float32Array,
  ) {
    const { chunkDataSize } = spec;
    const lowerChunkBound = Float32Array.from(spec.lowerChunkBound);
    const upperChunkBound = Float32Array.from(spec.upperChunkBound);
    const { lower, upper } = this.extent;
    if ([...lower, ...upper].every(Number.isFinite)) {
      const outputToCell = inverse4(
        mul4(
          rowMajorFromColumnMajor(warpedToMultiscale, 3),
          scale4(chunkDataSize),
        ),
      );
      const [cLo, cHi] = transformBox(outputToCell, 3, 3, lower, upper);
      for (let i = 0; i < 3; ++i) {
        lowerChunkBound[i] = Math.min(lowerChunkBound[i], Math.floor(cLo[i]));
        upperChunkBound[i] = Math.max(
          upperChunkBound[i],
          Math.floor(cHi[i]) + 1,
        );
      }
    }
    const lowerVoxelBound = lowerChunkBound.map((c, i) => c * chunkDataSize[i]);
    const upperVoxelBound = upperChunkBound.map((c, i) => c * chunkDataSize[i]);
    return {
      lowerChunkBound,
      upperChunkBound,
      lowerVoxelBound,
      upperVoxelBound,
      lowerClipBound: lowerVoxelBound,
      upperClipBound: upperVoxelBound,
    };
  }

  getSources(
    options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    const { storedToOutput } = this.parameters;
    return this.moving.getSources(options).map((scales) =>
      scales.map(({ chunkSource, chunkToMultiscaleTransform }) => {
        const { spec } = chunkSource;
        // The moving grid, placed in the output space.
        const warpedToMultiscale = columnMajor4(
          mul4(
            storedToOutput,
            rowMajorFromColumnMajor(chunkToMultiscaleTransform, 3),
          ),
        );
        const warpedSpec = {
          ...spec,
          chunkToMultiscaleTransform: warpedToMultiscale,
          ...this.cellBounds(spec, warpedToMultiscale),
        };
        const source = this.chunkManager.getChunkSource(
          WarpedAnnotationSpatialIndexSource,
          {
            parent: this,
            spec: warpedSpec,
            parameters: {
              chunkSource: chunkSource.rpcId!,
              movingChunkToMultiscale: Array.from(chunkToMultiscaleTransform),
            },
          },
        );
        attachDependencies(source, [chunkSource]);
        return {
          chunkSource: source,
          chunkToMultiscaleTransform: warpedToMultiscale,
        };
      }),
    );
  }
}

// Samples per axis of the source's bounding box, to find where it lands.
const EXTENT_SAMPLES = 9;

/**
 * Where the annotations of a source land (output coordinates): its bounding
 * box (stored coordinates, the union of its spatial index grids) sampled and
 * moved through the field, widened by half a sample spacing.
 */
async function warpedExtent(
  chunkManager: ChunkManager,
  annotations: MultiscaleAnnotationSource,
  storedToOutput: number[],
  warp: PointWarpParameters,
) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const scales = annotations.getSources(canonicalSourceOptions(3));
  for (const { chunkSource, chunkToMultiscaleTransform } of scales.flat()) {
    const { spec } = chunkSource;
    const [bLo, bHi] = transformBox(
      rowMajorFromColumnMajor(chunkToMultiscaleTransform, 3),
      3,
      3,
      spec.lowerVoxelBound,
      spec.upperVoxelBound,
    );
    for (let i = 0; i < 3; ++i) {
      lo[i] = Math.min(lo[i], bLo[i]);
      hi[i] = Math.max(hi[i], bHi[i]);
    }
    chunkSource.dispose();
  }
  if (![...lo, ...hi].every(Number.isFinite)) return undefined;
  const n = EXTENT_SAMPLES;
  const points: number[] = [];
  for (let a = 0; a < n; ++a) {
    for (let b = 0; b < n; ++b) {
      for (let c = 0; c < n; ++c) {
        const t = [a, b, c].map((k) => k / (n - 1));
        for (let i = 0; i < 3; ++i) points.push(lo[i] + t[i] * (hi[i] - lo[i]));
      }
    }
  }
  const moved = await inverseWarpPoints(
    chunkManager,
    warp,
    Array.from(applyAffine3(storedToOutput, points)),
  );
  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < moved.length; k += 3) {
    for (let i = 0; i < 3; ++i) {
      lower[i] = Math.min(lower[i], moved[k + i]);
      upper[i] = Math.max(upper[i], moved[k + i]);
    }
  }
  for (let i = 0; i < 3; ++i) {
    const pad = (upper[i] - lower[i]) / (n - 1) / 2;
    lower[i] -= pad;
    upper[i] += pad;
  }
  return { lower, upper };
}

/**
 * A warped version of an annotation source, or undefined if it cannot be
 * warped (it is not a 3-d multiscale source, e.g. local annotations).
 */
export async function makeWarpedAnnotationSource(
  chunkManager: ChunkManager,
  annotations: unknown,
  subsourceToModel: Float32Array | undefined,
  movingTransform: CoordinateSpaceTransform,
  field: DisplacementField,
  geometry: WarpGeometry,
): Promise<MultiscaleAnnotationSource | undefined> {
  if (
    !(annotations instanceof MultiscaleAnnotationSource) ||
    annotations.rank !== 3
  ) {
    return undefined;
  }
  const { storedToOutput, warp, dependencies } = makePointWarpSetup(
    annotations as unknown as ChunkSource,
    subsourceToModel,
    movingTransform,
    field,
    geometry,
  );
  let extent: { lower: number[]; upper: number[] } | undefined;
  try {
    extent = await warpedExtent(
      chunkManager,
      annotations,
      storedToOutput,
      warp,
    );
  } catch (e) {
    for (const d of dependencies) d.dispose();
    throw e;
  }
  const source = chunkManager.getChunkSource(WarpedAnnotationSource, {
    parameters: {
      annotationSource: annotations.rpcId!,
      rank: 3,
      properties: annotations.properties.value.slice(),
      storedToOutput,
      warp,
    },
    moving: annotations,
    extent: extent ?? {
      lower: [Infinity, Infinity, Infinity],
      upper: [-Infinity, -Infinity, -Infinity],
    },
  });
  attachDependencies(source as unknown as ChunkSource, dependencies);
  return source;
}
