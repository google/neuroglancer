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

#include "./src/crackle.hpp"

extern "C" {

int crackle_decompress(
	unsigned char* buf, unsigned int num_bytes, 
    void* out, unsigned int output_num_bytes
) {
	return crackle::decompress(
        buf, num_bytes, out, output_num_bytes
    );
}

}