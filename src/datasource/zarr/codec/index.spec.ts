import { describe, it, expect } from "vitest";
import type { CodecChainSpec } from "#src/datasource/zarr/codec/index.js";
import {
  CodecKind,
  codecChainSupportsWriting,
} from "#src/datasource/zarr/codec/index.js";
import { DataType } from "#src/util/data_type.js";

function codecChain(bytesToBytes: string[]): CodecChainSpec {
  return {
    [CodecKind.arrayToArray]: [],
    [CodecKind.arrayToBytes]: {
      name: "bytes",
      kind: CodecKind.arrayToBytes,
      configuration: {},
    },
    [CodecKind.bytesToBytes]: bytesToBytes.map((name) => ({
      name,
      kind: CodecKind.bytesToBytes,
      configuration: {},
    })),
    arrayInfo: [{ dataType: DataType.UINT8, chunkShape: [1] }],
    layoutInfo: [],
    encodedSize: [],
  };
}

describe("codecChainSupportsWriting", () => {
  it.for([[], ["gzip"], ["zlib"], ["blosc"]])(
    "accepts the bytes -> bytes chain %j",
    (bytesToBytes) => {
      expect(codecChainSupportsWriting(codecChain(bytesToBytes))).toBe(true);
    },
  );

  it.for([["zstd"], ["crc32c"], ["gzip", "crc32c"]])(
    "rejects the bytes -> bytes chain %j, which has no encoder",
    (bytesToBytes) => {
      expect(codecChainSupportsWriting(codecChain(bytesToBytes))).toBe(false);
    },
  );

  it("rejects an array -> array codec", () => {
    const codecs = codecChain([]);
    codecs[CodecKind.arrayToArray].push({
      name: "transpose",
      kind: CodecKind.arrayToArray,
      configuration: {},
    });
    expect(codecChainSupportsWriting(codecs)).toBe(false);
  });
});
