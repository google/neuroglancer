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
 * @file Shared definitions for warped volumes: a moving volume resampled
 * through a displacement field, chunk by chunk, without copying the data.
 *
 * All matrices are row-major, as plain number arrays. The warp is computed
 * over F field dimensions (3 in the common case: 4x4 homogeneous matrices).
 *
 * Coordinate frames:
 *  - "warped": continuous voxel coordinates of the warped chunk grid
 *    (Neuroglancer convention: the sample of voxel m is at m + 0.5);
 *  - "output": the layer output space shared by the fixed image, the field and
 *    the moving image (for example "mm RAS");
 *  - "field index": voxel index of the displacement field's chunk source
 *    (any layout: zarr, NIfTI, ...), per chunk dimension, sample n at n;
 *  - "moving": continuous voxel coordinates of a moving chunk source
 *    (sample n at n + 0.5).
 */

export enum WarpInterpolation {
  NEAREST = 0,
  LINEAR = 1,
}

/**
 * How to read one level of a displacement field through a Neuroglancer volume
 * chunk source of any layout (zarr, NIfTI, ...). Indices are chunk-source
 * voxel indices, with sample n at index n; chunk data is in Fortran order
 * (chunk dimension 0 fastest).
 */
export interface FieldAccess {
  // rpcId of the backend volume chunk source.
  source: number;
  rank: number;
  chunkDataSize: number[];
  baseVoxelOffset: number[];
  lowerVoxelBound: number[];
  upperVoxelBound: number[];
  // Chunk dimension that holds the vector components.
  vectorDim: number;
  numComponents: number;
  // Warped output coordinates (the F field dimensions) -> field index, per
  // chunk dimension: row-major rank x (F + 1). Dimensions the field is
  // constant along have a zero row and a constant index; the vector
  // dimension's row is unused.
  outputToIndex: number[];
  // Components -> displacement in warped output coordinates (row-major
  // F x numComponents).
  vectorToOutput: number[];
}

/** A moving chunk dimension that the warp passes through unchanged. */
export interface WarpPassthroughDimension {
  // Moving chunk dimension.
  dim: number;
  // Carried whole in every warped chunk (channels); otherwise the warped
  // chunk has size 1 along it.
  whole: boolean;
  // Moving voxel = warped voxel + offset.
  offset: number;
}

export class WarpedVolumeChunkSourceParameters {
  // rpcId of the moving volume chunk source.
  movingSource: number;
  // Warped chunk dimensions 0 .. numFieldDims - 1 are the field dimensions;
  // the rest are movingPassDims, in order.
  numFieldDims: number;
  // Moving chunk dimensions sampled through the field (rows of
  // outputToMoving), in ascending order.
  movingSpatialDims: number[];
  movingPassDims: WarpPassthroughDimension[];
  // output coordinates (F dims) -> moving voxel coordinates of
  // movingSpatialDims: row-major movingSpatialDims.length x (F + 1).
  outputToMoving: number[];
  // warped voxel coordinates -> output coordinates: row-major (F + 1)^2.
  warpedToOutput: number[];
  field: FieldAccess;
  interpolation: WarpInterpolation;
  static RPC_ID = "warp/WarpedVolumeChunkSource";
}
