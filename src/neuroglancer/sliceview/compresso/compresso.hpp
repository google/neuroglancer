/* This is an implementation of the Compresso
 * segmentation compression codec. This 
 * is a heavily modified form of the code 
 * originally written by Brian Matejek. 
 *
 * The stream written by this library is not
 * compatible with the original version. It
 * includes some byte width optimizations 
 * and additional header fields in the output
 * and various functions have been somewhat
 * tuned for speed. It also has a modified 
 * indeterminate locations algorithm to accomodate
 * any possible input.
 *
 * You can find the Compresso paper here:
 * https://vcg.seas.harvard.edu/publications/compresso-efficient-compression-of-segmentation-data-for-connectomics
 *
 * You can find the original code here:
 * https://github.com/VCG/compresso/blob/8378346c9a189a48bf9054c5296ceeb7139634c5/experiments/compression/compresso/cpp-compresso.cpp
 *
 * William Silversmith 
 * Princeton University
 * June 7, 2021
 */

#ifndef __COMPRESSO_HXX__
#define __COMPRESSO_HXX__

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <set>
#include <string>
#include <vector>

#include "cc3d.hpp"

namespace compresso {

#define DEFAULT_CONNECTIVITY 4

template <typename T>
T ctoi(unsigned char* buf, size_t idx = 0);

template <>
uint64_t ctoi(unsigned char* buf, size_t idx) {
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
uint32_t ctoi(unsigned char* buf, size_t idx) {
	uint32_t x = 0;
	x += static_cast<uint32_t>(buf[idx + 0]) << 0;
	x += static_cast<uint32_t>(buf[idx + 1]) << 8;
	x += static_cast<uint32_t>(buf[idx + 2]) << 16;
	x += static_cast<uint32_t>(buf[idx + 3]) << 24;
	return x;
}

template <>
uint16_t ctoi(unsigned char* buf, size_t idx) {
	uint16_t x = 0;
	x += static_cast<uint16_t>(buf[idx + 0]) << 0;
	x += static_cast<uint16_t>(buf[idx + 1]) << 8;
	return x;
}

template <>
uint8_t ctoi(unsigned char* buf, size_t idx) {
	return static_cast<uint8_t>(buf[idx]);
}


/* Header: 
 *   'cpso'            : magic number (4 bytes)
 *   format version    : unsigned integer (1 byte) 
 *   data width        : unsigned integer (1 byte) (1: uint8, ... 8: uint64)
 *   sx, sy, sz        : size of each dimension (2 bytes x3)
 *   xstep,ystep,zstep : size of each grid (1 byte x 3) (typical values: 4, 8)
 *   id_size          : number of uniq labels (u64) (could be one per voxel)
 *   value_size       : number of values (u32)
 *   location_size    : number of locations (u64)
 *   connectivity     : CCL algorithm 4 or 6
 */
struct CompressoHeader {
public:
	static constexpr size_t header_size{36};

	static constexpr char magic[4]{ 'c', 'p', 's', 'o' }; 
	static constexpr uint8_t format_version{0};
	uint8_t data_width; // label width in bits
	uint16_t sx;
	uint16_t sy;
	uint16_t sz;
	uint8_t xstep; // 4 bits each to x and y (we only use 4 and 8 anyway)
	uint8_t ystep; // 4 bits each to x and y (we only use 4 and 8 anyway)
	uint8_t zstep; // 4 bits each to x and y (we only use 4 and 8 anyway)
	uint64_t id_size; // label per connected component 
	uint32_t value_size; // boundary encodings (less than size / 16 or size / 64)
	uint64_t location_size; // instructions to remap boundaries
	uint8_t connectivity; // 4 or 6 connected CLL algorithm (almost always 4)

	CompressoHeader() :
		data_width(8), 
		sx(1), sy(1), sz(1), 
		xstep(8), ystep(8), zstep(1),
		id_size(0), value_size(0), location_size(0),
		connectivity(4)
	{}

	CompressoHeader(
		const uint8_t _data_width,
		const uint16_t _sx, const uint16_t _sy, const uint16_t _sz,
		const uint8_t _xstep = 4, const uint8_t _ystep = 4, const uint8_t _zstep = 1,
		const uint64_t _id_size = 0, const uint32_t _value_size = 0, 
		const uint64_t _location_size = 0, const uint8_t _connectivity = 4
	) : 
		data_width(_data_width), 
		sx(_sx), sy(_sy), sz(_sz), 
		xstep(_xstep), ystep(_ystep), zstep(_zstep),
		id_size(_id_size), value_size(_value_size), location_size(_location_size),
		connectivity(_connectivity)
	{}

	CompressoHeader(unsigned char* buf) {
		data_width = ctoi<uint8_t>(buf, 5);
		sx = ctoi<uint16_t>(buf, 6); 
		sy = ctoi<uint16_t>(buf, 8); 
		sz = ctoi<uint16_t>(buf, 10);
		xstep = ctoi<uint8_t>(buf, 12); 
		ystep = ctoi<uint8_t>(buf, 13);
		zstep = ctoi<uint8_t>(buf, 14);
		id_size = ctoi<uint64_t>(buf, 15);
		value_size = ctoi<uint32_t>(buf, 23);
		location_size = ctoi<uint64_t>(buf, 27);
		connectivity = ctoi<uint8_t>(buf, 35);
	}

	static bool valid_header(unsigned char* buf) {
		bool valid_magic = (buf[0] == 'c' && buf[1] == 'p' && buf[2] == 's' && buf[3] == 'o');
		uint8_t format_version = buf[4];
		uint8_t dwidth = ctoi<uint8_t>(buf, 5);
		uint8_t connect = ctoi<uint8_t>(buf, 35);

		bool valid_dtype = (dwidth == 1 || dwidth == 2 || dwidth == 4 || dwidth == 8);
		bool valid_connectivity = (connect == 4 || connect == 6);

		return valid_magic && (format_version == 0) && valid_dtype && valid_connectivity;
	}

	static CompressoHeader fromchars(unsigned char* buf) {
		return CompressoHeader(buf);
	}
};

template <typename WINDOW>
std::vector<WINDOW> run_length_decode_windows(
	const std::vector<WINDOW> &rle_windows, const size_t nblocks
) {
	std::vector<WINDOW> windows(nblocks);

	WINDOW block = 0;
	size_t index = 0;
	const size_t window_size = rle_windows.size();

	for (size_t i = 0; i < window_size; i++) {
		block = rle_windows[i];
		if (block & 1) {
			index += (block >> 1);
		}
		else {
			windows[index] = block >> 1;
			index++;
		}
	}

	return windows;
}

/* DECOMPRESS STARTS HERE */

template <typename LABEL, typename WINDOW>
std::unique_ptr<bool[]> decode_boundaries(
	const std::vector<WINDOW> &windows, const std::vector<WINDOW> &window_values, 
	const size_t sx, const size_t sy, const size_t sz,
	const size_t xstep, const size_t ystep, const size_t zstep
) {

	const size_t sxy = sx * sy;
	const size_t voxels = sx * sy * sz;

	const size_t nx = (sx + xstep - 1) / xstep; // round up
	const size_t ny = (sy + ystep - 1) / ystep; // round up

	// check for power of two
	const bool xstep_pot = (xstep != 0) && ((xstep & (xstep - 1)) == 0);
	const int xshift = std::log2(xstep); // must use log2 here, not lg/lg2 to avoid fp errors

	std::unique_ptr<bool[]> boundaries(new bool[voxels]());

	if (window_values.size() == 0) {
		return boundaries;
	}

	size_t xblock, yblock, zblock;
	size_t xoffset, yoffset, zoffset;

	for (size_t z = 0; z < sz; z++) {
		zblock = nx * ny * (z / zstep);
		zoffset = xstep * ystep * (z % zstep);
		for (size_t y = 0; y < sy; y++) {
			yblock = nx * (y / ystep);
			yoffset = xstep * (y % ystep);

			if (xstep_pot) {
				for (size_t x = 0; x < sx; x++) {
					size_t iv = x + sx * y + sxy * z;

					xblock = x >> xshift; // x / xstep
					xoffset = x & ((1 << xshift) - 1); // x % xstep
					
					size_t block = xblock + yblock + zblock;
					size_t offset = xoffset + yoffset + zoffset;

					WINDOW value = window_values[windows[block]];
					boundaries[iv] = (value >> offset) & 0b1;
				}				
			}
			else {
				for (size_t x = 0; x < sx; x++) {
					size_t iv = x + sx * y + sxy * z;
					xblock = x / xstep;
					xoffset = x % xstep;
					
					size_t block = xblock + yblock + zblock;
					size_t offset = xoffset + yoffset + zoffset;

					WINDOW value = window_values[windows[block]];
					boundaries[iv] = (value >> offset) & 0b1;
				}
			}
		}
	}

	return boundaries;
}

template <typename LABEL>
void decode_nonboundary_labels(
	std::unique_ptr<uint32_t[]> &components, const std::vector<LABEL> &ids, 
	const size_t sx, const size_t sy, const size_t sz,
	LABEL* output
) {
	const size_t voxels = sx * sy * sz;
	for (size_t i = 0; i < voxels; i++) {
		output[i] = ids[components[i]];
	}
}

template <typename LABEL>
int decode_indeterminate_locations(
	std::unique_ptr<bool[]> &boundaries, LABEL *labels, 
	const std::vector<LABEL> &locations, 
	const size_t sx, const size_t sy, const size_t sz,
	const size_t connectivity
) {
	const size_t sxy = sx * sy;

	size_t loc = 0;
	size_t index = 0;

	// go through all coordinates
	for (size_t z = 0; z < sz; z++) {
		for (size_t y = 0; y < sy; y++) {
			for (size_t x = 0; x < sx; x++) {
				loc = x + sx * y + sxy * z;

				if (!boundaries[loc]) {
					continue;
				}
				else if (x > 0 && !boundaries[loc - 1]) {
					labels[loc] = labels[loc - 1];
					continue;
				}
				else if (y > 0 && !boundaries[loc - sx]) {
					labels[loc] = labels[loc - sx];
					continue;
				}
				else if (connectivity == 6 && z > 0 && !boundaries[loc - sxy]) {
					labels[loc] = labels[loc - sxy];
					continue;
				}
				else if (locations.size() == 0) {
					return 1;
				}
				
				size_t offset = locations[index];

				if (offset == 0) {
					if (x == 0) {
						return 2;
					}
					labels[loc] = labels[loc - 1];
				}
				else if (offset == 1) {
					if (x >= sx - 1) {
						return 3;
					}
					labels[loc] = labels[loc + 1];
				}
				else if (offset == 2) {
					if (y == 0) {
						return 4;
					}
					labels[loc] = labels[loc - sx];
				}
				else if (offset == 3) {
					if (y >= sy - 1) {
						return 5;
					}
					labels[loc] = labels[loc + sx];
				}
				else if (offset == 4) {
					if (z == 0) {
						return 6;
					}
					labels[loc] = labels[loc - sxy];
				}
				else if (offset == 5) {
					if (z >= sz - 1) {
						return 7;
					}
					labels[loc] = labels[loc + sxy];
				}
				else if (offset == 6) {
					labels[loc] = locations[index + 1];
					index++;
				}
				else {
					labels[loc] = offset - 7;
				}
				index++;
			}
		}
	}

	return 0;
}

template <typename LABEL, typename WINDOW>
int decompress(unsigned char* buffer, size_t num_bytes, LABEL* output) {
	if (output == NULL) {
		return 8;
	}
	else if (num_bytes < CompressoHeader::header_size) {
		return 9;
	}
	else if (!CompressoHeader::valid_header(buffer)) {
		return 10;
	}

	const CompressoHeader header(buffer);

	const size_t sx = header.sx;
	const size_t sy = header.sy;
	const size_t sz = header.sz;
	const size_t voxels = sx * sy * sz;
	const size_t xstep = header.xstep;
	const size_t ystep = header.ystep;
	const size_t zstep = header.zstep;

	if (sx * sy * sz == 0) {
		return 11;
	}

	const size_t nx = (sx + xstep - 1) / xstep; // round up
	const size_t ny = (sy + ystep - 1) / ystep; // round up
	const size_t nz = (sz + zstep - 1) / zstep; // round up
	const size_t nblocks = nz * ny * nx;

	size_t window_bytes = (
		num_bytes 
			- CompressoHeader::header_size
			- (header.id_size * sizeof(LABEL))  
			- (header.value_size * sizeof(WINDOW))
			- (header.location_size * sizeof(LABEL))
	);
	size_t num_condensed_windows = window_bytes / sizeof(WINDOW);

	// allocate memory for all arrays
	std::vector<LABEL> ids(header.id_size + 1); // +1 to allow vectorized mapping w/ no if statement guarding zero
	std::vector<WINDOW> window_values(header.value_size);
	std::vector<LABEL> locations(header.location_size);
	std::vector<WINDOW> windows(num_condensed_windows);

	size_t iv = CompressoHeader::header_size;
	for (size_t ix = 0; ix < ids.size() - 1; ix++, iv += sizeof(LABEL)) {
		ids[ix + 1] = ctoi<LABEL>(buffer, iv);
	}
	for (size_t ix = 0; ix < window_values.size(); ix++, iv += sizeof(WINDOW)) {
		window_values[ix] = ctoi<WINDOW>(buffer, iv);
	}
	for (size_t ix = 0; ix < locations.size(); ix++, iv += sizeof(LABEL)) {
		locations[ix] = ctoi<LABEL>(buffer, iv);
	}
	for (size_t ix = 0; ix < num_condensed_windows; ix++, iv += sizeof(WINDOW)) {
		windows[ix] = ctoi<WINDOW>(buffer, iv);
	}

	windows = run_length_decode_windows<WINDOW>(windows, nblocks);

	std::unique_ptr<bool[]> boundaries = decode_boundaries<WINDOW>(
		windows, window_values, 
		sx, sy, sz, 
		xstep, ystep, zstep
	);
	windows = std::vector<WINDOW>();
	window_values = std::vector<WINDOW>();

	std::unique_ptr<uint32_t[]> components = cc3d::connected_components<uint32_t>(
		boundaries.get(), sx, sy, sz, header.connectivity
	);

	decode_nonboundary_labels(components, ids, sx, sy, sz, output);
	components.reset();
	ids = std::vector<LABEL>();

	int err = decode_indeterminate_locations<LABEL>(
		boundaries, output, locations, 
		sx, sy, sz,
		header.connectivity
	);

	// if err is 0, everything was ok
	return err;
}

// This function is used to produce the cartesian
// product of LABEL x WINDOW possibilities and reduce
// the human edited code down from 16 conditions down to
// 8.
template <typename WINDOW>
int decompress_helper(
	unsigned char* buffer, size_t num_bytes, 
	void* output, const CompressoHeader &header
) {
	if (header.data_width == 1) {
		return decompress<uint8_t,WINDOW>(
			buffer, num_bytes, reinterpret_cast<uint8_t*>(output)
		);
	}
	else if (header.data_width == 2) {
		return decompress<uint16_t,WINDOW>(
			buffer, num_bytes, reinterpret_cast<uint16_t*>(output)
		);
	}
	else if (header.data_width == 4) {
		return decompress<uint32_t,WINDOW>(
			buffer, num_bytes, reinterpret_cast<uint32_t*>(output)
		);
	}
	else if (header.data_width == 8) {
		return decompress<uint64_t,WINDOW>(
			buffer, num_bytes, reinterpret_cast<uint64_t*>(output)
		);
	}
	else {
		return 13;
	}
}


template <>
int decompress<void,void>(unsigned char* buffer, size_t num_bytes, void* output) {
	if (!CompressoHeader::valid_header(buffer)) {
		return 12;
	}

	CompressoHeader header(buffer);

	bool window8 = (
		static_cast<int>(header.xstep) * static_cast<int>(header.ystep) * static_cast<int>(header.zstep) <= 8
	);
	bool window16 = (
		static_cast<int>(header.xstep) * static_cast<int>(header.ystep) * static_cast<int>(header.zstep) <= 16
	);
	bool window32 = (
		static_cast<int>(header.xstep) * static_cast<int>(header.ystep) * static_cast<int>(header.zstep) <= 32
	);

	if (window8) {
		return decompress_helper<uint8_t>(
			buffer, num_bytes, 
			reinterpret_cast<uint8_t*>(output),
			header
		);
	}
	else if (window16) {
		return decompress_helper<uint16_t>(
			buffer, num_bytes, 
			reinterpret_cast<uint8_t*>(output),
			header
		);
	}
	else if (window32) {
		return decompress_helper<uint32_t>(
			buffer, num_bytes, 
			reinterpret_cast<uint8_t*>(output),
			header
		);
	}
	else {
		return decompress_helper<uint64_t>(
			buffer, num_bytes, 
			reinterpret_cast<uint8_t*>(output),
			header
		);	
	}
}

};

#endif