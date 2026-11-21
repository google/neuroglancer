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
 * shown in the space of a displacement field. A vertex v (moving space) is
 * placed at the point p of the field's space with p + u(p) = v, the inverse
 * of the volume warp W(x) = M(x + u(x)), so meshes stay on the warped labels:
 * directly with the field of the inverse transformation when one is given,
 * otherwise by Newton's method on the field itself.
 */

import type { MultiscaleFragmentFormat } from "#src/mesh/base.js";
import type { FieldLevelAccess } from "#src/sliceview/volume/warp/field_sampler.js";

export class WarpedMeshSourceParameters {
  // rpcId of the moving multiscale mesh source.
  meshSource: number;
  format: MultiscaleFragmentFormat;
  // Stored mesh coordinates -> output coordinates (row-major 4x4).
  storedToOutput: number[];
  // Level of detail shown (0 = finest).
  lod: number;
  // Newton iterations for p + u(p) = v: first on a coarse field level, to get
  // every vertex close, then on a fine one; at most this many per level,
  // until the largest step (output coordinates) is below the tolerance.
  coarse: FieldLevelAccess;
  fine: FieldLevelAccess;
  coarseIterations: number;
  fineIterations: number;
  tolerance: number;
  // If set, `fine` is the field of the inverse transformation, sampled at
  // the vertex: p = v + u_inverse(v), with no iteration.
  direct: boolean;
  static RPC_ID = "warp/WarpedMeshSource";
}
