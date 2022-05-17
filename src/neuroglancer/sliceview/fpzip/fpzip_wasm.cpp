/**
 * @license
 * Copyright 2022 William Silvermsith
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

#include "fpzip.h"
#include <memory.h>

class Fpzip {
public:
  unsigned int type;
  unsigned int prec;
  size_t nx;
  size_t ny;
  size_t nz;
  size_t nf;

  Fpzip () {
		type = 0;
		prec = 0;
		nx = 0;
		ny = 0;
		nz = 0;
		nf = 0;
  }

  Fpzip (unsigned char* buf) {
		type = 0;
		prec = 0;
		nx = 0;
		ny = 0;
		nz = 0;
		nf = 0;

		decode_headers(buf);
  }

  Fpzip(Fpzip &orig) {
		type = orig.type;
		prec = orig.prec;
		nx = orig.nx;
		ny = orig.ny;
		nz = orig.nz;
		nf = orig.nf;
  }

  ~Fpzip() {
  
  }

  size_t nvoxels() {
	return nx * ny * nz * nf;
  }

  size_t nbytes() {
	// type: 0 = float, 1 = double
	return nvoxels() * (type + 1) * sizeof(float);
  }

  size_t get_type() { return type; }
  size_t get_prec() { return prec; }
  size_t get_nx() { return nx; }
  size_t get_ny() { return ny; }
  size_t get_nz() { return nz; }
  size_t get_nf() { return nf; }

  void decode_headers(unsigned char *data) {
		// char errorstr[128];

		FPZ* fpz = fpzip_read_from_buffer(static_cast<void*>(data));
		if (!fpzip_read_header(fpz)) {
		  // sprintf(errorstr, "cannot read header: %s\n", fpzip_errstr[fpzip_errno]);
		  goto close;
		}
		type = fpz->type;
		prec = fpz->prec;
		nx = fpz->nx;
		ny = fpz->ny;
		nz = fpz->nz;
		nf = fpz->nf;
		
		close:
			fpzip_read_close(fpz);
  }

  // int check_length() {
		// // char errorstr[512];

		// if (stream_bytes < nbytes()) {
		//   // sprintf(errorstr, "Javascript TypedArray (%u bytes) should be at least %u bytes long.", 
		//   //   (unsigned int)buf.length(), (unsigned int)nbytes());
		//   // NBIND_ERR(errorstr);
		//   return 1;
		// }
		// return 0;
  // }

  int decompress(
		unsigned char *encoded, 
		const size_t in_bytes, 
		unsigned char *decoded,
		const size_t out_bytes
	) {
		decode_headers(encoded);
		// if (!check_length(decoded)) {
		// 	return 1;
		// }
		dfpz(encoded, in_bytes, decoded, out_bytes);
		return 0;
  }

  /* fpzip decompression + dekempression.
  *  
  * 1) fpzip decompress
  * 2) Subtract 2.0 from all elements.  
  * 3) XYCZ -> XYZC
  * 
  * Example:
  * DecodedImage *di = dekempress(buffer);
  * float* img = (float*)di->data;
  */
	int dekempress(
		unsigned char *encoded, 
		const size_t in_bytes, 
		unsigned char *decoded,
		const size_t out_bytes
	) {
		decode_headers(encoded);
		// check_length(decoded);

		dfpz(encoded, in_bytes, decoded, out_bytes);

		if (type == FPZIP_TYPE_FLOAT) {  
		  dekempress_algo<float>( reinterpret_cast<float*>(decoded) );
		}
		else {
		  dekempress_algo<double>( reinterpret_cast<double*>(decoded) );
		}

		return 0;
  }

  /* Standard fpzip decompression. 
  * 
  * Example:
  * DecodedImage *di = decompress(buffer);
  * float* img = (float*)di->data;
  */
	void dfpz(
		unsigned char *encoded, 
		const size_t in_bytes, 
		unsigned char *decoded,
		const size_t out_bytes
	) {
		// char errorstr[128];

		// unsigned char* buffer = encoded.data();

		FPZ* fpz = fpzip_read_from_buffer(static_cast<void*>(encoded));

		if (!fpzip_read_header(fpz)) {
		  // sprintf(errorstr, "cannot read header: %s\n", fpzip_errstr[fpzip_errno]);
		  // NBIND_ERR(errorstr);
		  goto close;
		}

		// perform actual decompression
		if (!fpzip_read(fpz, static_cast<void*>(decoded))) {
		  // sprintf(errorstr, "decompression failed: %s\n", fpzip_errstr[fpzip_errno]);
		  // NBIND_ERR(errorstr);
		}

		close:
			fpzip_read_close(fpz);
  }

  template <typename T>
  void dekempress_algo(T *data) {
	const size_t nvx = nvoxels();

	// Reverse loss of one bit by subtracting 2.0
	for (size_t i = 0; i < nvx; i++) {
	  data[i] -= 2.0;
	}

	// Change axes XYCZ to XYZC

	T *dekempressed = new T[nvx]();
	T *src;
	T *dest;

	const size_t xysize = nx * ny;
	int offset = 0;

	for (size_t channel = 0; channel < nf; channel++) {
	  offset = nx * ny * nz * channel;

	  for (size_t z = 0; z < nz; z++) {
		src = &data[ z * xysize * (nf + channel) ];
		dest = &dekempressed[ z * xysize + offset ];
		memcpy(dest, src, xysize * sizeof(T)); 
	  }
	}

	memcpy(data, dekempressed, nvx * sizeof(T));
  }
};

extern "C" {

int check_valid(
	unsigned char* buf,
	const size_t sx, const size_t sy, const size_t sz, 
	const size_t num_channels, const size_t bytes_per_pixel
) {
	Fpzip decoder(buf);

	unsigned int type = (bytes_per_pixel == 4)
		? 0
		: 1;

	return (
		(decoder.nx == sx) && (decoder.ny == sy) && (decoder.nz == sz)
		&& (decoder.nf == num_channels) && (decoder.type == type)
	);
}

int fpzip_decompress(
	unsigned char* buf, unsigned int num_bytes, 
	void* out, unsigned int num_out_bytes
) {
	Fpzip decoder(buf);
	decoder.decompress(buf, num_bytes, reinterpret_cast<unsigned char*>(out), num_out_bytes);
	return 0;
}

int fpzip_dekempress(
	unsigned char* buf, unsigned int num_bytes, 
	void* out, unsigned int num_out_bytes
) {
	Fpzip decoder(buf);
	decoder.dekempress(buf, num_bytes, reinterpret_cast<unsigned char*>(out), num_out_bytes);
	return 0;
}


}