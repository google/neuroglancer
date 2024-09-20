/**
 * @license
 * Copyright 2024 William Silvermsith (with help from ChatGPT)
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

#include <jxl/decode.h>

int jxl_decompress(
	unsigned char* buf, unsigned int num_bytes, 
	void* out, unsigned int num_out_bytes
) {

	int retval = 0;

	JxlResizableParallelRunnerPtr* runner = JxlResizableParallelRunnerMake(nullptr);
	JxlResizableParallelRunnerSetThreads(runner.get(), 1);

	JxlDecoder* dec = JxlDecoderCreate(NULL);
	if (!dec) {
		retval = -1;
		goto done;
	}

	JxlDecoderStatus status = JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_COLOR_ENCODING);
	if (status != JXL_DEC_SUCCESS) {
		retval = -2;
		goto done;
	}

	// Set the input data
	JxlDecoderSetInput(dec.get(), buf, num_bytes);
	JxlDecoderCloseInput(dec.get());

	JxlBasicInfo info;
	JxlColorSpace colorspace = JXL_COLOR_SPACE_GRAY; // default to be replaced
	JxlPixelFormat format = {1, JXL_TYPE_UINT8, colorspace, JXL_NATIVE_ENDIAN};

	while (true) {
		JxlDecoderStatus status = JxlDecoderProcessInput(dec.get());

		if (status == JXL_DEC_ERROR) {
		  retval = -3;
		  goto done;
		} 
		else if (status == JXL_DEC_NEED_MORE_INPUT) {
		  retval = -4;
		  goto done;
		} 
		else if (status == JXL_DEC_BASIC_INFO) {
			if (JXL_DEC_SUCCESS != JxlDecoderGetBasicInfo(dec.get(), &info)) {
				retval = -5;
				goto done;
			}

			// Ensure output buffer is large enough
			unsigned int expected_size = info.xsize * info.ysize * info.num_color_channels;
			if (num_out_bytes < expected_size) {
				retval = -6;
				goto done;
			}

			// Set the output format
			colorspace = (info.num_color_channels == 1) 
				? JXL_COLOR_SPACE_GRAY 
				: JXL_COLOR_SPACE_RGB;

			format = {1, JXL_TYPE_UINT8, colorspace, JXL_NATIVE_ENDIAN};

			// Set the output buffer
			status = JxlDecoderSetOutputBuffer(dec, &format, out, num_out_bytes);
			if (status != JXL_DEC_SUCCESS) {
				retval = -7;
				goto done;
			}
		} 
		else if (status == JXL_DEC_COLOR_ENCODING) {
			// Get the ICC color profile of the pixel data
			size_t icc_size;
			if (JXL_DEC_SUCCESS !=
			  JxlDecoderGetICCProfileSize(dec.get(), JXL_COLOR_PROFILE_TARGET_DATA,
										  &icc_size)) {

				retval = -8;
				goto done;
			}
			icc_profile->resize(icc_size);
			if (JXL_DEC_SUCCESS != JxlDecoderGetColorAsICCProfile(
									 dec.get(), JXL_COLOR_PROFILE_TARGET_DATA,
									 icc_profile->data(), icc_profile->size())) {
				retval = -9;
				goto done;
			}
		} 
		else if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
			size_t buffer_size;
			if (JXL_DEC_SUCCESS !=
				JxlDecoderImageOutBufferSize(dec.get(), &format, &buffer_size)) {

			}
			if (buffer_size != info.xsize * info.ysize * 16) {
				return -10;
				goto done;
			}
			pixels->resize(info.xsize * info.ysize * 4);
			void* pixels_buffer = static_cast<void*>(pixels->data());
			size_t pixels_buffer_size = pixels->size() * sizeof(float);
			if (JXL_DEC_SUCCESS != JxlDecoderSetImageOutBuffer(dec.get(), &format,
															 pixels_buffer,
															 pixels_buffer_size)) {
				return -11;
				goto done;
			}
		} 
		else if (status == JXL_DEC_FULL_IMAGE) {
		  // Nothing to do. Do not yet return. If the image is an animation, more
		  // full frames may be decoded. This example only keeps the last one.
		} 
		else if (status == JXL_DEC_SUCCESS) {
		  goto done;
		} 
		else {
			retval = -12;
			goto done;
		}
	}

done:
	JxlDecoderDestroy(dec);
	return retval;
}
