/**
 * @license
 * Copyright 2026 William Silvermsith
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

#ifndef __CRACKLE_CRC32C_HXX__
#define __CRACKLE_CRC32C_HXX__

#include "crc32c_portable.hpp"

#include <vector>
#include <span>

namespace crackle {
namespace crc {

// Code from stackoverflow by Dr. Mark Adler
// https://stackoverflow.com/questions/10564491/function-to-calculate-a-crc16-checksum#comment83704063_10569892
// Polynomial 0xe7 is selected as "best" for messages up to
// 247 bits and gives a guarantee of detecting up to 2 bit flips
// according to Phil Koopman. Intended for protecting the v1 crackle header.
uint8_t crc8(uint8_t const *data, uint64_t size) {
	// use implicit +1 representation for right shift, LSB first
	// use explicit +1 representation for left shit, MSB first
	constexpr uint8_t polynomial = 0xe7; // implicit
	uint8_t crc = 0xFF; // detects zeroed data better than 0x00
	while (size--) {
		crc ^= *data++;
		for (unsigned int k = 0; k < 8; k++) {
			crc = crc & 1
				? (crc >> 1) ^ polynomial
				: crc >> 1;
		}
	}
	return crc;
}

uint32_t crc32c(const std::vector<unsigned char>& data) {
	return crc32_impl(0x0000, data.data(), data.size());
}

uint32_t crc32c(const std::span<unsigned char>& data) {
	return crc32_impl(0x0000, data.data(), data.size());
}

uint32_t crc32c(const std::span<const unsigned char>& data) {
	return crc32_impl(0x0000, data.data(), data.size());
}

uint32_t crc32c(const uint8_t *data, uint64_t size) {
	return crc32_impl(0x0000, data, size);
}

uint32_t crc32c(uint32_t *data, uint64_t size) {
	return crc32_impl(0x0000, reinterpret_cast<uint8_t*>(data), size * sizeof(uint32_t));
}


};
};

#endif
