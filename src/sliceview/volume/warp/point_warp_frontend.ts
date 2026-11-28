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
 * @file Moving points through a displacement field, frontend side (see
 * `point_warp.ts`): which field levels are sampled.
 */

import type { ChunkManager, ChunkSource } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import {
  mul4,
  rowMajorFromColumnMajor,
} from "#src/sliceview/volume/warp/affine.js";
import type {
  DisplacementField,
  WarpGeometry,
} from "#src/sliceview/volume/warp/field.js";
import {
  canonicalSourceOptions,
  fieldLevelAccess,
  getWarpGeometry,
  movingModelToOutput,
} from "#src/sliceview/volume/warp/field.js";
import type { FieldLevelAccess } from "#src/sliceview/volume/warp/field_sampler.js";
import type { PointWarpParameters } from "#src/sliceview/volume/warp/point_warp.js";
import { INVERSE_WARP_POINTS_RPC_ID } from "#src/sliceview/volume/warp/point_warp.js";

// The finest field level used for points is the coarsest one whose measured
// interpolation error is at most this.
const POINT_FIELD_TOLERANCE_METERS = 10e-6;
const COARSE_ITERATIONS = 8;
const FINE_ITERATIONS = 8;
// Newton iterations stop when the largest step is below this.
const TOLERANCE_METERS = 0.05e-6;

/**
 * The field levels that move points of a source placed by `movingTransform`,
 * and the field chunk sources they read (to keep alive with the source that
 * uses them; each holds a reference).
 */
export function makePointWarp(
  movingTransform: CoordinateSpaceTransform,
  field: DisplacementField,
  geometry: WarpGeometry,
): { parameters: PointWarpParameters; dependencies: ChunkSource[] } {
  // With the field of the inverse transformation (stored, or derived for
  // OME-Zarr fields), points move directly; otherwise (other formats)
  // p + u(p) = v is solved on this field.
  const inverse = field.inverse;
  const fineField = inverse ?? field;
  const fineGeometry =
    inverse === undefined
      ? geometry
      : getWarpGeometry(movingTransform, inverse);
  const pickFine = (levels: WarpGeometry["levels"]) => {
    let level = 0;
    while (
      level + 1 < levels.length &&
      (levels[level + 1].maxErrorMeters ?? Infinity) <=
        POINT_FIELD_TOLERANCE_METERS
    ) {
      ++level;
    }
    return level;
  };
  const dependencies: ChunkSource[] = [];
  const access = (
    f: DisplacementField,
    g: WarpGeometry,
    level: number,
  ): FieldLevelAccess => {
    const volume = f.levels[level].volume;
    const entry = volume.getSources(canonicalSourceOptions(f.modelRank))[0][0];
    dependencies.push(entry.chunkSource);
    return fieldLevelAccess(g, level, entry);
  };
  const coarse = access(field, geometry, geometry.levels.length - 1);
  const fine = access(fineField, fineGeometry, pickFine(fineGeometry.levels));
  const boundsLevel = pickFine(geometry.levels);
  const bounds = access(field, geometry, boundsLevel);
  const { maxErrorMeters, spacingMeters } = geometry.levels[boundsLevel];
  return {
    parameters: {
      coarse,
      fine,
      coarseIterations: COARSE_ITERATIONS,
      fineIterations: FINE_ITERATIONS,
      tolerance: TOLERANCE_METERS / Math.max(...geometry.scales),
      direct: inverse !== undefined,
      bounds,
      boundsError:
        (maxErrorMeters ?? spacingMeters) / Math.min(...geometry.scales),
    },
    dependencies,
  };
}

/**
 * What a warped source of points (mesh vertices, skeleton vertices,
 * annotations) needs: the moving source's stored coordinates -> output
 * coordinates (row-major 4x4), how its points move, and the chunk sources to
 * keep alive with the warped source (`moving` included, referenced here).
 */
export function makePointWarpSetup(
  moving: ChunkSource,
  subsourceToModel: Float32Array | undefined,
  movingTransform: CoordinateSpaceTransform,
  field: DisplacementField,
  geometry: WarpGeometry,
) {
  const storedToOutput = mul4(
    movingModelToOutput(movingTransform, geometry),
    subsourceToModel === undefined
      ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      : rowMajorFromColumnMajor(subsourceToModel, 3),
  );
  const { parameters: warp, dependencies } = makePointWarp(
    movingTransform,
    field,
    geometry,
  );
  moving.addRef();
  dependencies.push(moving);
  return { storedToOutput, warp, dependencies };
}

/**
 * Keeps `dependencies` alive with `source`, once: a chunk source returned
 * again by the chunk manager already holds them, so the new references are
 * released.
 */
export function attachDependencies(
  source: ChunkSource & { dependencies?: ChunkSource[] },
  dependencies: ChunkSource[],
) {
  if (source.dependencies === undefined) {
    source.dependencies = dependencies;
    for (const d of dependencies) source.registerDisposer(d);
  } else {
    for (const d of dependencies) d.dispose();
  }
}

/** Moves points (output coordinates, x y z interleaved) through the field. */
export function inverseWarpPoints(
  chunkManager: ChunkManager,
  warp: PointWarpParameters,
  points: number[],
  signal?: AbortSignal,
): Promise<number[]> {
  return chunkManager.rpc!.promiseInvoke<number[]>(
    INVERSE_WARP_POINTS_RPC_ID,
    { chunkManager: chunkManager.rpcId, warp, points },
    { signal },
  );
}
