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

#ifndef __CRACKLE_HEADER_HXX__
#define __CRACKLE_HEADER_HXX__

#include "lib.hpp"
#include "crc.hpp"
#include <cstdint>
#include <span>
#include <vector>

namespace crackle {

enum LabelFormat {
	FLAT = 0,
	PINS_FIXED_WIDTH = 1,
	PINS_VARIABLE_WIDTH = 2
};

enum CrackFormat {
	IMPERMISSIBLE = 0,
	PERMISSIBLE = 1
};

/* Header: 
 *   'crkl'            : magic number (4 bytes)
 *   format version    : unsigned integer (1 byte) 
 *   format byte       : unsigned integer (1 byte) 
 *     bits 0-1: data width (2 ** dw == byte width)
 *     bits 2-3: storate data width (2 ** sdw == byte width)
 *     bit  4:   crack format (impermissible or permissible)
 *     bits 5-6: label format
 *   sx, sy, sz        : size of each dimension (4 bytes x3)
 *   num_label_bytes   : number of label format bytes (8 bytes)
 *   crc8
 */
struct CrackleHeader {
public:
	static constexpr size_t header_size{29};
	static constexpr size_t header_size_v0{24};
	static constexpr size_t header_size_v1{29};
	static constexpr uint8_t current_version{1}; 

	static constexpr char magic[4]{ 'c', 'r', 'k', 'l' }; 
	uint8_t format_version; 
	LabelFormat label_format;
	CrackFormat crack_format;
	bool is_signed;
	uint8_t data_width;
	uint8_t stored_data_width;
	uint32_t sx;
	uint32_t sy;
	uint32_t sz;
	uint32_t grid_size;
	uint64_t num_label_bytes;
	bool fortran_order;
	uint8_t markov_model_order;
	bool is_sorted;
	uint8_t crc;

	CrackleHeader() :
		format_version(1),
		label_format(LabelFormat::FLAT),
		crack_format(CrackFormat::IMPERMISSIBLE),
		is_signed(false),
		data_width(1), stored_data_width(1),
		sx(1), sy(1), sz(1), grid_size(2147483648),
		num_label_bytes(0), fortran_order(true),
		markov_model_order(0), is_sorted(1), crc(0xFF)
	{}

	CrackleHeader(
		const uint8_t _format_version, 
		const LabelFormat _label_fmt,
		const CrackFormat _crack_fmt,
		const bool _is_signed,
		const uint8_t _data_width,
		const uint8_t _stored_data_width,
		const uint32_t _sx, const uint32_t _sy, const uint32_t _sz,
		const uint32_t _grid_size,
		const uint32_t _num_label_bytes,
		const bool _fortran_order,
		const uint8_t _markov_model_order,
		const bool _is_sorted,
		const uint8_t _crc
	) : 
		format_version(_format_version),
		label_format(_label_fmt),
		crack_format(_crack_fmt),
		is_signed(_is_signed),
		data_width(_data_width), stored_data_width(_stored_data_width),
		sx(_sx), sy(_sy), sz(_sz),
		grid_size(_grid_size),
		num_label_bytes(_num_label_bytes), 
		fortran_order(_fortran_order), 
		markov_model_order(_markov_model_order),
		is_sorted(_is_sorted), crc(_crc)
	{}

