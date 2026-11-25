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
 * @file Shared definitions for warped annotations: the annotations of a moving
 * (multiscale) annotation source, shown in the space of a displacement field.
 * Their points move through the field as described in
 * `sliceview/volume/warp/point_warp.ts`:
 *  - points, line and polyline vertices, and ellipsoid centres move exactly;
 *  - an axis-aligned bounding box becomes the box around its 8 moved corners;
 *  - ellipsoid radii follow the linear placement only.
 *
 * The spatial index keeps the moving source's grid, placed by the linear part
 * of the transformation: a warped cell holds the annotations, from the moving
 * cells of the same level it overlaps, whose moved geometry intersects it.
 */

import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import type { PointWarpParameters } from "#src/sliceview/volume/warp/point_warp.js";

export class WarpedAnnotationSourceParameters {
  // rpcId of the moving multiscale annotation source.
  annotationSource: number;
  rank: number;
  properties: Readonly<AnnotationPropertySpec>[];
  // Stored annotation coordinates -> output coordinates (row-major 4x4).
  storedToOutput: number[];
  warp: PointWarpParameters;
  static RPC_ID = "warp/WarpedAnnotationSource";
}

export class WarpedAnnotationSpatialIndexParameters {
  // rpcId of the moving source's chunk source of the same level.
  chunkSource: number;
  // Its grid: chunk coordinates -> stored coordinates (column-major
  // (rank + 1)^2, as `chunkToMultiscaleTransform`).
  movingChunkToMultiscale: number[];
  static RPC_ID = "warp/WarpedAnnotationSpatialIndexSource";
}
