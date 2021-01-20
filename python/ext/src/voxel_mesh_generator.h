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

// Implements regular marching cubes for computing a surface mesh of a volume
// represented as a sparse set of voxel locations.

#ifndef NEUROGLANCER_VOXEL_MESH_GENERATOR_H_
#define NEUROGLANCER_VOXEL_MESH_GENERATOR_H_

#include <array>
#include <cstdint>
#include <limits>
#include <unordered_map>
#include <vector>

namespace neuroglancer {
namespace meshing {

using Vector3d = std::array<int64_t, 3>;

using VertexPositions = std::vector<std::array<float, 3>>;

struct TriangleMesh {
  using VertexIndex = uint32_t;

  VertexPositions vertex_positions;
  std::vector<std::array<VertexIndex, 3>> triangles;

  void clear() {
    vertex_positions.clear();
    triangles.clear();
  }

  size_t num_bytes() const {
    return vertex_positions.size() * sizeof(float) * 3 +
           triangles.size() * sizeof(VertexIndex) * 3;
  }
};

namespace voxel_mesh_generator {

extern std::array<Vector3d, 8> cube_corner_position_offsets;

using VertexLinearPosition = uint64_t;
using VertexIndex = TriangleMesh::VertexIndex;

class VertexPositionMap {
 public:
  VertexPositionMap() = default;

  explicit VertexPositionMap(const Vector3d& volume_size);

  // Given a voxel_position in [0, volume_size_), returns the linear vertex
  // position centered on the voxel at voxel_position.
  //
  // Linear vertex positions correspond to Fortran-order indices into an array
  // of size (volume_size_ * 2), where voxel positions correspond to the
  // vertex positions with even coordinates.
  VertexLinearPosition GetVertexLinearPositionFromVoxelPosition(
      const Vector3d& voxel_position) const {
    return voxel_position[0] * voxel_position_to_vertex_index_[0] +
           voxel_position[1] * voxel_position_to_vertex_index_[1] +
           voxel_position[2] * voxel_position_to_vertex_index_[2];
  }

  // Returns the offset of the VertexLinearPosition corresponding to the
  // midpoint of the specified cube edge, relative to the VertexLinearPosition
  // at the cube origin.
  //
  // Args:
  //   edge_i: specifies a cube edge, must be in [0, 12),
  VertexLinearPosition GetCubeEdgeMidpointVertexLinearPositionOffset(
      int edge_i) const {
    return cube_edge_midpoint_vertex_linear_position_offsets_[edge_i];
  }

  // Same as above, but returns the offset of the coordinates of the midpoint
  // vertex relative to the vertex coordinates of the cube origin.
  const std::array<float, 3>& GetCubeEdgeMidpointVertexPositionOffset(
      int edge_i) const {
    return cube_edge_midpoint_vertex_position_offsets_[edge_i];
  }

  std::array<float, 3> GetEdgeMidpointVertexPosition(
      const Vector3d& base_voxel_position, int edge_i) const {
    std::array<float, 3> edge_midpoint_vertex_position;
    auto const& edge_midpoint_vertex_offset =
        GetCubeEdgeMidpointVertexPositionOffset(edge_i);
    for (int i = 0; i < 3; ++i) {
      edge_midpoint_vertex_position[i] =
          static_cast<float>(base_voxel_position[i]) +
          edge_midpoint_vertex_offset[i];
    }
    return edge_midpoint_vertex_position;
  }

  const Vector3d& volume_size() const { return volume_size_; }

 private:
  Vector3d volume_size_;

  // Linear transform coefficients for converting a voxel position to a
  // VertexLinearPosition.
  Vector3d voxel_position_to_vertex_index_;

  std::array<VertexLinearPosition, 12>
      cube_edge_midpoint_vertex_linear_position_offsets_;

  std::array<std::array<float, 3>, 12>
      cube_edge_midpoint_vertex_position_offsets_;
};

// This class maintains a mapping from vertex linear positions to
// vertex indices for multiple VertexPositions objects, each
// corresponding to distinct label values.  This can only be used when
// successive calls have non-decreasing values of
// base_linear_position.  Use the less efficient HashedVertexMap when
// that constraint can't be satisfied.
class SequentialVertexMap {
 public:
  SequentialVertexMap(const VertexPositionMap& map) {
    size_t buffer_size =
        map.volume_size()[0] * 2 * map.volume_size()[1] * 2 * 2 * 2;
    size_t buffer_size_power_of_two = 1;
    while (buffer_size_power_of_two < buffer_size) {
      buffer_size_power_of_two *= 2;
    }
    vertex_index_.resize(buffer_size_power_of_two,
                         {{0, 0},
                          {std::numeric_limits<VertexLinearPosition>::max(),
                           std::numeric_limits<VertexLinearPosition>::max()}});
    linear_position_mask_ = buffer_size_power_of_two - 1;
  }

