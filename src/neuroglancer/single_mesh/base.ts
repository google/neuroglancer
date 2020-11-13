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

import {DataType} from 'neuroglancer/util/data_type';

export const SINGLE_MESH_LAYER_RPC_ID = 'single_mesh/SingleMeshLayer';
export const GET_SINGLE_MESH_INFO_RPC_ID = 'single_mesh/getSingleMeshInfo';

export const SINGLE_MESH_CHUNK_KEY = '';

export interface VertexAttributeInfo {
  name: string;
  dataType: DataType;
  numComponents: number;
  source?: string;
  min?: number;
  max?: number;
}

export interface SingleMeshInfo {
  numVertices: number;
  numTriangles: number;
  // Perhaps bounding box?
  // Perhaps transform data?
  vertexAttributes: VertexAttributeInfo[];
}

export interface SingleMeshData {
  vertexPositions: Float32Array;
  indices: Uint32Array;
  vertexNormals?: Float32Array;
  vertexAttributes: Float32Array[];
}

export class SingleMeshSourceParameters {
  meshSourceUrl: string;
}

export class SingleMeshSourceParametersWithInfo extends SingleMeshSourceParameters {
  info: SingleMeshInfo;

  static RPC_ID = 'single_mesh/SingleMeshSource';
}
