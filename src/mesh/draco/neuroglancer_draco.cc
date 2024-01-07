#include <cstdint>
#include <memory>

#include "draco/compression/decode.h"
#include "draco/mesh/mesh_stripifier.h"

namespace {
struct FreeDeleter {
  void operator()(void *p) const { ::free(p); }
};

/// Lookup table that maps numbers 0 to 255 to the index of the first non-zero
/// bit, or 0 if all bits are 0.
constexpr std::uint8_t first_bit_lookup_table[256] = {
    0, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0,
    5, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0,
    6, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0,
    5, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0,
    7, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0,
    5, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0,
    6, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0,
    5, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0};

}  // namespace

extern "C" {
extern void neuroglancer_draco_receive_decoded_mesh(unsigned int num_indices,
                                                    unsigned int num_positions, const void *indices,
                                                    const void *vertex_positions,
                                                    const void *subchunk_offsets);

int neuroglancer_draco_decode(char *input, unsigned int input_size, bool partition,
                              int vertex_quantization_bits, bool skipDequantization) {
  std::unique_ptr<char[], FreeDeleter> input_deleter(input);
  draco::DecoderBuffer decoder_buffer;
  decoder_buffer.Init(input, input_size);
  draco::Decoder decoder;
  if (skipDequantization) {
    decoder.SetSkipAttributeTransform(draco::GeometryAttribute::POSITION);
  }
  auto decoded_mesh_statusor = decoder.DecodeMeshFromBuffer(&decoder_buffer);
  if (!decoded_mesh_statusor.ok()) return 1;
  auto *decoded_mesh = decoded_mesh_statusor.value().get();
  auto num_vertices = decoded_mesh->num_points();
  auto num_faces = decoded_mesh->num_faces();
  // draco::MeshStripifier stripifier;
  // constexpr std::uint32_t restart_index = ~static_cast<std::uint32_t>(0);
  // if (!stripifier.GenerateTriangleStripsWithPrimitiveRestart(*decoded_mesh, restart_index,
  //                                                            std::back_inserter(indices))) {
  //   return 2;
  // }
  const auto *position_att = decoded_mesh->GetNamedAttribute(draco::GeometryAttribute::POSITION);
  if (!position_att) {
    return 3;
  }
  if (position_att->num_components() != 3) return 4;
  if (position_att->data_type() != draco::DT_INT32 && position_att->data_type() != draco::DT_FLOAT32) return 5;
  if (decoded_mesh->GetAttributeElementType(position_att->unique_id()) !=
      draco::MESH_CORNER_ATTRIBUTE) {
    return 11;
  }
  if (position_att->size() != num_vertices) return 1000 + position_att->size();

  std::unique_ptr<std::uint32_t[], FreeDeleter> indices(
      static_cast<std::uint32_t *>(::malloc(sizeof(std::uint32_t) * 3 * num_faces)));
  for (unsigned int face_i = 0; face_i < num_faces; ++face_i) {
    const auto &face = decoded_mesh->face(draco::FaceIndex(face_i));
    for (int i = 0; i < 3; ++i) {
      indices[face_i * 3 + i] = face[i].value();
    }
  }

  if (!position_att->is_mapping_identity()) {
    // Remap indices
    for (size_t i = 0; i < num_faces * 3; ++i) {
      indices[i] = position_att->mapped_index(draco::PointIndex(indices[i])).value();
    }
  }

  auto *vertex_positions = reinterpret_cast<const std::uint32_t *>(
      position_att->GetAddress(draco::AttributeValueIndex(0)));
  if (partition) {
    const auto get_vertex_mask = [&](auto *v_pos) {
      const std::uint32_t partition_point =
          (std::numeric_limits<std::uint32_t>::max() >> (32 - vertex_quantization_bits)) / 2 + 1;
      // mask is 1 if point can be included in octree node
      unsigned int mask = 0xFF;
      if (v_pos[0] < partition_point) {
        // mask of octree nodes with x=0

        // 0: x=0, y=0, z=0
        // 1: x=1, y=0, z=0
        // 2: x=0, y=1, z=0
        // 3: x=1, y=1, z=0
        // 4: x=0, y=0, z=1
        // 5: x=1, y=0, z=1
        // 6: x=0, y=1, z=1
        // 7: x=1, y=1, z=1

        mask &= 0b01010101;
      } else if (v_pos[0] > partition_point) {
        mask &= 0b10101010;
      }
      if (v_pos[1] < partition_point) {
        mask &= 0b00110011;
      } else if (v_pos[1] > partition_point) {
        mask &= 0b11001100;
      }
      if (v_pos[2] < partition_point) {
        mask &= 0b00001111;
      } else if (v_pos[2] > partition_point) {
        mask &= 0b11110000;
      }
      return mask;
    };

    std::unique_ptr<std::uint32_t[], FreeDeleter> partitioned_indices(
        static_cast<std::uint32_t *>(::malloc(sizeof(std::uint32_t) * 3 * num_faces)));

    const auto for_each_face = [&](auto func) {
      for (size_t i = 0; i < num_faces * 3; i += 3) {
        unsigned int mask = 0xFF;
        for (int j = 0; j < 3; ++j) {
          mask &= get_vertex_mask(vertex_positions + indices[i + j] * 3);
        }
        func(i, first_bit_lookup_table[mask]);
      }
    };

    std::uint32_t subchunk_offsets[9] = {0, 0, 0, 0, 0, 0, 0, 0, 0};
    for_each_face(
        [&](size_t i, unsigned int partition_i) { subchunk_offsets[partition_i + 1] += 3; });

    std::uint32_t sum = 0;
    for (int i = 0; i < 8; ++i) {
      auto count = subchunk_offsets[i + 1];
      subchunk_offsets[i + 1] = sum;
      sum += count;
    }

    for_each_face([&](size_t i, unsigned int partition_i) {
      auto offset = subchunk_offsets[partition_i + 1];
      subchunk_offsets[partition_i + 1] += 3;
      for (int j = 0; j < 3; ++j) {
        partitioned_indices[offset + j] = indices[i + j];
      }
    });

    neuroglancer_draco_receive_decoded_mesh(num_faces, num_vertices, partitioned_indices.get(),
                                            vertex_positions, subchunk_offsets);
  } else {
    std::uint32_t subchunk_offsets[2] = {0, num_faces * 3};
    neuroglancer_draco_receive_decoded_mesh(num_faces, num_vertices, indices.get(),
                                            vertex_positions, subchunk_offsets);
  }
  return 0;
}
}
