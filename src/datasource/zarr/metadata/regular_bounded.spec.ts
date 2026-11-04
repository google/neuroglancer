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
import "#src/datasource/zarr/codec/bytes/resolve.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";

function parseArray(chunkGrid: unknown): ArrayMetadata {
  const metadata = parseV3Metadata(
    {
      zarr_format: 3,
      node_type: "array",
      shape: [6, 7],
      data_type: "uint16",
      chunk_grid: chunkGrid,
      chunk_key_encoding: { name: "default" },
      fill_value: 0,
      codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    },
    "array",
  );
  if (metadata.nodeType !== "array") throw new Error("expected an array");
  return metadata;
}

describe("regular_bounded chunk grid", () => {
  it("parses the origin and lower bound", () => {
    const metadata = parseArray({
      name: "regular_bounded",
      configuration: {
        chunk_shape: [4, 5],
        origin: [1, 0],
        lower_bound: [-3, -2],
      },
    });
    expect(metadata.chunkShape).toEqual([4, 5]);
    expect(metadata.chunkGridOrigin).toEqual([1, 0]);
    expect(metadata.lowerBound).toEqual([-3, -2]);
  });

  it("leaves a regular grid at zero", () => {
    const metadata = parseArray({
      name: "regular",
      configuration: { chunk_shape: [4, 5] },
    });
    expect(metadata.chunkGridOrigin).toEqual([0, 0]);
    expect(metadata.lowerBound).toEqual([0, 0]);
  });

  it("requires one integer per dimension for both fields", () => {
    const grid = (configuration: object) => ({
      name: "regular_bounded",
      configuration: { chunk_shape: [4, 5], ...configuration },
    });
    expect(() => parseArray(grid({ origin: [0, 0] }))).toThrow(/lower_bound/);
    expect(() =>
      parseArray(grid({ origin: [0], lower_bound: [0, 0] })),
    ).toThrow(/length 2/);
    expect(() =>
      parseArray(grid({ origin: [0, 0], lower_bound: [0, 0.5] })),
    ).toThrow(/integer/);
  });

  it("refuses an unknown chunk grid", () => {
    expect(() =>
      parseArray({
        name: "regular_offset",
        configuration: { chunk_shape: [4, 5] },
      }),
    ).toThrow(/Invalid enum/);
  });
});
