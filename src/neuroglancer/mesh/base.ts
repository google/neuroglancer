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

export interface EncodedMeshData {
  vertexPositions: Float32Array;
  vertexNormals: Uint8Array;
  indices: Uint32Array|Uint16Array;
  strips: boolean;
}
