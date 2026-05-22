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

#ifndef __CRACKLE_LABELS_HXX__
#define __CRACKLE_LABELS_HXX__

#include <span>
#include <vector>

#include "crc.hpp"
#include "header.hpp"
#include "lib.hpp"
#include "pins.hpp"

namespace crackle {
namespace labels {

// For pin encodings only, extract the background color.
uint64_t background_color(std::span<unsigned char> binary) {
	crackle::CrackleHeader header(binary);
	uint64_t offset = header.header_bytes() + header.grid_index_bytes();
	return crackle::lib::ctoid(binary, offset, header.stored_data_width);
}

template <typename STORED_LABEL>
STORED_LABEL find_bgcolor(
	std::unordered_map<uint64_t, std::vector<crackle::pins::CandidatePin>>& all_pins,
	const int64_t sz
) {
	// find bg color, pick the most pins
	// first, and then the one with the most
	// pin depth (so less decoding work later)
	STORED_LABEL bgcolor = 0;
	uint64_t max_pins = 0;
	uint64_t max_pins_depth = sz;
	for (auto& [label, pins] : all_pins) {
		if (pins.size() > max_pins) {
			bgcolor = static_cast<STORED_LABEL>(label);
			max_pins = pins.size();
			max_pins_depth = 0;
			for (auto& pin : pins) {
				max_pins_depth += pin.depth();
			}
		} 
		else if (pins.size() == max_pins) {
			uint64_t candidate_max_depth = 0;
			for (auto& pin : pins) {
				candidate_max_depth += pin.depth();
			}
			if (candidate_max_depth > max_pins_depth) {
				bgcolor = static_cast<STORED_LABEL>(label);
				max_pins_depth = candidate_max_depth;
			}
		}
	}

	return bgcolor;
}

std::span<const unsigned char> raw_labels(
	const std::span<const unsigned char> &binary
) {
	crackle::CrackleHeader header(binary);
	return std::span<const unsigned char>(
		(binary.data() + header.header_bytes() + header.grid_index_bytes()),
		header.num_label_bytes
	);
}

uint64_t decode_num_labels(
	const CrackleHeader &header,
	const std::span<const unsigned char> &labels_binary
) {
	if (header.label_format == LabelFormat::FLAT) {
		return crackle::lib::ctoi<uint64_t>(labels_binary.data(), 0);
	}
	else {
		return crackle::lib::ctoi<uint64_t>(labels_binary.data(), header.stored_data_width);
	}
}

uint64_t num_labels(const std::span<const unsigned char> &binary) {
	const CrackleHeader header(binary);
	std::span<const unsigned char> labels_binary = raw_labels(binary);
	return decode_num_labels(header, labels_binary);
}

template <typename STORED_LABEL>
std::span<const STORED_LABEL> decode_uniq(
	const CrackleHeader &header,
	const std::span<const unsigned char> &labels_binary
) {
	const uint64_t num_labels = decode_num_labels(header, labels_binary);

	uint64_t idx = header.label_format == LabelFormat::FLAT
		? 8 // num labels
		: header.stored_data_width + 8; // bgcolor + numlabels for pins

    const unsigned char* buf = labels_binary.data();
	return std::span<const STORED_LABEL>(
		 reinterpret_cast<const STORED_LABEL*>(buf + idx),
		num_labels
	);
}

std::tuple<
	std::vector<uint64_t>,
	uint64_t,
	uint64_t
>
decode_components(
	const crackle::CrackleHeader &header,
	const unsigned char *buf,
	const uint64_t offset,
	const uint64_t num_grids, 
	const uint64_t component_width,
	const uint64_t z_start,
	const uint64_t z_end
) {
	std::vector<uint64_t> components(num_grids);
	for (uint64_t i = 0, j = offset; i < num_grids; i++, j += component_width) {
		components[i] = crackle::lib::ctoid(buf, j, component_width);
	}
	uint64_t component_left_offset = 0;
	uint64_t component_right_offset = 0;
	for (uint64_t z = 0; z < z_start; z++) {
		component_left_offset += components[z];
	}
	for (uint64_t z = header.sz - 1; z >= z_end; z--) {
		component_right_offset += components[z];
	}
	return std::make_tuple(components, component_left_offset, component_right_offset);
}

template <typename LABEL, typename STORED_LABEL>
std::vector<LABEL> decode_flat(
	const crackle::CrackleHeader &header,
	const std::span<const unsigned char> &binary,
	const uint64_t z_start, const uint64_t z_end
) {
	std::span<const unsigned char> labels_binary = raw_labels(binary);
	const unsigned char* buf = labels_binary.data();

	const uint64_t num_labels = decode_num_labels(header, labels_binary);
	std::span<const STORED_LABEL> uniq = decode_uniq<STORED_LABEL>(header, labels_binary);

	const int cc_label_width = crackle::lib::compute_byte_width(num_labels);

	const uint64_t num_grids = header.num_grids();
	uint64_t component_width = crackle::lib::compute_byte_width(header.sx * header.sy);

	uint64_t offset = 8 + sizeof(STORED_LABEL) * num_labels;
	auto [components, component_left_offset, component_right_offset] = decode_components(
		header, labels_binary.data(), offset, num_grids, component_width,
		z_start, z_end
	);
	offset += component_width * num_grids + component_left_offset * cc_label_width;
	uint64_t num_fields = (
		labels_binary.size() 
		- offset 
		- (component_right_offset * cc_label_width)
	) / cc_label_width;
	std::vector<LABEL> label_map(num_fields);

	for (uint64_t i = 0, j = offset; i < num_fields; i++, j += cc_label_width) {
		if (cc_label_width == 1) {
			label_map[i] = static_cast<LABEL>(
				uniq[crackle::lib::ctoi<uint8_t>(buf, j)]
			);
		}
		else if (cc_label_width == 2) {
			label_map[i] = static_cast<LABEL>(
				uniq[crackle::lib::ctoi<uint16_t>(buf, j)]
			);
		}
		else if (cc_label_width == 4) {
			label_map[i] = static_cast<LABEL>(
				uniq[crackle::lib::ctoi<uint32_t>(buf, j)]
			);
		}
		else {
			label_map[i] = static_cast<LABEL>(
				uniq[crackle::lib::ctoi<uint64_t>(buf, j)]
			);
		}
	}
	return label_map;
}

template <typename LABEL, typename STORED_LABEL>
std::vector<LABEL> decode_condensed_pins(
	const crackle::CrackleHeader &header,
	const std::span<const unsigned char> &binary,
	const uint32_t* cc_labels,
	const uint64_t N, 
	const uint64_t z_start, const uint64_t z_end
) {
	std::span<const unsigned char> labels_binary = raw_labels(binary);
	const LABEL bgcolor = static_cast<LABEL>(
		crackle::lib::ctoi<STORED_LABEL>(
			labels_binary.data(), 0
		)
	);
	std::span<const STORED_LABEL> uniq = decode_uniq<STORED_LABEL>(header, labels_binary);

	// bgcolor, num labels (u64), N labels, fmt depth num_pins, 
	// [num_pins][idx_1][depth_1]...[idx_n][depth_n][num_cc][cc_1][cc_2]...[cc_n]
	const uint64_t index_width = header.pin_index_width();
	const uint64_t component_width = crackle::lib::compute_byte_width(header.sx * header.sy);

	typedef crackle::pins::Pin<uint64_t, int64_t, int64_t> PinType;
	const unsigned char* buf = labels_binary.data();

	uint64_t offset = 8 + sizeof(STORED_LABEL) * (uniq.size() + 1);

	auto [components, component_left_offset, component_right_offset] = decode_components(
		header, labels_binary.data(), offset, header.num_grids(), component_width,
		z_start, z_end
	);

	uint64_t N_all = 0;
	for (uint64_t j = 0; j < components.size(); j++) {
		N_all += components[j];
	}

	component_right_offset = N_all - component_right_offset;
	offset += component_width * header.num_grids();

	uint8_t combined_width = crackle::lib::ctoi<uint8_t>(buf, offset);
	offset += 1;

	const uint8_t num_pins_width = pow(2, (combined_width & 0b11));
	const uint8_t depth_width = pow(2, (combined_width >> 2) & 0b11);
	const uint8_t cc_label_width = pow(2, (combined_width >> 4) & 0b11);

	std::vector<LABEL> label_map(N, bgcolor);

	std::vector<PinType> pins;
	
	for (uint64_t i = offset, label = 0; label < uniq.size(); label++) {
		if (i >= labels_binary.size()) {
			return label_map;
		}

		uint64_t num_pins = crackle::lib::ctoid(buf, i, num_pins_width);
		
		i += num_pins_width;
		for (uint64_t j = 0; j < num_pins; j++) {
			uint64_t index = crackle::lib::ctoid(buf, i + (j * index_width), index_width);
			uint64_t depth = crackle::lib::ctoid(buf, i + (num_pins * index_width) + (j * depth_width), depth_width);
			pins.emplace_back(label, index, depth);
		}
		if (num_pins > 1) {
			for (uint64_t j = pins.size() - (num_pins-1); j < pins.size(); j++) {
				pins[j].index += pins[j-1].index;
			}
		}
		i += num_pins * (index_width + depth_width);

		uint64_t num_cc_labels = crackle::lib::ctoid(buf, i, num_pins_width);
		i += num_pins_width;
		std::vector<uint32_t> cc_labels(num_cc_labels);
		for (uint64_t j = 0; j < num_cc_labels; j++) {
			cc_labels[j] = crackle::lib::ctoid(buf, i, cc_label_width);
			i += cc_label_width;
		}
		for (uint64_t j = 1; j < num_cc_labels; j++) {
			cc_labels[j] += cc_labels[j-1];
		}
		for (uint64_t j = 0; j < num_cc_labels; j++) {
			if (cc_labels[j] < component_left_offset || cc_labels[j] >= component_right_offset) {
				continue;
			}
			label_map[cc_labels[j] - component_left_offset] = uniq[label];
		}
	}

	const int64_t sx = header.sx;
	const int64_t sy = header.sy;
	const int64_t sxy = sx * sy;

	for (auto& pin : pins) {
		int64_t pin_z = pin.index / sxy;
		int64_t loc = pin.index - (pin_z * sxy);
		int64_t pin_z_start = std::max(pin_z, static_cast<int64_t>(z_start));
		int64_t pin_z_end = pin_z + pin.depth + 1;
		pin_z_end = std::min(pin_z_end, static_cast<int64_t>(z_end));

		pin_z_start -= static_cast<int64_t>(z_start);
		pin_z_end -= static_cast<int64_t>(z_start);

		for (int64_t z = pin_z_start; z < pin_z_end; z++) {
			auto cc_id = cc_labels[loc + sxy * z];
			label_map[cc_id] = uniq[pin.label];
		}
	}

	return label_map;
}

template <typename LABEL, typename STORED_LABEL>
std::vector<LABEL> decode_label_map(
	const crackle::CrackleHeader &header,
	const std::span<const unsigned char> &binary,
	const uint32_t* cc_labels,
	const uint64_t N,
	const uint64_t z_start, const uint64_t z_end
) {
	std::vector<LABEL> label_map;
	if (header.label_format == LabelFormat::FLAT) {
		return decode_flat<LABEL, STORED_LABEL>(header, binary, z_start, z_end);
	}
	else {		
		label_map = decode_condensed_pins<LABEL, STORED_LABEL>(
			header, binary, cc_labels, N, z_start, z_end
		);
	}

	return label_map;
}

};
};

#endif