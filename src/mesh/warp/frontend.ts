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
 * @file Warped meshes, frontend side: a multiscale mesh subsource of a warped
 * data source becomes a single-resolution mesh source in the field's space
 * (one level of detail), computed in the worker by `warp/backend.ts`.
 */

import type { ChunkManager, ChunkSource } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import { MeshSource, MultiscaleMeshSource } from "#src/mesh/frontend.js";
import { WarpedMeshSourceParameters } from "#src/mesh/warp/base.js";
import type { FieldLevelAccess } from "#src/sliceview/volume/warp/field_sampler.js";
import type {
  DisplacementField,
  WarpGeometry,
} from "#src/sliceview/volume/warp/frontend.js";
import {
  canonicalSourceOptions,
  getWarpGeometry,
  movingModelToOutput,
  mul4,
  rowMajorFromColumnMajor,
  zarrArrayAccess,
} from "#src/sliceview/volume/warp/frontend.js";

// The finest field level used for meshes is the coarsest one whose measured
// interpolation error is at most this.
const MESH_FIELD_TOLERANCE_METERS = 10e-6;
const COARSE_ITERATIONS = 8;
const FINE_ITERATIONS = 8;
// Newton iterations stop when the largest vertex step is below this.
const TOLERANCE_METERS = 0.05e-6;

class WarpedMeshSource extends WithParameters(
  MeshSource,
  WarpedMeshSourceParameters,
) {
  dependencies: ChunkSource[] | undefined;
}

/**
 * A warped version of a multiscale mesh source, or undefined if the mesh
 * cannot be warped.
 */
export function makeWarpedMeshSource(
  chunkManager: ChunkManager,
  mesh: unknown,
  subsourceToModel: Float32Array | undefined,
  movingTransform: CoordinateSpaceTransform,
  field: DisplacementField,
  geometry: WarpGeometry,
  lod = 0,
): MeshSource | undefined {
  if (!(mesh instanceof MultiscaleMeshSource)) return undefined;
  const identity = Float32Array.from([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  const storedToOutput = mul4(
    movingModelToOutput(movingTransform, geometry),
    rowMajorFromColumnMajor(subsourceToModel ?? identity, 3),
  );
  // With the field of the inverse transformation, vertices move directly;
  // otherwise p + u(p) = v is solved on this field.
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
        MESH_FIELD_TOLERANCE_METERS
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
    const volume = f.fields[level];
    const source = volume.getSources(canonicalSourceOptions(4))[0][0]
      .chunkSource;
    dependencies.push(source);
    return {
      array: zarrArrayAccess(volume, source),
      vectorAxis: f.metadata.vectorAxis,
      outputToIndex: g.levels[level].outputToIndex,
      vectorToOutput: g.vectorToOutput,
    };
  };
  const coarse = access(field, geometry, geometry.levels.length - 1);
  const fine = access(fineField, fineGeometry, pickFine(fineGeometry.levels));
  mesh.addRef();
  dependencies.push(mesh);
  const source = chunkManager.getChunkSource(WarpedMeshSource, {
    parameters: {
      meshSource: mesh.rpcId!,
      format: mesh.format,
      storedToOutput,
      lod,
      coarse,
      fine,
      coarseIterations: COARSE_ITERATIONS,
      fineIterations: FINE_ITERATIONS,
      tolerance: TOLERANCE_METERS / Math.max(...geometry.scales),
      direct: inverse !== undefined,
    },
  });
  if (source.dependencies === undefined) {
    source.dependencies = dependencies;
    for (const d of dependencies) source.registerDisposer(d);
  } else {
    for (const d of dependencies) d.dispose();
  }
  return source;
}
