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

#include "mesh_objects.h"

#include <cstddef>

#ifdef USE_OMP
#include <omp.h>
#endif

namespace neuroglancer {
namespace meshing {

template <class Label>
void MeshObjects(const Label* labels, const Vector3d& size,
                 const Vector3d& strides_arg,
                 std::unordered_map<uint64_t, TriangleMesh>* output) {
  if (size[0] * size[1] * size[2] == 0) {
    return;
  }
  auto strides = strides_arg;

  voxel_mesh_generator::VertexPositionMap map(size);

  // We iterate over 2*2*2 voxel cubes.
  Vector3d adjusted_size = size;
  for (auto& x : adjusted_size) x -= 1;

  ptrdiff_t corner_label_offset[8];
  for (int i = 0; i < 8; ++i) {
    auto const& cube_corner_position_offset =
        voxel_mesh_generator::cube_corner_position_offsets[i];
    ptrdiff_t offset = 0;
    for (int j = 0; j < 3; ++j) {
      offset += strides[j] * cube_corner_position_offset[j];
    }
    corner_label_offset[i] = offset;
  }

  output->clear();

#ifdef USE_OMP
#pragma omp parallel
#endif
  {
#ifdef USE_OMP
    uint64_t num_threads = omp_get_num_threads();
    uint64_t thread_num = omp_get_thread_num();
#endif
    std::unordered_map<uint64_t, TriangleMesh> cur_meshes;

    voxel_mesh_generator::SequentialVertexMap vertex_map(map);

    auto const* labels_z = labels;
    for (int64_t z = 0; z < adjusted_size[2]; ++z, labels_z += strides[2]) {
      auto const* labels_y = labels_z;
      for (int64_t y = 0; y < adjusted_size[1]; ++y, labels_y += strides[1]) {
        auto const* labels_x = labels_y;
        for (int64_t x = 0; x < adjusted_size[0]; ++x, labels_x += strides[0]) {
          // We need to call AddCube once per distinct non-zero label
          // contained within the 2x2x2 voxel region.  This thread will only
          // handle labels equivalent to thread_num (mod num_threads).
          std::array<uint64_t, 8> label_at_corners;
          label_at_corners[0] = labels_x[corner_label_offset[0]];
          bool not_all_same = false;
          for (int i = 1; i < 8; ++i) {
            auto label = label_at_corners[i] = labels_x[corner_label_offset[i]];
            if (label != label_at_corners[0]) {
              not_all_same = true;
            }
          }
          if (!not_all_same) {
            continue;
          }
          for (int i = 0; i < 8; ++i) {
            const auto label_i = label_at_corners[i];
            // Skip label 0 (background component).
            // Also skip objects not assigned to this thread.
            if (label_i != 0
#ifdef USE_OMP
                && label_i % num_threads == thread_num
#endif
                ) {
              // Determine if this label occurred at a prior corner index, in
              // which case we don't need to process it again.
              bool label_already_seen = false;
              for (int j = 0; j < i; ++j) {
                if (label_at_corners[j] == label_i) {
                  label_already_seen = true;
                  break;
                }
              }
              if (!label_already_seen) {
                uint8_t corners_present = 0;
                for (int j = i; j < 8; ++j) {
                  if (label_at_corners[j] == label_i) {
                    corners_present |= (1 << j);
                  }
                }
                voxel_mesh_generator::AddCube(Vector3d{x, y, z},
                                              corners_present, map, &vertex_map,
                                              &cur_meshes[label_i]);
              }
            }
          }
        }
      }
    }

#ifdef USE_OMP
#pragma omp critical
#endif
    {
      for (auto& p : cur_meshes) {
        output->emplace(p.first, std::move(p.second));
      }
    }
  }
}

#define DO_INSTANTIATE(Label)                                             \
  template void MeshObjects<Label>(                                       \
      const Label* labels, const Vector3d& size, const Vector3d& strides, \
      std::unordered_map<uint64_t, TriangleMesh>* output);                \
/**/
DO_INSTANTIATE(uint8_t)
DO_INSTANTIATE(uint16_t)
DO_INSTANTIATE(uint32_t)
DO_INSTANTIATE(uint64_t)
#undef DO_INSTANTIATE

}  // namespace meshing
}  // namespace neuroglancer
