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

#ifndef NEUROGLANCER_ON_DEMAND_OBJECT_MESH_GENERATOR_H
#define NEUROGLANCER_ON_DEMAND_OBJECT_MESH_GENERATOR_H

#include <cstddef>
#include <memory>
#include <string>

namespace neuroglancer {
namespace meshing {

struct SimplifyOptions {
  // Maximum quadrics error.  Set this to a negative value to disable
  // simplification.
  double max_quadrics_error = 1e6;

  // Collapses that change the normal angle by more this amount are
  // prohibited.  Angle is specified in degrees.
  double max_normal_angle_deviation = 90;

  bool lock_boundary_vertices = true;
};

class OnDemandObjectMeshGenerator {
  struct Impl;

 public:
  OnDemandObjectMeshGenerator() = default;

  // Label must be one of uint8_t, uint16_t, uint32_t, uint64_t.
  template <class Label>
  OnDemandObjectMeshGenerator(const Label* labels, const int64_t* size,
                              const int64_t* strides, const float voxel_size[3],
                              const float offset[3],
                              const SimplifyOptions& simplify_options);

  const std::string& GetSimplifiedMesh(uint64_t object_id);
  explicit operator bool() { return bool(impl_); }
  std::shared_ptr<Impl> impl_;
};

}  // namespace meshing
}  // namespace neuroglancer

#endif //  NEUROGLANCER_ON_DEMAND_OBJECT_MESH_GENERATOR_H
