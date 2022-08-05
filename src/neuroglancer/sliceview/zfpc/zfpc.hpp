/*
zfpc: zfp container

Optimally compressed partially corellated zfp streams container.

zfp doesn't optimally compress multi-channel data that
are not well correlated with each other. zfpc splits the
correlated data into different compressed streams and 
serializes the streams into a single file. You can then
treat the multiple compressed streams as a single compressed
file (including random access).

https://zfp.readthedocs.io/en/latest/faq.html#q-vfields

License: Apache
Author: William Silversmith
Affiliation: Princeton Neuroscience Institute
Date: July 2022
*/

#ifndef __ZFPC_HPP__
#define __ZFPC_HPP__

#include <cstdint>
#include <memory>
#include <tuple>
#include <vector>

#include "zfp.hpp"

namespace zfpc {

// little endian serialization of integers to chars
// returns bytes written
inline uint64_t itoc(uint8_t x, std::vector<unsigned char> &buf, uint64_t idx) {
	buf[idx] = x;
	return 1;
}

inline uint64_t itoc(uint16_t x, std::vector<unsigned char> &buf, uint64_t idx) {
	buf[idx + 0] = x & 0xFF;
	buf[idx + 1] = (x >> 8) & 0xFF;
	return 2;
}

inline uint64_t itoc(uint32_t x, std::vector<unsigned char> &buf, uint64_t idx) {
	buf[idx + 0] = x & 0xFF;
	buf[idx + 1] = (x >> 8) & 0xFF;
	buf[idx + 2] = (x >> 16) & 0xFF;
	buf[idx + 3] = (x >> 24) & 0xFF;
	return 4;
}

inline uint64_t itoc(uint64_t x, std::vector<unsigned char> &buf, uint64_t idx) {
	buf[idx + 0] = x & 0xFF;
	buf[idx + 1] = (x >> 8) & 0xFF;
	buf[idx + 2] = (x >> 16) & 0xFF;
	buf[idx + 3] = (x >> 24) & 0xFF;
	buf[idx + 4] = (x >> 32) & 0xFF;
	buf[idx + 5] = (x >> 40) & 0xFF;
	buf[idx + 6] = (x >> 48) & 0xFF;
	buf[idx + 7] = (x >> 56) & 0xFF;
	return 8;
}

template <typename T>
T ctoi(unsigned char* buf, uint64_t idx = 0);

template <>
uint64_t ctoi(unsigned char* buf, uint64_t idx) {
	uint64_t x = 0;
	x += static_cast<uint64_t>(buf[idx + 0]) << 0;
	x += static_cast<uint64_t>(buf[idx + 1]) << 8;
	x += static_cast<uint64_t>(buf[idx + 2]) << 16;
	x += static_cast<uint64_t>(buf[idx + 3]) << 24;
	x += static_cast<uint64_t>(buf[idx + 4]) << 32;
	x += static_cast<uint64_t>(buf[idx + 5]) << 40;
	x += static_cast<uint64_t>(buf[idx + 6]) << 48;
	x += static_cast<uint64_t>(buf[idx + 7]) << 56;
	return x;
}

template <>
uint32_t ctoi(unsigned char* buf, uint64_t idx) {
	uint32_t x = 0;
	x += static_cast<uint32_t>(buf[idx + 0]) << 0;
	x += static_cast<uint32_t>(buf[idx + 1]) << 8;
	x += static_cast<uint32_t>(buf[idx + 2]) << 16;
	x += static_cast<uint32_t>(buf[idx + 3]) << 24;
	return x;
}

template <>
uint16_t ctoi(unsigned char* buf, uint64_t idx) {
	uint16_t x = 0;
	x += static_cast<uint16_t>(buf[idx + 0]) << 0;
	x += static_cast<uint16_t>(buf[idx + 1]) << 8;
	return x;
}

template <>
uint8_t ctoi(unsigned char* buf, uint64_t idx) {
	return static_cast<uint8_t>(buf[idx]);
}


/* Header: 
 *   'zfpc'            : magic number (4 bytes)
 *   format version    : unsigned integer (1 byte) 
 *   data type        : unsigned integer (1 byte)
 *   nx, ny, nz, nw   : size of each dimension (2 bytes x4)
 *   correlated_dims  : bitfield (least significant 4 bits (nibble)) (1 byte)
 */
struct ZfpcHeader {
public:
	static constexpr uint64_t header_size{23};

