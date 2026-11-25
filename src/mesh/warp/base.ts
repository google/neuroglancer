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
 * @file Shared definitions for warped meshes: the meshes of a moving source,
 * shown in the space of a displacement field. Vertices move through the field
 * as described in `sliceview/volume/warp/point_warp.ts`.
 */

import type { MultiscaleFragmentFormat } from "#src/mesh/base.js";
import type { PointWarpParameters } from "#src/sliceview/volume/warp/point_warp.js";

export class WarpedMeshSourceParameters {
  // rpcId of the moving multiscale mesh source.
  meshSource: number;
  format: MultiscaleFragmentFormat;
  // Stored mesh coordinates -> output coordinates (row-major 4x4).
  storedToOutput: number[];
  // Level of detail shown (0 = finest).
  lod: number;
  warp: PointWarpParameters;
  static RPC_ID = "warp/WarpedMeshSource";
}
