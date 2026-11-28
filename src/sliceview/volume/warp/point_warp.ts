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
 * @file Moving points through a displacement field (shared definitions):
 * mesh vertices, skeleton vertices and annotations of a moving source, shown
 * in the space of the field. A point v (moving space) is placed at the point
 * p of the field's space with p + u(p) = v, the inverse of the volume warp
 * W(x) = M(x + u(x)), so that points stay on the warped image: directly with
 * the field of the inverse transformation (stored, or for an OME-Zarr field
 * derived from it: `derived_field.ts`), otherwise (other formats, e.g. NIfTI) by
 * Newton's method on the field itself.
 */

import type { FieldLevelAccess } from "#src/sliceview/volume/warp/field_sampler.js";

// Moves points through a field once, outside of any chunk (for example to
// find where a source's bounding box lands).
export const INVERSE_WARP_POINTS_RPC_ID = "warp/inverseWarpPoints";

export interface PointWarpParameters {
  // Newton iterations for p + u(p) = v: first on a coarse field level, to get
  // every point close, then on a fine one; at most this many per level,
  // until the largest step (output coordinates) is below the tolerance.
  coarse: FieldLevelAccess;
  fine: FieldLevelAccess;
  coarseIterations: number;
  fineIterations: number;
  tolerance: number;
  // If set, `fine` is the field of the inverse transformation, sampled at
  // the point: p = v + u_inverse(v), with no iteration.
  direct: boolean;
  // The field itself at the level used to find where data is pulled from
  // (x + u(x)), and that level's interpolation error (output coordinates).
  bounds: FieldLevelAccess;
  boundsError: number;
}
