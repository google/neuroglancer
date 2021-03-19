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

export const MESH_LAYER_RPC_ID = 'mesh/MeshLayer';
export const MULTISCALE_MESH_LAYER_RPC_ID = 'mesh/MultiscaleMeshLayer';
export const FRAGMENT_SOURCE_RPC_ID = 'mesh/FragmentSource';

export const MULTISCALE_FRAGMENT_SOURCE_RPC_ID = 'mesh/MultiscaleFragmentSource';

export type EncodedVertexPositions = Float32Array|Uint32Array|Uint16Array;
export type MeshVertexIndices = Uint16Array|Uint32Array;
export type OctahedronVertexNormals = Uint8Array;

export interface EncodedMeshData {
  vertexPositions: EncodedVertexPositions;
  vertexNormals: OctahedronVertexNormals;
  indices: MeshVertexIndices;
  strips: boolean;
}

export interface MultiscaleFragmentFormat {
  /**
   * If `true`, vertex positions are specified relative to the fragment bounds, meaning (0, 0, 0) is
   * the start corner of the fragment and (1, 1, 1) is the end corner.
   *
   * If `false`, vertex positions are in "model" coordinates.
   */
  fragmentRelativeVertices: boolean;

  vertexPositionFormat: VertexPositionFormat;
}

export enum VertexPositionFormat {
  float32,
  uint10,
  uint16,
}