	static constexpr char magic[4]{ 'z', 'f', 'p', 'c' }; 
	uint8_t format_version; 
	uint8_t data_type; // bits DDDMMMUC: 1-3: dtype 4-6: mode 7: unused 8: c-order
	uint8_t mode;
	bool c_order;
	uint32_t nx;
	uint32_t ny;
	uint32_t nz;
	uint32_t nw;
	uint8_t correlated_dims;

	ZfpcHeader() :
		format_version(0), data_type(0), 
		nx(1), ny(1), nz(1), nw(1),
		correlated_dims(0b1111), c_order(false)
	{}

	ZfpcHeader(
		const uint8_t _format_version, 
		const uint8_t _data_type,
		const uint8_t _mode,
		const uint32_t _nx, const uint32_t _ny, 
		const uint32_t _nz, const uint32_t _nw,
		const uint8_t _correlated_dims,
		const bool _c_order
	) : 
		format_version(_format_version), 
		data_type(_data_type), mode(_mode),
		nx(_nx), ny(_ny), nz(_nz), nw(_nw),
		correlated_dims(_correlated_dims),
		c_order(_c_order)
	{}

	ZfpcHeader(unsigned char* buf, const uint64_t buflen) {
		if (buflen < header_size) {
			throw std::runtime_error("zfpc: Data stream is not valid. Too short, unable to decompress.");
		}

		bool valid_magic = (buf[0] == 'z' && buf[1] == 'f' && buf[2] == 'p' && buf[3] == 'c');
		format_version = buf[4];

		if (!valid_magic || format_version > 0) {
			throw std::runtime_error("zfpc: Data stream is not valid. Unable to decompress.");
		}

		data_type = ctoi<uint8_t>(buf, 5);
		nx = ctoi<uint32_t>(buf, 6); 
		ny = ctoi<uint32_t>(buf, 8); 
		nz = ctoi<uint32_t>(buf, 10);
		nw = ctoi<uint32_t>(buf, 12);
		correlated_dims = ctoi<uint8_t>(buf, 14);

		c_order = (data_type >> 7);
		mode = (data_type >> 3) & 0b111;
		data_type = data_type & 0b111;
		
		if (data_type > 4) {
			std::string err = "zfpc: Invalid data type in stream. Unable to decompress. Got: ";
			err += std::to_string(data_width);
			throw std::runtime_error(err);
		}
	}

	uint64_t voxels() {
		return static_cast<uint64_t>(nx) 
			* static_cast<uint64_t>(ny) 
			* static_cast<uint64_t>(nz) 
			* static_cast<uint64_t>(nw);
	}

	uint64_t tochars(std::vector<unsigned char> &buf, uint64_t idx = 0) const {
		if ((idx + CompressoHeader::header_size) > buf.size()) {
			throw std::runtime_error("zfpc: Unable to write past end of buffer.");
		}

		uint64_t i = idx;
		for (int j = 0; j < 4; j++, i++) {
			buf[i] = magic[j];
		}

		i += itoc(format_version, buf, i);
		i += itoc(data_type | ((mode << 3) & 0b111) | (c_order << 7), buf, i);
		i += itoc(nx, buf, i);
		i += itoc(ny, buf, i);
		i += itoc(nz, buf, i);
		i += itoc(nw, buf, i);
		i += itoc(correlated_dims, buf, i);

		return i - idx;
	}

	uint64_t get_num_streams() {
		uint64_t shape[4] = { nx, ny, nz, nw };
		uint64_t num_streams = 1;
		// size 0 is treated as the dimension does not exist. Zeros should
		// only occur on the rhs.
		for (int i = 0; i < 4; i++) {
			if (shape[i] > 1 && ((correlated_dims >> i) & 0b1) == 0) {
				num_streams *= shape[i];
			}
		}
		return num_streams;
	}

	static bool valid_header(unsigned char* buf, const uint64_t buflen) {
		if (buflen < header_size) {
			return false;
		}

		bool valid_magic = (buf[0] == 'z' && buf[1] == 'f' && buf[2] == 'p' && buf[3] == 'c');
		uint8_t format_version = buf[4];
		uint8_t dtype = ctoi<uint8_t>(buf, 5);
		uint8_t corr = ctoi<uint8_t>(buf, 22);

		// checks only unused bit and invalid data type value
		bool valid_dtype = (dtype & 0b00000010) == 0 && (dtype & 0b111) < 5;

		return valid_magic && (format_version == 0) && valid_dtype && (corr <= 0b1111);
	}

