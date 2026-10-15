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

import { describe, expect, it } from "vitest";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import {
  ChunkKeyEncoding,
  encodeChunkKey,
} from "#src/datasource/zarr/metadata/index.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";
import "#src/datasource/zarr/codec/bytes/resolve.js";

function v3Array(chunkKeyEncoding: unknown) {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [6, 7],
    data_type: "uint16",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 5] } },
    chunk_key_encoding: chunkKeyEncoding,
    fill_value: 0,
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
  };
}

function parseArray(chunkKeyEncoding: unknown): ArrayMetadata {
  const metadata = parseV3Metadata(v3Array(chunkKeyEncoding), "array");
  if (metadata.nodeType !== "array") throw new Error("expected an array");
  return metadata;
}

describe("offset chunk key encoding", () => {
  it("parses the offset and defaults the separator to /", () => {
    const metadata = parseArray({
      name: "offset",
      configuration: { offset: [-2, 0] },
    });
    expect(metadata.chunkKeyEncoding).toBe(ChunkKeyEncoding.OFFSET);
    expect(metadata.dimensionSeparator).toBe("/");
    expect(metadata.chunkKeyOffset).toEqual([-2, 0]);
  });

  it("accepts an explicit separator", () => {
    const metadata = parseArray({
      name: "offset",
      configuration: { separator: ".", offset: [1, -1] },
    });
    expect(metadata.dimensionSeparator).toBe(".");
    expect(metadata.chunkKeyOffset).toEqual([1, -1]);
  });

  it("requires one integer offset per dimension", () => {
    expect(() => parseArray({ name: "offset" })).toThrow(/offset/);
    expect(() =>
      parseArray({ name: "offset", configuration: { offset: [1] } }),
    ).toThrow(/length 2/);
    expect(() =>
      parseArray({ name: "offset", configuration: { offset: [1, 0.5] } }),
    ).toThrow(/integer/);
  });

  it("leaves the default and v2 encodings without an offset", () => {
    expect(parseArray({ name: "default" }).chunkKeyOffset).toBeUndefined();
    expect(parseArray({ name: "v2" }).chunkKeyOffset).toBeUndefined();
    expect(() => parseArray({ name: "shifted" })).toThrow(/Invalid enum/);
  });
});

describe("encodeChunkKey", () => {
  const base = {
    rank: 2,
    chunkKeyEncoding: ChunkKeyEncoding.DEFAULT,
    dimensionSeparator: "/" as const,
    chunkKeyOffset: undefined,
  };

  it("formats default and v2 keys as before", () => {
    expect(encodeChunkKey(base, [3, 1])).toBe("c/3/1");
    expect(encodeChunkKey({ ...base, dimensionSeparator: "." }, [3, 1])).toBe(
      "c.3.1",
    );
    expect(
      encodeChunkKey(
        {
          ...base,
          chunkKeyEncoding: ChunkKeyEncoding.V2,
          dimensionSeparator: ".",
        },
        [3, 1],
      ),
    ).toBe("3.1");
    expect(
      encodeChunkKey(
        { ...base, rank: 0, chunkKeyEncoding: ChunkKeyEncoding.V2 },
        [],
      ),
    ).toBe("0");
    expect(encodeChunkKey({ ...base, rank: 0 }, [])).toBe("c");
  });

  it("adds the offset per dimension, giving negative components in front", () => {
    const offset = {
      ...base,
      chunkKeyEncoding: ChunkKeyEncoding.OFFSET,
      chunkKeyOffset: [-2, 1],
    };
    expect(encodeChunkKey(offset, [0, 0])).toBe("c/-2/1");
    expect(encodeChunkKey(offset, [2, 0])).toBe("c/0/1");
    expect(encodeChunkKey(offset, [5, 4])).toBe("c/3/5");
  });

  it("with an all-zero offset matches the default encoding", () => {
    const zero = {
      ...base,
      chunkKeyEncoding: ChunkKeyEncoding.OFFSET,
      chunkKeyOffset: [0, 0],
    };
    for (const coords of [
      [0, 0],
      [3, 1],
      [12, 7],
    ]) {
      expect(encodeChunkKey(zero, coords)).toBe(encodeChunkKey(base, coords));
    }
  });
});
