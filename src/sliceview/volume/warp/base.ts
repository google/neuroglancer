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
 * All matrices are row-major 4x4 (homogeneous) or 3x3, as plain number arrays.
 *
 * Coordinate frames:
 *  - "warped": continuous voxel coordinates of the warped chunk grid
 *    (Neuroglancer convention: the sample of voxel m is at m + 0.5);
 *  - "output": the layer output space shared by the fixed image, the field and
 *    the moving image (for example "mm RAS");
 *  - "field index": array index of the displacement field, spatial axes only,
 *    in zarr (C) order, sample n at index n;
 *  - "moving": continuous voxel coordinates of a moving chunk source
 *    (sample n at n + 0.5).
 */

export enum WarpInterpolation {
  NEAREST = 0,
  LINEAR = 1,
}

/** How to read one zarr array through a Neuroglancer volume chunk source. */
export interface ZarrArrayAccess {
  // rpcId of the backend volume chunk source.
  source: number;
  // zarr shape and chunk shape, C order.
  shape: number[];
  chunkShape: number[];
}

export interface DisplacementFieldAccess {
  // The field level used for this warped scale.
  array: ZarrArrayAccess;
  // Array axis that holds the vector components.
  vectorAxis: number;
  // output coordinates -> field index (row-major 4x4).
  outputToIndex: number[];
  // vector components -> displacement in output coordinates (row-major 3x3).
  vectorToOutput: number[];
  bounds?: {
    array: ZarrArrayAccess;
    // Finest-level field samples per block along each spatial axis.
    blockShape: number[];
    // output coordinates -> finest-level field index (row-major 4x4).
    outputToIndex: number[];
    // Bounds are stored in output units of the field metadata; multiply by
    // these to get output coordinates, per output axis.
    unitToOutput: number[];
  };
}

export class WarpedVolumeChunkSourceParameters {
  // rpcId of the moving volume chunk source.
  movingSource: number;
  // output coordinates -> moving voxel coordinates (row-major 4x4).
  // Moving chunk dimensions that are spatial (in the order of the rows of
  // outputToMoving) and channel dimensions, carried whole into every warped
  // chunk (which has the 3 spatial dimensions, then the channels).
  movingSpatialDims: number[];
  movingChannelDims: number[];
  outputToMoving: number[];
  // warped voxel coordinates -> output coordinates (row-major 4x4).
  warpedToOutput: number[];
  field: DisplacementFieldAccess;
  interpolation: WarpInterpolation;
  static RPC_ID = "warp/WarpedVolumeChunkSource";
}
