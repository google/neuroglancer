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

#ifndef __CRACKLE_HXX__
#define __CRACKLE_HXX__

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <vector>
#include <type_traits>

#include "cc3d.hpp"
#include "header.hpp"
#include "crackcodes.hpp"
#include "lib.hpp"
#include "labels.hpp"
#include "pins.hpp"
#include "markov.hpp"

namespace crackle {

std::vector<uint64_t> get_crack_code_offsets(
	const CrackleHeader &header,
	const std::span<const unsigned char> &binary,
	int& err
) {
	uint64_t offset = header.header_bytes();

	const uint64_t z_width = sizeof(uint32_t);

	if (offset + header.grid_index_bytes() > binary.size()) {
		err = 41;
		return std::vector<uint64_t>();
	}

	const unsigned char* buf = binary.data();

	if (header.format_version > 0) {
		const uint32_t stored_crc32c = crackle::lib::ctoi<uint32_t>(
			buf, offset + z_width * header.sz
		);
		const uint32_t computed_crc32c = crackle::crc::crc32c(
			buf + offset, header.grid_index_bytes() - sizeof(uint32_t)
		);

		if (stored_crc32c != computed_crc32c) {
			err = 42;
			return std::vector<uint64_t>();
		}
	}

	std::vector<uint64_t> z_index(header.sz + 1);
	for (uint64_t z = 0; z < header.sz; z++) {
		z_index[z+1] = lib::ctoi<uint32_t>(buf, offset + z_width * z);
	}
	for (uint64_t z = 0; z < header.sz; z++) {
		z_index[z+1] += z_index[z];
	}

	uint64_t markov_model_offset = 0;
	if (header.markov_model_order > 0) {
		markov_model_offset = header.markov_model_bytes();
	}

	for (uint64_t i = 0; i < header.sz + 1; i++) {
		z_index[i] += (
			offset + header.grid_index_bytes() + 
			header.num_label_bytes + markov_model_offset
		);
	}
	return z_index;
}


std::vector<std::vector<unsigned char>> get_crack_codes(
	const CrackleHeader &header,
	const std::span<const unsigned char> &binary,
	const uint64_t z_start, const uint64_t z_end,
	int& err
) {
	std::vector<uint64_t> z_index = get_crack_code_offsets(header, binary, err);

	if (err > 0) {
		return std::vector<std::vector<unsigned char>>();
	}

	if (z_index.back() > binary.size()) {
		err = 30;
		return std::vector<std::vector<unsigned char>>();
	}

	std::vector<std::vector<unsigned char>> crack_codes(z_end - z_start);

	for (uint64_t z = z_start; z < z_end; z++) {
		uint64_t code_size = z_index[z+1] - z_index[z];
		std::vector<unsigned char> code;
		code.reserve(code_size);
		for (uint64_t i = z_index[z]; i < z_index[z+1]; i++) {
			code.push_back(binary[i]);
		}
		crack_codes[z - z_start] = std::move(code);
	}

	return crack_codes;
}


std::span<const uint32_t> get_crack_code_crcs(
	const CrackleHeader &header,
	const std::span<const unsigned char> &binary
) {
	// Compute the start of the uint32_t array
	const uint32_t* start = reinterpret_cast<const uint32_t*>(
		binary.data() + (binary.size() - header.sz * sizeof(uint32_t))
	);

	return std::span<const uint32_t>(start, header.sz);
}

std::vector<std::vector<uint8_t>> decode_markov_model(
	const CrackleHeader &header,
	const std::span<const unsigned char> &binary
) {
	if (header.markov_model_order == 0) {
		return std::vector<std::vector<uint8_t>>();
	}

	uint64_t model_offset = (
		header.header_bytes() 
		+ header.grid_index_bytes()
		+ header.num_label_bytes
	);

	std::vector<unsigned char> stored_model(
		binary.begin() + model_offset,
		binary.begin() + model_offset + header.markov_model_bytes()
	);
	return crackle::markov::from_stored_model(stored_model, header.markov_model_order);
}

std::vector<std::pair<uint64_t, std::vector<unsigned char>> >
crack_code_to_symbols(
  const std::span<const unsigned char>& code,
  const uint64_t sx, const uint64_t sy,
  const std::vector<std::vector<uint8_t>>& markov_model
) {
	std::vector<uint64_t> nodes = crackle::crackcodes::read_boc_index(code, sx, sy);

	std::vector<uint8_t> codepoints;
	if (markov_model.size() == 0) {
		return crackle::crackcodes::packed_codepoints_to_symbols(nodes, code, sx, sy);
	}
	else {
		uint32_t index_size = 4 + crackle::lib::ctoid(code, 0, 4);
		std::span<const uint8_t> markov_stream(code.data() + index_size, code.size() - index_size);
		codepoints = crackle::markov::decode_codepoints(markov_stream, markov_model);
		return crackle::crackcodes::codepoints_to_symbols(nodes, codepoints);
	}
}

// vcg: voxel connectivity graph
int crack_code_to_vcg(
  const std::span<const unsigned char>& code,
  const uint64_t sx, const uint64_t sy,
  const bool permissible, 
  const std::vector<std::vector<uint8_t>>& markov_model,
  uint8_t* vcg
) {
	auto symbol_stream = crack_code_to_symbols(code, sx, sy, markov_model);
	crackle::crackcodes::decode_crack_code(
		symbol_stream, sx, sy, permissible, vcg
	);
	return 0;
}

template <typename CCL>
int crack_codes_to_cc_labels(
  std::vector<unsigned char>& crack_codes,
  const uint64_t sx, const uint64_t sy,
  const bool permissible, uint64_t &N,
  const std::vector<std::vector<uint8_t>>& markov_model,
  std::vector<uint8_t>& vcg,
  CCL* out
) {
	int err = crack_code_to_vcg(
		crack_codes, sx, sy,
		permissible, markov_model,
		vcg.data()
	);

	if (err > 0) {
		return err;
	}

	crackle::cc3d::color_connectivity_graph<CCL>(
		vcg, sx, sy, 1, out, N
	);
	return 0;
}

template <typename LABEL>
std::vector<LABEL> decode_label_map(
	const CrackleHeader &header,
	const std::span<const unsigned char>& binary,
	const uint32_t* cc_labels,
	uint64_t N,
	int64_t z_start,
	int64_t z_end
) {
	if (header.is_signed) {
		if (header.stored_data_width == 1) {
			return crackle::labels::decode_label_map<LABEL, int8_t>(
				header, binary, cc_labels, N, z_start, z_end
			);
		}
		else if (header.stored_data_width == 2) {
			return crackle::labels::decode_label_map<LABEL, int16_t>(
				header, binary, cc_labels, N, z_start, z_end
			);
		}
		else if (header.stored_data_width == 4) {
			return crackle::labels::decode_label_map<LABEL, int32_t>(
				header, binary, cc_labels, N, z_start, z_end
			);
		}
		else {
			return crackle::labels::decode_label_map<LABEL, int64_t>(
				header, binary, cc_labels, N, z_start, z_end
			);
		}
	}
	else {
		if (header.stored_data_width == 1) {
			return crackle::labels::decode_label_map<LABEL, uint8_t>(
				header, binary, cc_labels, N, z_start, z_end
			);
		}
		else if (header.stored_data_width == 2) {
			return crackle::labels::decode_label_map<LABEL, uint16_t>(
				header, binary, cc_labels, N, z_start, z_end
			);
		}
		else if (header.stored_data_width == 4) {
			return crackle::labels::decode_label_map<LABEL, uint32_t>(
				header, binary, cc_labels, N, z_start, z_end
			);
		}
		else {
			return crackle::labels::decode_label_map<LABEL, uint64_t>(
				header, binary, cc_labels, N, z_start, z_end
			);
		}
	}
}

template <typename LABEL>
int decompress(
	const unsigned char* buffer, 
	const size_t num_bytes,
	LABEL* output,
	int64_t z_start = -1,
	int64_t z_end = -1
) {
	const CrackleHeader header(buffer);

	z_start = std::max(std::min(z_start, static_cast<int64_t>(header.sz - 1)), static_cast<int64_t>(0));
	z_end = z_end < 0 ? static_cast<int64_t>(header.sz) : z_end;
	z_end = std::max(std::min(z_end, static_cast<int64_t>(header.sz)), static_cast<int64_t>(0));

	if (z_start >= z_end) {
		return 10;
	}

	const int64_t szr = z_end - z_start;

	const uint64_t voxels = (
		static_cast<uint64_t>(header.sx) 
		* static_cast<uint64_t>(header.sy) 
		* static_cast<uint64_t>(szr)
	);

	if (voxels == 0) {
		return 0;
	}

	std::span<const unsigned char> binary(buffer, num_bytes);

	std::vector<std::vector<uint8_t>> markov_model = decode_markov_model(header, binary);

	int err = 0;
	auto crack_codes = get_crack_codes(header, binary, z_start, z_end, err);
	
	if (err > 0) {
		return err;
	}

	const uint64_t sxy = header.sx * header.sy;

	std::span<const uint32_t> crack_code_crcs;

	if (header.format_version > 0) {
		crack_code_crcs = get_crack_code_crcs(header, binary);
	}

	std::vector<uint8_t> vcg(sxy);
	std::vector<uint32_t> cc_labels(sxy);

	for (uint64_t z = 0; z < static_cast<uint64_t>(szr); z++) {
		uint64_t N = 0;
		err = crack_codes_to_cc_labels<uint32_t>(
			crack_codes[z],
			header.sx, header.sy,
			/*permissible=*/(header.crack_format == CrackFormat::PERMISSIBLE), 
			/*N=*/N,
			/*markov_model=*/markov_model,
			/*vcg=*/vcg,
			/*output=*/cc_labels.data()
		);

		if (err > 0) {
			return err;
		}

		if (header.format_version > 0) {
			const uint32_t computed_crc = crackle::crc::crc32c(cc_labels.data(), sxy);

			if (crack_code_crcs[z_start + z] != computed_crc) {
				return 12;
			}
		}

		const std::vector<LABEL> label_map = decode_label_map<LABEL>(
			header, binary, cc_labels.data(), N, z_start+z, z_start+z+1
		);

		// for neuroglancer, always decode into fortran order
		for (uint64_t i = 0; i < sxy; i++) {
			output[i + z * sxy] = label_map[cc_labels[i]];
		}
	}

	return 0;
}

int decompress(
	const unsigned char* buffer, 
	const size_t num_bytes,
	void* output,
	const uint64_t output_num_bytes
) {
	if (num_bytes < CrackleHeader::header_size_v1) {
		return 1;
	}

	if (!CrackleHeader::valid_header(buffer)) {
		return 2;
	}

	if (output == NULL) {
		return 3;
	}

	const CrackleHeader header(buffer);

	if (output_num_bytes < header.nbytes()) {
		return 4;
	}

	if (header.data_width == 1) {
		return decompress<uint8_t>(buffer, num_bytes, reinterpret_cast<uint8_t*>(output));
	}
	else if (header.data_width == 2) {
		return decompress<uint16_t>(buffer, num_bytes, reinterpret_cast<uint16_t*>(output));
	}
	else if (header.data_width == 4) {
		return decompress<uint32_t>(buffer, num_bytes, reinterpret_cast<uint32_t*>(output));
	}
	else {
		return decompress<uint64_t>(buffer, num_bytes, reinterpret_cast<uint64_t*>(output));
	}
} 


};

#endif