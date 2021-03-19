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

#ifndef NEUROGLANCER_MESH_OBJECTS_H_
#define NEUROGLANCER_MESH_OBJECTS_H_

#include <unordered_map>

#include "voxel_mesh_generator.h"

namespace neuroglancer {
namespace meshing {

// Computes a surface mesh for each non-zero label.
//
// Label must be one of uint8_t, uint16_t, uint32_t, uint64_t.
template <class Label>
void MeshObjects(const Label* labels, const Vector3d& size,
                 const Vector3d& strides,
                 std::unordered_map<uint64_t, TriangleMesh>* output);

}  // namespace meshing
}  // namespace neuroglancer

#endif  // NEUROGLANCER_MESH_OBJECTS_H_