	int assign_from_buffer(const unsigned char* buf) {
		bool valid_magic = (buf[0] == 'c' && buf[1] == 'r' && buf[2] == 'k' && buf[3] == 'l');
		format_version = buf[4];

		if (!valid_magic || format_version > 1) {
			return 70;
		}

		uint16_t format_bytes = lib::ctoi<uint16_t>(buf, 5);
		sx = lib::ctoi<uint32_t>(buf, 7); 
		sy = lib::ctoi<uint32_t>(buf, 11); 
		sz = lib::ctoi<uint32_t>(buf, 15);
		grid_size = static_cast<uint32_t>(
			pow(2, lib::ctoi<uint8_t>(buf, 19))
		);
		if (format_version == 0) {
			num_label_bytes = lib::ctoi<uint32_t>(buf, 20);
		}
		else {
			num_label_bytes = lib::ctoi<uint64_t>(buf, 20);
		}

		data_width = pow(2, (format_bytes & 0b00000011));
		stored_data_width = pow(2, (format_bytes & 0b00001100) >> 2);
		crack_format = static_cast<CrackFormat>((format_bytes & 0b00010000) >> 4);
		label_format = static_cast<LabelFormat>((format_bytes & 0b01100000) >> 5);
		fortran_order = static_cast<bool>((format_bytes & 0b10000000) >> 7);
		is_signed = static_cast<bool>((format_bytes >> 8) & 0b1);
		markov_model_order = static_cast<uint8_t>((format_bytes >> 9) & 0b1111);
		is_sorted = !static_cast<bool>((format_bytes >> 13) & 0b1);

		if (format_version == 0) {
			return 0; // no support for CRC
		}

		crc = lib::ctoi<uint8_t>(buf, 28);

		// calculate crc only on values that impact data interpretation
		// as lzip author Antonio Diaz Diaz noted, it's important to
		// deliver the message if possible even if the envelope is 
		// has a spot on it. for example, "crkl" magic word is human
		// correctable.

		// So compute starting from format bitfield to num_label_bytes.
		// We use CRC8 using a polynomial that is good up to 241 bits.
		// CRC8 is used to reduce false positives vs CRC32 since the
		// crc field can be damaged itself. 
		const uint8_t computed_crc = crackle::crc::crc8(buf + 5, 28 - 5);

		if (computed_crc != crc) {
			return 71;
		}

		return 0;
	}

	CrackleHeader(const unsigned char* buf) {
		assign_from_buffer(buf);
	}

	CrackleHeader(const std::string &buf) {
		assign_from_buffer(reinterpret_cast<const unsigned char*>(buf.c_str()));
	}

	CrackleHeader(const std::span<const unsigned char> &buf) {
		assign_from_buffer(buf.data());
	}

	CrackleHeader(const std::vector<unsigned char> &buf) {
		assign_from_buffer(buf.data());
	}

	uint64_t header_bytes() const {
		if (format_version == 0) {
			return header_size_v0;
		}
		else {
			return header_size;
		}
	}
	
	uint64_t grid_index_bytes() const {
		if (format_version == 0) {
			return sz * sizeof(uint32_t);
		}
		else {
			return (sz+1) * sizeof(uint32_t); // includes crc32c
		}		
	}

	uint64_t voxels() const {
		return static_cast<uint64_t>(sx) * static_cast<uint64_t>(sy) * static_cast<uint64_t>(sz);
	}

	int pin_index_width() const {
		return crackle::lib::compute_byte_width(sx * sy * sz);
	}

	int depth_width() const {
		return crackle::lib::compute_byte_width(sz == 0 ? 0 : sz - 1);	
	}

	uint64_t num_grids() const {
		uint64_t gsize = std::min(grid_size, std::max(sx, sy));
		uint64_t ngrids = ((sx + gsize - 1) / gsize) * ((sy + gsize - 1) / gsize);
		ngrids = std::max(ngrids, static_cast<uint64_t>(1));
		ngrids *= sz;
		return ngrids;
	}

	uint64_t nbytes() const {
		return (
			  static_cast<uint64_t>(sx) 
			* static_cast<uint64_t>(sy) 
			* static_cast<uint64_t>(sz) 
			* static_cast<uint64_t>(data_width)
		);
	}

	uint64_t markov_model_bytes() const {
		if (markov_model_order == 0) {
			return 0;
		}
		uint64_t model_size = pow(4, 
			std::min(
				static_cast<uint64_t>(markov_model_order), 
				static_cast<uint64_t>(15)
			)
		);
		// model is packed so only 5 bits are used
		// for each row. Round up.
		return ((model_size * 5) + 4) / 8;
	}

	static bool valid_header(const unsigned char* buf) {
		bool valid_magic = (buf[0] == 'c' && buf[1] == 'r' && buf[2] == 'k' && buf[3] == 'l');
		uint8_t format_version = buf[4];
		return valid_magic && (format_version <= CrackleHeader::current_version);
	}

	static CrackleHeader fromchars(unsigned char* buf) {
		return CrackleHeader(buf);
	}
};

	
};

#endif

