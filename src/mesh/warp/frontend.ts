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
 * @file Warped meshes, frontend side: a mesh subsource of a warped data
 * source becomes a single-resolution mesh source in the field's space (for a
 * multiscale source, one level of detail), computed in the worker by
 * `warp/backend.ts`.
 */

import type { ChunkManager, ChunkSource } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import { MeshSource, MultiscaleMeshSource } from "#src/mesh/frontend.js";
import {
  WarpedMeshSourceParameters,
  WarpedSingleResolutionMeshSourceParameters,
} from "#src/mesh/warp/base.js";
import type {
  DisplacementField,
  WarpGeometry,
} from "#src/sliceview/volume/warp/field.js";
import {
  attachDependencies,
  makePointWarpSetup,
} from "#src/sliceview/volume/warp/point_warp_frontend.js";

class WarpedMeshSource extends WithParameters(
  MeshSource,
  WarpedMeshSourceParameters,
) {
  dependencies: ChunkSource[] | undefined;
}

class WarpedSingleResolutionMeshSource extends WithParameters(
  MeshSource,
  WarpedSingleResolutionMeshSourceParameters,
) {
  dependencies: ChunkSource[] | undefined;
}

/**
 * A warped version of a mesh source (multiscale or single-resolution), or
 * undefined if the mesh cannot be warped.
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
  if (!(mesh instanceof MultiscaleMeshSource || mesh instanceof MeshSource)) {
    return undefined;
  }
  const { storedToOutput, warp, dependencies } = makePointWarpSetup(
    mesh,
    subsourceToModel,
    movingTransform,
    field,
    geometry,
  );
  const source =
    mesh instanceof MultiscaleMeshSource
      ? chunkManager.getChunkSource(WarpedMeshSource, {
          parameters: {
            meshSource: mesh.rpcId!,
            format: mesh.format,
            storedToOutput,
            lod,
            warp,
          },
        })
      : chunkManager.getChunkSource(WarpedSingleResolutionMeshSource, {
          parameters: { meshSource: mesh.rpcId!, storedToOutput, warp },
        });
  attachDependencies(source, dependencies);
  return source;
}
