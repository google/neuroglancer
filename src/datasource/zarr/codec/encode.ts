/**
 * Minimal Zarr encode pipeline to persist chunks.
 * Supports only the common case of raw bytes (no transpose/compression/sharding).
 */
import type { CodecChainSpec } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";

export async function encodeArray(
  codecs: CodecChainSpec,
  typed: ArrayBufferView<ArrayBufferLike>,
  _signal: AbortSignal,
): Promise<Uint8Array<ArrayBufferLike>> {
  // Only support simple "bytes" encoding with no array-to-array and no bytes-to-bytes codecs.
  const hasArrayToArray = codecs[CodecKind.arrayToArray].length > 0;
  const hasBytesToBytes = codecs[CodecKind.bytesToBytes].length > 0;
  const arrayToBytes = codecs[CodecKind.arrayToBytes];
  if (hasArrayToArray || hasBytesToBytes || arrayToBytes.name !== "bytes") {
    throw new Error(
      `encodeArray: Unsupported codec chain; only raw 'bytes' without additional codecs is supported. Got arrayToArray=${hasArrayToArray}, bytesToBytes=${hasBytesToBytes}, arrayToBytes=${arrayToBytes.name}`,
    );
  }
  // For raw bytes, we can write the underlying buffer.
  const { buffer, byteOffset, byteLength } = typed;
  return new Uint8Array(buffer, byteOffset, byteLength);
}
