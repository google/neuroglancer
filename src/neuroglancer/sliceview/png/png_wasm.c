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

#include "spng.h"

#define RET(val) spng_ctx_free(ctx); return (val);

long int png_nbytes(
	unsigned char* buf, unsigned int num_bytes
) {
	if (buf == NULL) { return -1; }
	if (num_bytes < 8) { return -2; }

	/* Create a decoder context */
	spng_ctx *ctx = spng_ctx_new(0);
    if (ctx == NULL) { return -3; }

	/* Set an input buffer */
	if (spng_set_png_buffer(ctx, buf, num_bytes)) {
		RET(-4);
	}

    struct spng_ihdr ihdr;
    if (spng_get_ihdr(ctx, &ihdr)) {
    	RET(-5);
    }

    size_t size = 0;
    if (spng_decoded_image_size(ctx, SPNG_FMT_PNG, &size)) {
    	RET(-6);
    }

    return (long int)size;
}

int png_decompress(
	unsigned char* buf, unsigned int num_bytes, 
	void* out
) {
	if (buf == NULL) { return 1; }
	if (out == NULL) { return 2; }

	// can we even read the header?
	if (num_bytes < 8) { return 3; }

	/* Create a decoder context */
	spng_ctx *ctx = spng_ctx_new(0);
    if (ctx == NULL) { return 4; }

	/* Set an input buffer */
	if (spng_set_png_buffer(ctx, buf, num_bytes)) {
		RET(5);
	}

    struct spng_ihdr ihdr;
    if (spng_get_ihdr(ctx, &ihdr)) {
    	RET(6);
    }

    size_t size = 0;
    if (spng_decoded_image_size(ctx, SPNG_FMT_PNG, &size)) {
    	RET(7);
    }

    const int decode_flags = 0; // no special treatment, no alpha decode
    if (spng_decode_image(ctx, out, size, SPNG_FMT_PNG, decode_flags)) {
    	RET(8);
    }

    RET(0);
}

#undef RET