  // Selector specifies the presence of the first corner of the edge
  // in the labeled object corresponding to vertex_positions.  A
  // vertex may be placed at the same position for multiple objects,
  // but not with the same value of selector.
  VertexIndex operator()(const VertexPositionMap& map,
                         VertexLinearPosition base_vertex_linear_position,
                         const Vector3d& base_voxel_position, int edge_i,
                         int selector, VertexPositions* vertex_positions) {
    VertexLinearPosition edge_midpoint_vertex_linear_position =
        base_vertex_linear_position +
        map.GetCubeEdgeMidpointVertexLinearPositionOffset(edge_i);

    auto& p = vertex_index_[edge_midpoint_vertex_linear_position &
                            linear_position_mask_];
    if (p.second[selector] == edge_midpoint_vertex_linear_position) {
      return p.first[selector];
    }
    p.second[selector] = edge_midpoint_vertex_linear_position;
    VertexIndex edge_midpoint_vertex_index = p.first[selector] =
        static_cast<VertexIndex>(vertex_positions->size());
    auto edge_midpoint_vertex_position =
        map.GetEdgeMidpointVertexPosition(base_voxel_position, edge_i);
    vertex_positions->push_back(edge_midpoint_vertex_position);
    return edge_midpoint_vertex_index;
  }

 private:
  std::vector<std::pair<std::array<VertexIndex, 2>,
                        std::array<VertexLinearPosition, 2>>>
      vertex_index_;
  VertexLinearPosition linear_position_mask_;
};

// This class maintains a mapping from vertex linear positions to
// vertex indices within a VertexPositions object.  The mapping is
// maintained using an unordered_map for full generality.
class HashedVertexMap {
 public:
  VertexIndex operator()(const VertexPositionMap& map,
                         VertexLinearPosition base_vertex_linear_position,
                         const Vector3d& base_voxel_position, int edge_i,
                         int selector, VertexPositions* vertex_positions) {
    VertexLinearPosition edge_midpoint_vertex_linear_position =
        base_vertex_linear_position +
        map.GetCubeEdgeMidpointVertexLinearPositionOffset(edge_i);

    VertexLinearPosition key =
        edge_midpoint_vertex_linear_position * 2 + selector;

    auto it = vertex_index_.find(key);
    if (it != vertex_index_.end()) {
      return it->second;
    }
    VertexIndex edge_midpoint_vertex_index =
        static_cast<VertexIndex>(vertex_index_.size());
    vertex_index_.emplace(key, edge_midpoint_vertex_index);
    auto edge_midpoint_vertex_position =
        map.GetEdgeMidpointVertexPosition(base_voxel_position, edge_i);
    vertex_positions->push_back(edge_midpoint_vertex_position);
    return edge_midpoint_vertex_index;
  }

  const std::unordered_map<VertexLinearPosition, VertexIndex>& vertex_index()
      const {
    return vertex_index_;
  }
  std::unordered_map<VertexLinearPosition, VertexIndex>& vertex_index() {
    return vertex_index_;
  }

 private:
  std::unordered_map<VertexLinearPosition, VertexIndex> vertex_index_;
};

// Processes a cube that correspond to the 2*2*2 block of voxels at voxel
// positions [position, position+1].
//
// VertexMap must be either SequentialVertexMap or HashedVertexMap.
//
// The same VertexMap may be used for more than one mesh, provided
// that the meshes correspond to distinct labels within the same
// volume.
//
// corners_present is a bitmask specifying which of the voxel positions is
// contained in the object.  bit_i of corners_present corresponds to the voxel
// at voxel position:
//
//   position + cube_corner_position_offsets[bit_i].
template <class VertexMap>
void AddCube(const Vector3d& position, uint8_t corners_present,
             const VertexPositionMap& map, VertexMap* vertex_map,
             TriangleMesh* mesh);

}  // namespace voxel_mesh_generator
}  // namespace meshing
}  // namespace neuroglancer

#endif  // NEUROGLANCER_VOXEL_MESH_GENERATOR_H_
