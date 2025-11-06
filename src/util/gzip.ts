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

/**
 * Detects gzip format based on the 3 magic bytes at the start.
 */
export function isGzipFormat(data: ArrayBufferView) {
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return (
    view.length >= 3 && view[0] === 0x1f && view[1] === 0x8b && view[2] === 0x08
  );
}

export async function decodeGzip(
  data: ArrayBuffer | ArrayBufferView<ArrayBuffer> | Response,
  format: CompressionFormat,
  signal?: AbortSignal,
) {
  try {
    const decompressedStream = decodeGzipStream(
      data instanceof Response ? data : new Response(data),
      format,
      signal,
    );
    return await new Response(decompressedStream).arrayBuffer();
  } catch {
    signal?.throwIfAborted();
    throw new Error(`Failed to decode ${format}`);
  }
}

export function decodeGzipStream(
  response: Response,
  format: CompressionFormat,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  return response.body!.pipeThrough(new DecompressionStream(format), {
    signal: signal,
  });
}

/**
 * Decompress `data` if it is in gzip format, otherwise just return it.
 */
export async function maybeDecompressGzip(
  data: ArrayBuffer | ArrayBufferView<ArrayBuffer>,
) {
  let byteView: Uint8Array<ArrayBuffer>;
  if (data instanceof ArrayBuffer) {
    byteView = new Uint8Array(data);
  } else {
    byteView = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (isGzipFormat(byteView)) {
    return new Uint8Array(await decodeGzip(byteView, "gzip"));
  }
  return byteView;
}
