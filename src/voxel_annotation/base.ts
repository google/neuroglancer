/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { vec3 } from "#src/util/geom.js";
import type { VoxelPreviewMultiscaleSource } from "#src/voxel_annotation/PreviewMultiscaleChunkSource.js";
import type { RPC } from "#src/worker_rpc.js";

export const VOX_RELOAD_CHUNKS_RPC_ID = "vox.chunk.reload";
export const VOX_EDIT_BACKEND_RPC_ID = "vox.EditBackend";
export const VOX_EDIT_COMMIT_VOXELS_RPC_ID = "vox.edit.commitVoxels";
export const VOX_EDIT_FAILURE_RPC_ID = "vox.edit.failure";
export const VOX_EDIT_UNDO_RPC_ID = "vox.edit.undo";
export const VOX_EDIT_REDO_RPC_ID = "vox.edit.redo";
export const VOX_EDIT_HISTORY_UPDATE_RPC_ID = "vox.edit.historyUpdate";

export const BRUSH_TOOL_ID = "vox-brush";
export const FLOODFILL_TOOL_ID = "vox-flood-fill";
export const SEG_PICKER_TOOL_ID = "vox-seg-picker";

// Special value used to indicate to the optimistic renderer that a voxel has been erased
export const SEG_ERASE_SENTINEL = ~1n;

export type VoxelValueGetter = (isPreview: boolean) => bigint;

export interface VoxelLayerResolution {
  lodIndex: number;
  transform: number[];
  chunkSize: number[];
  sourceRpc: number;
}

export type VoxelChangeValues = Uint32Array | BigUint64Array;

export interface VoxelChange {
  indices: Uint32Array;
  oldValues: VoxelChangeValues;
  newValues: VoxelChangeValues;
}

export interface EditAction {
  changes: Map<string, VoxelChange>;
  timestamp: number;
  description: string;
}

export function makeVoxChunkKey(chunkKey: string, lodIndex: number) {
  return `lod${lodIndex}#${chunkKey}`;
}

export function makeChunkKey(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

export function parseVoxChunkKey(key: string) {
  const parts = [
    Number(key.split("#")[0].substring(3)),
    ...key.split("#")[1].split(",").map(Number),
  ];
  if (parts.length !== 4 || parts.some(isNaN)) {
    console.warn(`Invalid chunk key format: ${key}`);
    return null;
  }
  return {
    lodIndex: parts[0],
    x: parts[1],
    y: parts[2],
    z: parts[3],
    chunkKey: key.split("#")[1],
  };
}

export function getBasisFromNormal(n: vec3) {
  const u = vec3.create();
  const tempVec =
    Math.abs(vec3.dot(n, vec3.fromValues(1, 0, 0))) < 0.9
      ? vec3.fromValues(1, 0, 0)
      : vec3.fromValues(0, 1, 0);
  vec3.cross(u, tempVec, n);
  vec3.normalize(u, u);
  const v = vec3.cross(vec3.create(), n, u);
  vec3.normalize(v, v);
  return { u, v };
}

export enum BrushShape {
  DISK = 0,
  SPHERE = 1,
}

export interface VoxelEditControllerHost {
  primarySource: MultiscaleVolumeChunkSource;
  previewSource?: VoxelPreviewMultiscaleSource;
  rpc: RPC;
}
