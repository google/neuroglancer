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

#include "on_demand_object_mesh_generator.h"
#include "mesh_objects.h"

#include "OpenMesh/Core/Mesh/TriMeshT.hh"
#if OM_VERSION == 0x10000
#include "OpenMesh/Core/Mesh/Types/TriMesh_ArrayKernelT.hh"
#else
#include "OpenMesh/Core/Mesh/TriMesh_ArrayKernelT.hh"
#endif
#include "OpenMesh/Tools/Decimater/DecimaterT.hh"
#include "OpenMesh/Tools/Decimater/ModNormalFlippingT.hh"
#include "OpenMesh/Tools/Decimater/ModQuadricT.hh"

#include <memory>

#if __APPLE__
#include <libkern/OSByteOrder.h>
#define htole32(x) OSSwapHostToLittleInt32(x)
#elif defined(_WIN32)
#define htole32(x) (x)
#else
#include <endian.h>
#endif


namespace neuroglancer {
namespace meshing {

using OpenMeshTriangleMesh = OpenMesh::TriMesh_ArrayKernelT<OpenMesh::DefaultTraits>;
using Decimater = OpenMesh::Decimater::DecimaterT<OpenMeshTriangleMesh>;

// Converts a triangular mesh stored in a TriangleMesh into an
// OpenMeshTriangleMesh.
void ConvertToOpenMeshTriangleMesh(const TriangleMesh& mesh,
                                   OpenMeshTriangleMesh* new_mesh,
                                   const std::array<float, 3>& voxel_size,
                                   const std::array<float, 3>& offset) {
  for (auto vertex : mesh.vertex_positions) {
    for (int i = 0; i < 3; ++i) {
      vertex[i] = (vertex[i] + offset[i]) * voxel_size[i];
    }
    new_mesh->add_vertex(OpenMeshTriangleMesh::Point(vertex[0], vertex[1], vertex[2]));
  }
  std::vector<OpenMeshTriangleMesh::VertexHandle> triangle_vhandles(3);
  for (auto const& triangle : mesh.triangles) {
    for (int i = 0; i < 3; ++i) {
      triangle_vhandles[i] = new_mesh->vertex_handle(triangle[i]);
    }
    new_mesh->add_face(triangle_vhandles);

    // We silently skip triangles that result in degeneracy.
  }
}

std::string EncodeMesh(const OpenMeshTriangleMesh& mesh) {
  std::string output;
  size_t output_size = sizeof(uint32_t);
  const size_t vertex_offset = output_size;
  output_size += sizeof(float) * mesh.n_vertices() * 3;
  const size_t triangle_offset = output_size;
  output_size += mesh.n_faces() * 3 * sizeof(uint32_t);
  output.resize(output_size);

  // Write number of vertices.
  *reinterpret_cast<uint32_t*>(&output[0]) = mesh.n_vertices();

  // Write vertices.
  {
    float* vertex_buffer = reinterpret_cast<float*>(&output[vertex_offset]);
    for (auto vertex_it = mesh.vertices_begin();
         vertex_it != mesh.vertices_end(); ++vertex_it) {
      auto const& pt = mesh.point(vertex_it.handle());
      for (int i = 0; i < 3; ++i) {
        *(vertex_buffer++) = pt[i];
      }
    }
  }

  // Write triangles.
  {
    uint32_t* index_buffer =
        reinterpret_cast<uint32_t*>(&output[triangle_offset]);
    for (auto face_it = mesh.faces_begin(); face_it != mesh.faces_end();
         ++face_it) {
      auto circ = mesh.cfh_iter(face_it.handle());
      for (int i = 0; i < 3; ++i, ++circ) {
        auto vh = mesh.to_vertex_handle(circ.handle());
        *(index_buffer++) = vh.idx();
      }
    }
  }
  // Encoded mesh is a sequence of 32-bit values.  We need to convert
  // to little endian.
  const size_t num_32bit_words = output_size / sizeof(uint32_t);
  uint32_t *output_buffer = reinterpret_cast<uint32_t*>(&output[0]);
  for (size_t i = 0; i < num_32bit_words; ++i) {
    output_buffer[i] = htole32(output_buffer[i]);
  }
  return output;
}

bool SimplifyMesh(const SimplifyOptions& options, OpenMeshTriangleMesh* mesh) {
  if (options.lock_boundary_vertices) {
    mesh->request_vertex_status();
    for (auto it = mesh->vertices_begin(), end = mesh->vertices_end();
         it != end; ++it) {
      mesh->status(it.handle()).set_locked(mesh->is_boundary(it.handle()));
    }
  }
  mesh->request_face_normals();
  mesh->update_face_normals();
  Decimater decimater(*mesh);
#if OM_VERSION == 0x10000
  OpenMesh::Decimater::ModQuadricT<Decimater>::Handle quadrics_module;
  decimater.add_priority(quadrics_module);
  OpenMesh::Decimater::ModNormalFlippingT<Decimater>::Handle normals_module;
  decimater.add_binary(normals_module);
#else
  OpenMesh::Decimater::ModQuadricT<OpenMeshTriangleMesh>::Handle quadrics_module;
  decimater.add(quadrics_module);
  OpenMesh::Decimater::ModNormalFlippingT<OpenMeshTriangleMesh>::Handle normals_module;
  decimater.add(normals_module);
#endif
  decimater.module(quadrics_module).set_max_err(options.max_quadrics_error);
  decimater.module(normals_module)
      .set_max_normal_deviation(options.max_normal_angle_deviation);
  if (!decimater.initialize()) {
    return false;
  }
  decimater.decimate_to(0);
  mesh->garbage_collection();
  mesh->release_face_normals();
  return true;
}

struct OnDemandObjectMeshGenerator::Impl {
  std::unordered_map<uint64_t, TriangleMesh> unsimplified_meshes;
  std::unordered_map<uint64_t, std::string> simplified_meshes;
  std::array<float,3> voxel_size, offset;
  SimplifyOptions simplify_options;
};

template <class Label>
OnDemandObjectMeshGenerator::OnDemandObjectMeshGenerator(
    const Label* labels, const int64_t* size, const int64_t* strides,
    const float voxel_size[3], const float offset[3],
    const SimplifyOptions& simplify_options)
    : impl_(new Impl) {
  for (int i = 0; i < 3; ++i) {
    impl_->voxel_size[i] = voxel_size[i];
    impl_->offset[i] = offset[i];
  }
  impl_->simplify_options = simplify_options;
  MeshObjects(labels, {size[0], size[1], size[2]},
              {strides[0], strides[1], strides[2]},
              &impl_->unsimplified_meshes);
}


const std::string& OnDemandObjectMeshGenerator::GetSimplifiedMesh(
    uint64_t object_id) {
  const static std::string empty_string;
  {
    auto it = impl_->simplified_meshes.find(object_id);
    if (it != impl_->simplified_meshes.end()) {
      return it->second;
    }
  }

  auto it = impl_->unsimplified_meshes.find(object_id);

  if (it == impl_->unsimplified_meshes.end()) {
    return empty_string;
  }
  TriangleMesh& unsimplified_mesh = it->second;
  OpenMeshTriangleMesh triangle_mesh;
  ConvertToOpenMeshTriangleMesh(unsimplified_mesh, &triangle_mesh, impl_->voxel_size,
                        impl_->offset);
  impl_->unsimplified_meshes.erase(object_id);
  auto const &simplify_options = impl_->simplify_options;
  if (simplify_options.max_quadrics_error >= 0) {
    if (!SimplifyMesh(simplify_options, &triangle_mesh)) {
      // Can't happen.
      return empty_string;
    }
  }
  std::string encoded = EncodeMesh(triangle_mesh);
  return impl_->simplified_meshes.emplace(object_id, std::move(encoded))
      .first->second;
}

#define DO_INSTANTIATE(Label)                                           \
  template OnDemandObjectMeshGenerator::OnDemandObjectMeshGenerator(    \
      const Label* labels, const int64_t* size, const int64_t* strides, \
      const float voxel_size[3], const float offset[3],                 \
      const SimplifyOptions& simplify_options);                         \
/**/
DO_INSTANTIATE(uint8_t)
DO_INSTANTIATE(uint16_t)
DO_INSTANTIATE(uint32_t)
DO_INSTANTIATE(uint64_t)
#undef DO_INSTANTIATE

}  // namespace meshing
}  // namespace neuroglancer
