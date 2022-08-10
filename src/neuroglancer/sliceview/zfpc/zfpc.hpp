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
#include "zfp/bitstream.h"

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
T ctoi(const unsigned char* buf, uint64_t idx = 0);

template <>
uint64_t ctoi(const unsigned char* buf, uint64_t idx) {
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
uint32_t ctoi(const unsigned char* buf, uint64_t idx) {
	uint32_t x = 0;
	x += static_cast<uint32_t>(buf[idx + 0]) << 0;
	x += static_cast<uint32_t>(buf[idx + 1]) << 8;
	x += static_cast<uint32_t>(buf[idx + 2]) << 16;
	x += static_cast<uint32_t>(buf[idx + 3]) << 24;
	return x;
}

template <>
uint16_t ctoi(const unsigned char* buf, uint64_t idx) {
	uint16_t x = 0;
	x += static_cast<uint16_t>(buf[idx + 0]) << 0;
	x += static_cast<uint16_t>(buf[idx + 1]) << 8;
	return x;
}

template <>
uint8_t ctoi(const unsigned char* buf, uint64_t idx) {
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

	ZfpcHeader(const unsigned char* buf, const uint64_t buflen) {
		bool valid_magic = (buf[0] == 'z' && buf[1] == 'f' && buf[2] == 'p' && buf[3] == 'c');
		format_version = buf[4];

		data_type = ctoi<uint8_t>(buf, 5);
		nx = ctoi<uint32_t>(buf, 6); 
		ny = ctoi<uint32_t>(buf, 10); 
		nz = ctoi<uint32_t>(buf, 14);
		nw = ctoi<uint32_t>(buf, 18);
		correlated_dims = ctoi<uint8_t>(buf, 22);

		c_order = (data_type >> 7);
		mode = (data_type >> 3) & 0b111;
		data_type = data_type & 0b111;
	}

	uint64_t voxels() const {
		if (nx == 0 && ny == 0 && nz == 0 && nw == 0) {
			return 0;
		}

		return static_cast<uint64_t>(nx ? nx : 1) 
			* static_cast<uint64_t>(ny ? ny : 1) 
			* static_cast<uint64_t>(nz ? nz : 1) 
			* static_cast<uint64_t>(nw ? nw : 1);
	}

	uint64_t nbytes() const {
		uint64_t data_width = 1;
		if (data_type == 0) {
			data_width = 0;
		}
		else if (data_type == 1) {
			data_width = sizeof(int32_t);
		}
		else if (data_type == 2) {
			data_width = sizeof(int64_t);
		}
		else if (data_type == 3) {
			data_width = sizeof(float);
		}
		else if (data_type == 4) {
			data_width = sizeof(double);
		}

		return voxels() * data_width;
	}

	int64_t tochars(std::vector<unsigned char> &buf, uint64_t idx = 0) const {
		if ((idx + ZfpcHeader::header_size) > buf.size()) {
			return -1;
		}

		uint64_t i = idx;
		for (int j = 0; j < 4; j++, i++) {
			buf[i] = magic[j];
		}

		i += itoc(format_version, buf, i);
		i += itoc(
			static_cast<uint8_t>(data_type | ((mode << 3) & 0b111) | (c_order << 7)), 
			buf, i
		);
		i += itoc(nx, buf, i);
		i += itoc(ny, buf, i);
		i += itoc(nz, buf, i);
		i += itoc(nw, buf, i);
		i += itoc(correlated_dims, buf, i);

		return i - idx;
	}

	uint64_t num_streams() const {
		uint64_t shape[4] = { nx, ny, nz, nw };
		uint64_t nstreams = 1;
		// size 0 is treated as the dimension does not exist. Zeros should
		// only occur on the rhs.
		for (int i = 0; i < 4; i++) {
			if (shape[i] > 1 && ((correlated_dims >> i) & 0b1) == 0) {
				nstreams *= shape[i];
			}
		}
		return nstreams;
	}

	static bool valid(const unsigned char* buf, const uint64_t buflen) {
		if (buflen < header_size) {
			return false;
		}

		bool valid_magic = (buf[0] == 'z' && buf[1] == 'f' && buf[2] == 'p' && buf[3] == 'c');
		uint8_t format_version = buf[4];
		uint8_t dtype = ctoi<uint8_t>(buf, 5);
		uint8_t corr = ctoi<uint8_t>(buf, 22);

		// checks only unused bit and invalid data type value
		bool valid_dtype = (dtype & 0b01000000) == 0 && (dtype & 0b111) < 5;

		return valid_magic && (format_version == 0) && valid_dtype && (corr <= 0b1111);
	}

	static ZfpcHeader fromchars(unsigned char* buf, const uint64_t buflen) {
		return ZfpcHeader(buf, buflen);
	}
};

std::tuple<std::vector<uint64_t>, int> get_stream_offsets(
	const ZfpcHeader &header, 
	const unsigned char* buf, const uint64_t buflen
) {	
	uint64_t nstreams = header.num_streams();
	uint64_t index_offset = ZfpcHeader::header_size;

	int error = 0;

	// Buffer length too short for stream index
	if (buflen < index_offset + (1 + nstreams) * sizeof(uint64_t)) {
		error = 101;
	}

	uint64_t stream_offset = ctoi<uint64_t>(buf, index_offset);
	index_offset += sizeof(uint64_t);

	// invalid index
	if (buflen < stream_offset) {
		error = 102;
	}

	std::vector<uint64_t> stream_sizes(nstreams);
	for (uint64_t i = 0; i < nstreams; i++, index_offset += sizeof(uint64_t)) {
		stream_sizes[i] = ctoi<uint64_t>(buf, index_offset);
	}

	std::vector<uint64_t> stream_offsets(nstreams + 1);
	stream_offsets[0] = stream_offset;
	// Invalid stream index. Stream location outside of buffer
	if (stream_offsets[0] >= buflen) {
		error = 103;
	}

	for (uint64_t i = 1; i < nstreams + 1; i++) {
		stream_offsets[i] = stream_offsets[i-1] + stream_sizes[i-1];
		// Invalid stream index. Stream location outside of buffer
		if (stream_offsets[i] > buflen) {
			error = 104;
			break;
		}
	}

	return std::make_tuple(stream_offsets, error);
}

std::vector<std::vector<unsigned char>>
disassemble_container(
	const ZfpcHeader &header, 
	const unsigned char* buf, const uint64_t buflen,
	int &error
) {
	std::vector<uint64_t> stream_offsets;

	std::tie(stream_offsets, error) = get_stream_offsets(header, buf, buflen);
	
	const uint64_t nstreams = header.num_streams();
	std::vector<std::vector<unsigned char>> streams(nstreams);

	if (error > 0) {
		return streams;
	}

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
std::vector<T> decompress_zfp_stream(
	std::vector<unsigned char> &stream,
	uint64_t &nx, uint64_t &ny, uint64_t &nz, uint64_t &nw, 
	int &error
) {
	std::unique_ptr<zfp_field, void(*)(zfp_field*)> field(
		zfp_field_alloc(), zfp_field_free
	);
	std::unique_ptr<bitstream, void(*)(bitstream*)> bstream(
		stream_open(static_cast<void*>(stream.data()), stream.size()),
		stream_close
	);
	std::unique_ptr<zfp_stream, void(*)(zfp_stream*)> zstream(
		zfp_stream_open(bstream.get()),
		zfp_stream_close
	);
	zfp_stream_rewind(zstream.get());
	zfp_read_header(zstream.get(), field.get(), ZFP_HEADER_FULL);

	nx = static_cast<uint64_t>(field->nx);
	ny = static_cast<uint64_t>(field->ny);
	nz = static_cast<uint64_t>(field->nz);
	nw = static_cast<uint64_t>(field->nw);

	// invalid stream
	if (nx == 0 && ny == 0 && nz == 0 && nw == 0) {
		error = 301;
		return std::vector<T>(0);
	}

	// 0 is a special value that means the
	// dimension is not used, not that there
	// are no voxels.
	nx = nx ? nx : 1;
	ny = ny ? ny : 1;
	nz = nz ? nz : 1;
	nw = nw ? nw : 1;

	uint64_t voxels = nx * ny * nz * nw;
	
	std::vector<T> decompressed(voxels);

	zfp_field_set_pointer(field.get(), decompressed.data());
	size_t bytes_consumed = zfp_decompress(zstream.get(), field.get());

	// unable to decompress stream
	if (bytes_consumed == 0) {
		error = 302;
	}
	else if (bytes_consumed != stream.size()) {
		error = 303;
	}

	return decompressed;
}

template <typename T>
int decompress_helper(
	const ZfpcHeader &header,
	const unsigned char* inbuf, const uint64_t in_num_bytes,
	T* outbuf, const unsigned int out_num_bytes
) {
	if (header.nbytes() != out_num_bytes) {
		return 201;
	}

	int error = 0;
	std::vector<std::vector<unsigned char>> streams = std::move(
		disassemble_container(header, inbuf, in_num_bytes, error)
	);

	if (error) {
		return error;
	}

	uint64_t offset = 0;
	const uint64_t nstreams = streams.size();

	uint64_t nx = 1;
	uint64_t ny = 1;
	uint64_t nz = 1;
	uint64_t nw = 1;

	uint64_t o_i = 0;
	for (auto stream : streams) {
		std::vector<T> hyperplane = std::move(
			decompress_zfp_stream<T>(stream, nx, ny, nz, nw, error)
		);
		if (error) {
			return 202;
		}

		// read out while performing transposition from C to F order
		for (uint64_t x = 0; x < nx; x++) {
			for (uint64_t y = 0; y < ny; y++) {
				for (uint64_t z = 0; z < nz; z++) {
					for (uint64_t w = 0; w < nw; w++, o_i++) {
						outbuf[o_i] = hyperplane[
							x + nx * (y + ny * (z + nz * w))
						];
					}
				}
			}
		}
	}

	return 0;
}

int decompress(
	const unsigned char* inbuf, const uint64_t in_num_bytes,
	void* outbuf, const unsigned int out_num_bytes
) {
	if (!ZfpcHeader::valid(inbuf, in_num_bytes)) {
		return 1;
	}
	else if (out_num_bytes < 1) {
		return 2;
	}

	ZfpcHeader header(inbuf, in_num_bytes);

	// we don't yet support c order
	if (header.c_order) {
		return 3;
	}

	if (header.data_type == 0) {
		return 4; // data type none
	}
	else if (header.data_type == 1) {
		return decompress_helper<int32_t>(
			header, inbuf, in_num_bytes, 
			static_cast<int32_t*>(outbuf), out_num_bytes
		);
	}
	else if (header.data_type == 2) {
		return decompress_helper<int64_t>(
			header, inbuf, in_num_bytes, 
			static_cast<int64_t*>(outbuf), out_num_bytes
		);
	}
	else if (header.data_type == 3) {
		return decompress_helper<float>(
			header, inbuf, in_num_bytes, 
			static_cast<float*>(outbuf), out_num_bytes
		);
	}
	else if (header.data_type == 4) {
		return decompress_helper<double>(
			header, inbuf, in_num_bytes, 
			static_cast<double*>(outbuf), out_num_bytes
		);
	}

	return 5;
}

};

#endif