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

#include "gtest/gtest.h"

namespace neuroglancer {
namespace compress_segmentation {
namespace {

// Test 0-bit encoding.
TEST(EncodeBlockTest, Basic0) {
  std::vector<uint64_t> input{3, 3, 3, 3};
  const ptrdiff_t input_strides[3] = {1, 2, 4};
  const ptrdiff_t block_size[3] = {2, 2, 1};
  std::vector<uint32_t> output;
  std::vector<uint32_t> expected{3, 0};
  size_t encoded_bits;
  size_t table_offset;
  EncodedValueCache<uint64_t> cache;
  EncodeBlock(input.data(), input_strides, block_size, block_size, 0,
              &encoded_bits, &table_offset, &cache, &output);
  ASSERT_EQ(0, encoded_bits);
  ASSERT_EQ(0, table_offset);
  ASSERT_EQ(expected, output);
  ASSERT_EQ(cache, (EncodedValueCache<uint64_t>{{{3}, 0}}));
}

// Test 0-bit encoding with existing data in output buffer.
TEST(EncodeBlockTest, BasicPreserveExisting) {
  std::vector<uint64_t> input{3, 3, 3, 3};
  const ptrdiff_t input_strides[3] = {1, 2, 4};
  const ptrdiff_t block_size[3] = {2, 2, 1};
  std::vector<uint32_t> output{1, 2, 3};
  std::vector<uint32_t> expected{1, 2, 3, 3, 0};
  size_t encoded_bits;
  size_t table_offset;
  EncodedValueCache<uint64_t> cache;
  EncodeBlock(input.data(), input_strides, block_size, block_size, 3,
              &encoded_bits, &table_offset, &cache, &output);
  ASSERT_EQ(0, encoded_bits);
  ASSERT_EQ(0, table_offset);
  ASSERT_EQ(expected, output);
  ASSERT_EQ(cache, (EncodedValueCache<uint64_t>{{{3}, 0}}));
}

// Test 1-bit encoding.
TEST(EncodeBlockTest, Basic1) {
  std::vector<uint64_t> input{4, 3, 4, 4};
  const ptrdiff_t input_strides[3] = {1, 2, 4};
  const ptrdiff_t block_size[3] = {2, 2, 1};
  std::vector<uint32_t> output{1, 2, 3};
  std::vector<uint32_t> expected{1, 2, 3, 13 /*=0b1101*/, 3, 0, 4, 0};
  size_t encoded_bits;
  size_t table_offset;
  EncodedValueCache<uint64_t> cache;
  EncodeBlock(input.data(), input_strides, block_size, block_size, 3,
              &encoded_bits, &table_offset, &cache, &output);
  ASSERT_EQ(1, encoded_bits);
  ASSERT_EQ(1, table_offset);
  ASSERT_EQ(expected, output);
  ASSERT_EQ(cache, (EncodedValueCache<uint64_t>{{{3, 4}, 1}}));
}

// Test 1-bit encoding, actual_size != block_size.
TEST(EncodeBlockTest, SizeMismatch) {
  std::vector<uint64_t> input{4, 3, 4, 3};
  const ptrdiff_t input_strides[3] = {1, 2, 4};
  const ptrdiff_t block_size[3] = {3, 2, 1};
  const ptrdiff_t actual_size[3] = {2, 2, 1};
  std::vector<uint32_t> output{1, 2, 3};
  std::vector<uint32_t> expected{1, 2, 3, 9 /*=0b001001*/, 3, 0, 4, 0};
  size_t encoded_bits;
  size_t table_offset;
  EncodedValueCache<uint64_t> cache;
  EncodeBlock(input.data(), input_strides, block_size, actual_size, 3,
              &encoded_bits, &table_offset, &cache, &output);
  ASSERT_EQ(1, encoded_bits);
  ASSERT_EQ(1, table_offset);
  ASSERT_EQ(expected, output);
  ASSERT_EQ(cache, (EncodedValueCache<uint64_t>{{{3, 4}, 1}}));
}

// Test 2-bit encoding.
TEST(EncodeBlockTest, Basic2) {
  std::vector<uint64_t> input{4, 3, 5, 4};
  const ptrdiff_t input_strides[3] = {1, 2, 4};
  const ptrdiff_t block_size[3] = {2, 2, 1};
  std::vector<uint32_t> output{1, 2, 3};
  std::vector<uint32_t> expected{1, 2, 3, 97 /*=0b01100001*/, 3, 0, 4, 0, 5, 0};
  size_t encoded_bits;
  size_t table_offset;
  EncodedValueCache<uint64_t> cache;
  EncodeBlock(input.data(), input_strides, block_size, block_size, 3,
              &encoded_bits, &table_offset, &cache, &output);
  ASSERT_EQ(2, encoded_bits);
  ASSERT_EQ(1, table_offset);
  ASSERT_EQ(expected, output);
  ASSERT_EQ(cache, (EncodedValueCache<uint64_t>{{{3, 4, 5}, 1}}));
}

TEST(CompressChannelTest, Basic) {
  std::vector<uint64_t> input{4, 3, 5, 4, 1, 3, 3, 3};
  const ptrdiff_t input_strides[3] = {1, 2, 4};
  const ptrdiff_t volume_size[3] = {2, 2, 2};
  const ptrdiff_t block_size[3] = {2, 2, 1};
  std::vector<uint32_t> output{1, 2, 3};
  std::vector<uint32_t> expected{1,
                                 2,
                                 3,
                                 5 | (2 << 24),
                                 4,
                                 12 | (1 << 24),
                                 11,
                                 97 /*=0b01100001*/,
                                 3,
                                 0,
                                 4,
                                 0,
                                 5,
                                 0,
                                 14 /*=0b1110*/,
                                 1,
                                 0,
                                 3,
                                 0};
  CompressChannel(input.data(), input_strides, volume_size, block_size,
                  &output);
  ASSERT_EQ(expected, output);
}

TEST(CompressChannelTest, BasicCached) {
  std::vector<uint64_t> input{
      4, 3, 5, 4,  //
      1, 3, 3, 3,  //
      3, 1, 1, 1,  //
      5, 5, 3, 4,  //
  };
  const ptrdiff_t input_strides[3] = {1, 2, 4};
  const ptrdiff_t volume_size[3] = {2, 2, 4};
  const ptrdiff_t block_size[3] = {2, 2, 1};
  std::vector<uint32_t> output{1, 2, 3};
  std::vector<uint32_t> expected{
      1,
      2,
      3,
      9 | (2 << 24),
      8,
      16 | (1 << 24),
      15,
      16 | (1 << 24),
      20,
      9 | (2 << 24),
      21,
      97 /*=0b01100001*/,
      3,
      0,
      4,
      0,
      5,
      0,
      14 /*=0b1110*/,
      1,
      0,
      3,
      0,
      1 /*=0b00000001*/,
      74 /*=0b01001010*/,
  };
  CompressChannel(input.data(), input_strides, volume_size, block_size,
                  &output);
  ASSERT_EQ(expected, output);
}

TEST(CompressChannelTest, BasicCached32) {
  std::vector<uint32_t> input{
      4, 3, 5, 4,  //
      1, 3, 3, 3,  //
      3, 1, 1, 1,  //
      5, 5, 3, 4,  //
  };
  const ptrdiff_t input_strides[3] = {1, 2, 4};
  const ptrdiff_t volume_size[3] = {2, 2, 4};
  const ptrdiff_t block_size[3] = {2, 2, 1};
  std::vector<uint32_t> output{1, 2, 3};
  std::vector<uint32_t> expected{
      1,
      2,
      3,
      9 | (2 << 24),
      8,
      13 | (1 << 24),
      12,
      13 | (1 << 24),
      15,
      9 | (2 << 24),
      16,
      97 /*=0b01100001*/,
      3,
      4,
      5,
      14 /*=0b1110*/,
      1,
      3,
      1 /*=0b00000001*/,
      74 /*=0b01001010*/,
  };
  CompressChannel(input.data(), input_strides, volume_size, block_size,
                  &output);
  ASSERT_EQ(expected, output);
}

}  // namespace
}  // namespace compress_segmentation
}  // namespace neuroglancer
