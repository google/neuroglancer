/**
 * @license
 * Copyright 2016 Google Inc.
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

import pako from 'pako';

/**
 * Detects gzip format based on the 2 magic bytes at the start.
 */
export function isGzipFormat(data: ArrayBufferView) {
  let view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return (view.length > 2 && view[0] === 0x1F && view[1] === 0x8B);
}

/**
 * Decompress `data` if it is in gzip format, otherwise just return it.
 */
export function maybeDecompressGzip(data: ArrayBuffer|ArrayBufferView) {
  let byteView: Uint8Array;
  if (data instanceof ArrayBuffer) {
    byteView = new Uint8Array(data);
  } else {
    byteView = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (isGzipFormat(byteView)) {
    return pako.inflate(byteView);
  }
  return byteView;
}
