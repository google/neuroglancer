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

#ifndef __CRACKLE_PINS_HXX__
#define __CRACKLE_PINS_HXX__

#include <cstdint>
#include <unordered_set>

#include "cc3d.hpp"
#include "crc.hpp"
#include "lib.hpp"

namespace crackle {
namespace pins {

template <typename LABEL, typename INDEX, typename DEPTH>
struct Pin {
	LABEL label;
	INDEX index;
	DEPTH depth;

	Pin() {
		label = 0;
		index = 0;
		depth = 0;
	}

	Pin(LABEL _lbl, INDEX _idx, DEPTH _depth) 
		: label(_lbl), index(_idx), depth(_depth)
	{} 
	
	uint64_t decode_buffer(const unsigned char* buf, const uint64_t idx) {
		label = crackle::lib::ctoi<LABEL>(buf, idx);
		index = crackle::lib::ctoi<INDEX>(buf, idx + sizeof(LABEL));
		depth = crackle::lib::ctoi<DEPTH>(buf, idx + sizeof(LABEL) + sizeof(INDEX));
		return sizeof(LABEL) + sizeof(INDEX) + sizeof(DEPTH);
	}

	uint64_t dynamic_decode_buffer(
		const unsigned char* buf, const uint64_t idx,
		const uint64_t label_width, const uint64_t index_width, const uint64_t depth_width  
	) {
		label = crackle::lib::ctoid(buf, idx, label_width);
		index = crackle::lib::ctoid(buf, idx + label_width, index_width);
		depth = crackle::lib::ctoid(buf, idx + label_width + index_width, depth_width);
		return label_width + index_width + depth_width;
	}	
};

struct CandidatePin {
	uint32_t x;
	uint32_t y;
	uint32_t z_s;
	uint32_t z_e;
	std::unordered_set<uint32_t> ccids;

	CandidatePin() {
		x = 0;
		y = 0;
		z_s = 0;
		z_e = 0;
	}

	CandidatePin(
		const uint32_t _x,
		const uint32_t _y,
		const uint32_t _z_s,
		const uint32_t _z_e,
		const std::vector<uint32_t> &_ccids) 
		: x(_x), y(_y), z_s(_z_s), 
		  z_e(_z_e)
	{
		ccids.reserve(_ccids.size());
		ccids.insert(_ccids.begin(), _ccids.end());

	}

	uint64_t start_idx(uint64_t sx, uint64_t sy) const {
		return static_cast<uint64_t>(x) + sx * (static_cast<uint64_t>(y) + sy * static_cast<uint64_t>(z_s));
	}
	uint64_t depth() const {
		return static_cast<uint64_t>(z_e - z_s);
	}

	Pin<uint64_t,uint64_t,uint64_t> to_pin(
		const uint64_t label, const uint64_t sx, const uint64_t sy
	) const {
		return Pin<uint64_t,uint64_t,uint64_t>(
			label, start_idx(sx, sy), depth()
		);
	}
};

};
};

#endif