	static ZfpcHeader fromchars(unsigned char* buf, const uint64_t buflen) {
		return ZfpcHeader(buf, buflen);
	}
};

std::vector<uint64_t> get_stream_offsets(const unsigned char* buf, const uint64_t buflen) const {
	ZfpcHeader header(buf, buflen);
	
	uint64_t nstreams = header.num_streams();
	uint64_t index_offset = ZfpcHeader::header_size;

	if (buflen < index_offset + (1 + nstreams) * sizeof(uint64_t)) {
		throw std::runtime_error("zfpc: Buffer length too short for stream index.");
	}

	uint64_t stream_offset = ctoi<uint64_t>(buf, index_offset);
	index_offset += sizeof(uint64_t);

	if (buflen < stream_offset) {
		throw std::runtime_error("zfpc: Index invalid.");
	}

	std::vector<uint64_t> stream_sizes(nstreams);
	for (uint64_t i = 0; i < nstreams; i++, index_offset += sizeof(uint64_t)) {
		stream_sizes[i] = ctoi<uint64_t>(buf, index_offset);
	}

	std::vector<uint64_t> stream_offsets(nstreams + 1);
	stream_offsets[0] = stream_offset;
	if (stream_offsets[0] >= buflen) {
		throw std::runtime_error("zfpc: Invalid stream index. Stream location outside of buffer.");
	}

	for (uint64_t i = 1; i < nstreams + 1; i++) {
		stream_offsets[i] = stream_offsets[i-1] + stream_sizes[i-1];
		if (stream_offsets[i] >= buflen) {
			throw std::runtime_error("zfpc: Invalid stream index. Stream location outside of buffer.");
		}
	}

	return stream_offsets;
}

std::vector<std::vector<unsigned char>> disassemble_container(
	const ZfpcHeader &header, 
	const unsigned char* buf, const uint64_t buflen
) {
	std::vector<uint64_t> stream_offsets = get_stream_offsets(buf, buflen);
	
	const uint64_t nstreams = header.num_streams();
	std::vector<std::vector<unsigned char>> streams(nstreams);

	for (uint64_t i = 0; i < nstreams; i++) {
		const uint64_t stream_nbytes = stream_offsets[i+1] - stream_offsets[i];
		streams[i].resize(stream_nbytes);
		for (uint64_t j = 0; j < stream_nbytes; j++) {
			streams[i][j] = buf[stream_offsets[i] + j]; 
		}
	}

	return streams;
}

template <typename T>
std::vector<T> decompress_zfp_stream(const std::vector<unsigned char> &stream) {
	zfp_field* field = zfp_field_alloc();
	bitstream* bstream = stream_open(stream.data(), stream.size());
	zfp_stream* stream = zfp_stream_open(bstream);
	zfp_read_header(stream, field, ZFP_HEADER_FULL);
	zfp_stream_rewind(stream);

	size_t voxels = 
		  static_cast<uint64_t>(field->nx) 
		* static_cast<uint64_t>(field->ny) 
		* static_cast<uint64_t>(field->nz) 
		* static_cast<uint64_t>(field->nw);

	std::vector<T> decompressed(voxels);

	zfp_field_set_pointer(field, decompressed.data());
	auto bytes_consumed = zfp_decompress(stream, field);
	if (bytes_consumed == 0) {
		throw new std::runtime_error("zfpc: unable to decompress stream.");
	}

	zfp_field_free(field);
	zfp_stream_close(stream);
	stream_close(bstream);

	return decompressed;
}

template <typename T>
std::vector<T> decompress(const unsigned char* buf, const uint64_t buflen) {
	ZfpcHeader header(buf, buflen);
	std::vector<std::vector<unsigned char>> streams = std::move(
		disassemble_container(header, buf, buflen)
	);

	std::vector<T> recovered(header.voxels());

	if (header.c_order) {
		throw new std::runtime_error("c order decompression not yet supported.");
	}

	uint64_t out_i = 0;
	for (auto stream : streams) {
		std::vector<T> hyperplane = std::move(decompress_zfp_stream(stream));
		for (uint64_t i = 0; i < voxels; i++, out_i++) {
			recovered[out_i] = hyperplane[i];
		}
	}

	return recovered;
}

};

#endif