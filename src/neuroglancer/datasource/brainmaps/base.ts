/**
 * @license
 * Copyright 2016 Google Inc.
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

import {BrainmapsInstance} from 'neuroglancer/datasource/brainmaps/api';
import {vec3} from 'neuroglancer/util/geom';

export enum VolumeChunkEncoding {
  RAW,
  JPEG,
  COMPRESSED_SEGMENTATION
}

export class ChangeSpec {
  changeStackId: string;
  /**
   * Apply changes prior to this timestamp (in milliseconds since epoch).  If 0, no changes should
   * be applied.  If negative, all changes should be applied.
   */
  timeStamp?: number;
  skipEquivalences?: boolean;
}

export class VolumeSourceParameters {
  instance: BrainmapsInstance;
  volumeId: string;
  scaleIndex: number;
  encoding: VolumeChunkEncoding;
  changeSpec: ChangeSpec|undefined;

  static RPC_ID = 'brainmaps/VolumeChunkSource';
}

export interface SingleMeshInfo {
  name: string;
  type: string;
}

export interface MultiscaleMeshLOD {
  info: SingleMeshInfo;
  scale: number;
  lod: number;
}

export interface MultiscaleMeshInfo {
  /**
   * Prefix
   */
  key: string;

  /**
   * Chunk shape in spatial units (nm).
   */
  chunkShape: vec3;

  /**
   * Size of chunk grid, in chunks.
   */
  gridShape: Uint32Array;

  lods: MultiscaleMeshLOD[];
}

export class MultiscaleMeshSourceParameters {
  instance: BrainmapsInstance;
  volumeId: string;
  info: MultiscaleMeshInfo;
  changeSpec: ChangeSpec|undefined;

  static RPC_ID = 'brainmaps/MultiscaleMeshSource';
}

export class MeshSourceParameters  {
  instance: BrainmapsInstance;
  volumeId: string;
  meshName: string;
  changeSpec: ChangeSpec|undefined;
  
  static RPC_ID = 'brainmaps/MeshSource';
}

export class SkeletonSourceParameters  {
  instance: BrainmapsInstance;
  volumeId: string;
  meshName: string;
  changeSpec: ChangeSpec|undefined;
  
  static RPC_ID = 'brainmaps/SkeletonSource';
}

export class AnnotationSourceParameters {
  instance: BrainmapsInstance;
  volumeId: string;
  changestack: string;

  static RPC_ID = 'brainmaps/Annotation';
}
