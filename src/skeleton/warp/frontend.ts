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
 * @file Warped skeletons, frontend side: a skeleton subsource of a warped data
 * source becomes a skeleton source in the field's space, computed in the
 * worker by `warp/backend.ts`.
 */

import type { ChunkManager, ChunkSource } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import { SkeletonSource } from "#src/skeleton/frontend.js";
import { WarpedSkeletonSourceParameters } from "#src/skeleton/warp/base.js";
import type {
  DisplacementField,
  WarpGeometry,
} from "#src/sliceview/volume/warp/field.js";
import {
  attachDependencies,
  makePointWarpSetup,
} from "#src/sliceview/volume/warp/point_warp_frontend.js";

class WarpedSkeletonSource extends WithParameters(
  SkeletonSource,
  WarpedSkeletonSourceParameters,
) {
  declare OPTIONS: {
    parameters: WarpedSkeletonSourceParameters;
    moving: SkeletonSource;
  };
  dependencies: ChunkSource[] | undefined;
  moving: SkeletonSource;

  constructor(chunkManager: ChunkManager, options: any) {
    super(chunkManager, options);
    this.moving = options.moving;
  }

  // The moving source's vertex attributes, unchanged (positions are moved).
  get vertexAttributes(): Map<string, VertexAttributeInfo> {
    return this.moving.vertexAttributes;
  }
}

/** A warped version of a skeleton source. */
export function makeWarpedSkeletonSource(
  chunkManager: ChunkManager,
  skeletons: SkeletonSource,
  subsourceToModel: Float32Array | undefined,
  movingTransform: CoordinateSpaceTransform,
  field: DisplacementField,
  geometry: WarpGeometry,
): SkeletonSource {
  const { storedToOutput, warp, dependencies } = makePointWarpSetup(
    skeletons,
    subsourceToModel,
    movingTransform,
    field,
    geometry,
  );
  const source = chunkManager.getChunkSource(WarpedSkeletonSource, {
    parameters: { skeletonSource: skeletons.rpcId!, storedToOutput, warp },
    moving: skeletons,
  });
  attachDependencies(source, dependencies);
  return source;
}
