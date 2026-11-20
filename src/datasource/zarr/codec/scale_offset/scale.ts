/**
 * @license
 * Copyright 2026 Google Inc.
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

/**
 * Inverts the zarr-extensions `scale_offset` codec, `out = (in - offset) *
 * scale`, in float32 arithmetic: `in = out / scale + offset`.
 */
export function unscaleFloat32(
  encoded: Float32Array,
  offset: number,
  scale: number,
): Float32Array<ArrayBuffer> {
  const o = Math.fround(offset);
  const s = Math.fround(scale);
  const n = encoded.length;
  const decoded = new Float32Array(new ArrayBuffer(4 * n));
  for (let i = 0; i < n; ++i) {
    decoded[i] = Math.fround(encoded[i] / s) + o;
  }
  return decoded;
}
