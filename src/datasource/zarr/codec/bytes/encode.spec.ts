import { describe, it, expect } from "vitest";
import "#src/datasource/zarr/codec/bytes/encode.js";
import { encodeArray } from "#src/datasource/zarr/codec/encode.js";
import type { CodecChainSpec } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { DataType } from "#src/util/data_type.js";
import { ENDIANNESS, Endianness } from "#src/util/endian.js";

const OTHER_ENDIANNESS =
  ENDIANNESS === Endianness.LITTLE ? Endianness.BIG : Endianness.LITTLE;

function bytesCodecChain(endian: Endianness): CodecChainSpec {
  return {
    [CodecKind.arrayToArray]: [],
    [CodecKind.arrayToBytes]: {
      name: "bytes",
      kind: CodecKind.arrayToBytes,
      configuration: { endian },
    },
    [CodecKind.bytesToBytes]: [],
    arrayInfo: [{ dataType: DataType.UINT16, chunkShape: [2] }],
    layoutInfo: [],
    encodedSize: [],
  };
}

describe("zarr bytes codec encode", () => {
  it("swaps a copy and leaves the input untouched", async () => {
    const decoded = Uint16Array.of(0x1122, 0x3344);
    const encoded = await encodeArray(
      bytesCodecChain(OTHER_ENDIANNESS),
      decoded,
      new AbortController().signal,
    );
    expect(Array.from(decoded)).toEqual([0x1122, 0x3344]);
    expect(
      Array.from(new Uint16Array(encoded.buffer, encoded.byteOffset, 2)),
    ).toEqual([0x2211, 0x4433]);
  });

  it("returns a view of the input when no swap is needed", async () => {
    const decoded = Uint16Array.of(0x1122, 0x3344);
    const encoded = await encodeArray(
      bytesCodecChain(ENDIANNESS),
      decoded,
      new AbortController().signal,
    );
    expect(encoded.buffer).toBe(decoded.buffer);
  });
});
