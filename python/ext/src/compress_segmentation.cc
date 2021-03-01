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

#include "compress_segmentation.h"

#include <algorithm>
#include <unordered_map>

namespace neuroglancer {
namespace compress_segmentation {

constexpr size_t kBlockHeaderSize = 2;

void WriteBlockHeader(size_t encoded_value_base_offset,
                      size_t table_base_offset, size_t encoding_bits,
                      uint32_t output[2]) {
  output[0] = table_base_offset | (encoding_bits << 24);
  output[1] = encoded_value_base_offset;
}

template <class Label>
void EncodeBlock(const Label* input, const ptrdiff_t input_strides[3],
                 const ptrdiff_t block_size[3], const ptrdiff_t actual_size[3],
                 size_t base_offset, size_t* encoded_bits_output,
                 size_t* table_offset_output, EncodedValueCache<Label>* cache,
                 std::vector<uint32_t>* output_vec) {
  if (actual_size[0] * actual_size[1] * actual_size[2] == 0) {
    *encoded_bits_output = 0;
    *table_offset_output = 0;
    return;
  }

  constexpr size_t num_32bit_words_per_label =
      (sizeof(Label) + sizeof(uint32_t) - 1) / sizeof(uint32_t);

  std::unordered_map<Label, uint32_t> seen_values;
  std::vector<Label> seen_values_inv;

  // First determine the distinct values.

  // Initialize previous_value such that it is guaranteed not to equal to the
  // first value.
  Label previous_value = input[0] + 1;
  {
    auto* input_z = input;
    for (size_t z = 0; z < actual_size[2]; ++z) {
      auto* input_y = input_z;
      for (size_t y = 0; y < actual_size[1]; ++y) {
        auto* input_x = input_y;
        for (size_t x = 0; x < actual_size[0]; ++x) {
          auto value = *input_x;
          // If this value matches the previous value, we can skip the more
          // expensive hash table lookup.
          if (value != previous_value) {
            previous_value = value;
            if (seen_values.emplace(value, 0).second) {
              seen_values_inv.push_back(value);
            }
          }

          input_x += input_strides[0];
        }
        input_y += input_strides[1];
      }
      input_z += input_strides[2];
    }
  }

  std::sort(seen_values_inv.begin(), seen_values_inv.end());
  for (size_t i = 0; i < seen_values_inv.size(); ++i) {
    seen_values[seen_values_inv[i]] = static_cast<uint32_t>(i);
  }

  // Determine number of bits with which to encode each index.
  size_t encoded_bits = 0;
  if (seen_values.size() != 1) {
    encoded_bits = 1;
    while ((1 << encoded_bits) < seen_values.size()) {
      encoded_bits *= 2;
    }
  }
  *encoded_bits_output = encoded_bits;
  const size_t encoded_size_32bits =
      (encoded_bits * block_size[0] * block_size[1] * block_size[2] + 31) / 32;

  const size_t encoded_value_base_offset = output_vec->size();
  size_t elements_to_write = encoded_size_32bits;

  bool write_table;
  {
    auto it = cache->find(seen_values_inv);
    if (it == cache->end()) {
      write_table = true;
      elements_to_write += seen_values.size() * num_32bit_words_per_label;
      *table_offset_output =
          encoded_value_base_offset + encoded_size_32bits - base_offset;
    } else {
      write_table = false;
      *table_offset_output = it->second;
    }
  }

  output_vec->resize(encoded_value_base_offset + elements_to_write);
  uint32_t* output = output_vec->data() + encoded_value_base_offset;
  // Write encoded representation.
  {
    auto* input_z = input;
    for (size_t z = 0; z < actual_size[2]; ++z) {
      auto* input_y = input_z;
      for (size_t y = 0; y < actual_size[1]; ++y) {
        auto* input_x = input_y;
        for (size_t x = 0; x < actual_size[0]; ++x) {
          auto value = *input_x;
          uint32_t index = seen_values.at(value);
          size_t output_offset = x + block_size[0] * (y + block_size[1] * z);
          output[output_offset * encoded_bits / 32] |=
              (index << (output_offset * encoded_bits % 32));

          input_x += input_strides[0];
        }
        input_y += input_strides[1];
      }
      input_z += input_strides[2];
    }
  }

  // Write table
  if (write_table) {
    output =
        output_vec->data() + encoded_value_base_offset + encoded_size_32bits;
    for (auto value : seen_values_inv) {
      for (int word_i = 0; word_i < num_32bit_words_per_label; ++word_i) {
        output[word_i] = static_cast<uint32_t>(value >> (32 * word_i));
      }
      output += num_32bit_words_per_label;
    }
    cache->emplace(seen_values_inv, *table_offset_output);
  }
}

template <class Label>
void CompressChannel(const Label* input, const ptrdiff_t input_strides[3],
                     const ptrdiff_t volume_size[3],
                     const ptrdiff_t block_size[3],
                     std::vector<uint32_t>* output) {
  EncodedValueCache<Label> cache;
  const size_t base_offset = output->size();
  ptrdiff_t grid_size[3];
  size_t block_index_size = kBlockHeaderSize;
  for (size_t i = 0; i < 3; ++i) {
    grid_size[i] = (volume_size[i] + block_size[i] - 1) / block_size[i];
    block_index_size *= grid_size[i];
  }
  output->resize(base_offset + block_index_size);
  ptrdiff_t block[3];
  for (block[2] = 0; block[2] < grid_size[2]; ++block[2]) {
    for (block[1] = 0; block[1] < grid_size[1]; ++block[1]) {
      for (block[0] = 0; block[0] < grid_size[0]; ++block[0]) {
        const size_t block_offset =
            block[0] + grid_size[0] * (block[1] + grid_size[1] * block[2]);
        ptrdiff_t actual_size[3];
        ptrdiff_t input_offset = 0;
        size_t num_values = 1;
        for (size_t i = 0; i < 3; ++i) {
          auto pos = block[i] * block_size[i];
          actual_size[i] = std::min(block_size[i], volume_size[i] - pos);
          input_offset += pos * input_strides[i];
          num_values *= actual_size[i];
        }
        const size_t encoded_value_base_offset = output->size() - base_offset;
        size_t encoded_bits, table_offset;
        EncodeBlock(input + input_offset, input_strides, block_size,
                    actual_size, base_offset, &encoded_bits, &table_offset,
                    &cache, output);
        WriteBlockHeader(
            encoded_value_base_offset, table_offset, encoded_bits,
            &(*output)[base_offset + block_offset * kBlockHeaderSize]);
      }
    }
  }
}

template <class Label>
void CompressChannels(const Label* input, const ptrdiff_t input_strides[4],
                      const ptrdiff_t volume_size[4],
                      const ptrdiff_t block_size[3],
                      std::vector<uint32_t>* output) {
  output->resize(volume_size[3]);
  for (size_t channel_i = 0; channel_i < volume_size[3]; ++channel_i) {
    (*output)[channel_i] = output->size();
    CompressChannel(input + input_strides[3] * channel_i, input_strides,
                    volume_size, block_size, output);
  }
}

#define DO_INSTANTIATE(Label)                                        \
  template void EncodeBlock<Label>(                                  \
      const Label* input, const ptrdiff_t input_strides[3],          \
      const ptrdiff_t block_size[3], const ptrdiff_t actual_size[3], \
      size_t base_offset, size_t* encoded_bits_output,               \
      size_t* table_offset_output, EncodedValueCache<Label>* cache,  \
      std::vector<uint32_t>* output_vec);                            \
  template void CompressChannel<Label>(                              \
      const Label* input, const ptrdiff_t input_strides[3],          \
      const ptrdiff_t volume_size[3], const ptrdiff_t block_size[3], \
      std::vector<uint32_t>* output);                                \
  template void CompressChannels<Label>(                             \
      const Label* input, const ptrdiff_t input_strides[4],          \
      const ptrdiff_t volume_size[4], const ptrdiff_t block_size[3], \
      std::vector<uint32_t>* output);                                \
/**/

DO_INSTANTIATE(uint32_t)
DO_INSTANTIATE(uint64_t)

#undef DO_INSTANTIATE

}  // namespace compress_segmentation
}  // namespace neuroglancer
