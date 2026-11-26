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

function parseArray(
  extent: Record<string, unknown>,
  chunkGrid: unknown,
): ArrayMetadata {
  const metadata = parseV3Metadata(
    {
      zarr_format: 3,
      node_type: "array",
      ...extent,
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

const regular = { name: "regular", configuration: { chunk_shape: [4, 5] } };

const offsetGrid = (offset: unknown, base: unknown = regular) => ({
  name: "offset",
  configuration: { offset, base_chunk_grid: base },
});

describe("bounds", () => {
  it("parses the lower bound and derives the shape", () => {
    const metadata = parseArray(
      { bounds: { inclusive_min: [-3, -2], exclusive_max: [6, 7] } },
      regular,
    );
    expect(metadata.rank).toBe(2);
    expect(metadata.shape).toEqual([9, 9]);
    expect(metadata.lowerBound).toEqual([-3, -2]);
    expect(metadata.chunkGridOrigin).toEqual([0, 0]);
  });

  it("leaves a shape array at zero", () => {
    const metadata = parseArray({ shape: [6, 7] }, regular);
    expect(metadata.shape).toEqual([6, 7]);
    expect(metadata.lowerBound).toEqual([0, 0]);
    expect(metadata.chunkGridOrigin).toEqual([0, 0]);
  });

  it("allows an empty dimension and bounds below zero", () => {
    const metadata = parseArray(
      { bounds: { inclusive_min: [-3, -2], exclusive_max: [-3, -1] } },
      regular,
    );
    expect(metadata.shape).toEqual([0, 1]);
  });

  it("requires exactly one of shape and bounds", () => {
    const bounds = { inclusive_min: [0, 0], exclusive_max: [6, 7] };
    expect(() => parseArray({ shape: [6, 7], bounds }, regular)).toThrow(
      /exactly one of "shape" and "bounds", but received both/,
    );
    expect(() => parseArray({}, regular)).toThrow(
      /exactly one of "shape" and "bounds", but received neither/,
    );
  });

  it("requires integer bounds of equal length in order", () => {
    const bounds = (inclusive_min: unknown, exclusive_max: unknown) => ({
      bounds: { inclusive_min, exclusive_max },
    });
    expect(() => parseArray(bounds([0], [6, 7]), regular)).toThrow(/length 1/);
    expect(() => parseArray(bounds([0, 0.5], [6, 7]), regular)).toThrow(
      /integer/,
    );
    expect(() => parseArray(bounds([0, 8], [6, 7]), regular)).toThrow(
      /inclusive_min <= exclusive_max, but received: 8 > 7/,
    );
    expect(() =>
      parseArray({ bounds: { inclusive_min: [0, 0] } }, regular),
    ).toThrow(/exclusive_max/);
  });
});

describe("offset chunk grid", () => {
  it("parses the offset over a regular base grid", () => {
    const metadata = parseArray(
      { bounds: { inclusive_min: [-1, 0], exclusive_max: [2, 4] } },
      offsetGrid([1, -1]),
    );
    expect(metadata.chunkShape).toEqual([4, 5]);
    expect(metadata.chunkGridOrigin).toEqual([1, -1]);
    expect(metadata.lowerBound).toEqual([-1, 0]);
  });

  it("requires one integer per dimension", () => {
    expect(() => parseArray({ shape: [6, 7] }, offsetGrid([1]))).toThrow(
      /length 2/,
    );
    expect(() => parseArray({ shape: [6, 7] }, offsetGrid([1, 0.5]))).toThrow(
      /integer/,
    );
    expect(() =>
      parseArray(
        { shape: [6, 7] },
        {
          name: "offset",
          configuration: { base_chunk_grid: regular },
        },
      ),
    ).toThrow(/offset/);
  });

  it("refuses a base grid other than regular", () => {
    expect(() =>
      parseArray(
        { shape: [6, 7] },
        offsetGrid([1, -1], {
          name: "rectilinear",
          configuration: {
            chunk_shapes: [
              [4, 2],
              [5, 2],
            ],
          },
        }),
      ),
    ).toThrow(/Expected "regular", but received: "rectilinear"/);
    expect(() =>
      parseArray({ shape: [6, 7] }, offsetGrid([1, -1], offsetGrid([0, 0]))),
    ).toThrow(/Expected "regular", but received: "offset"/);
    expect(() =>
      parseArray(
        { shape: [6, 7] },
        {
          name: "offset",
          configuration: { offset: [1, -1] },
        },
      ),
    ).toThrow(/base_chunk_grid/);
  });

  it("refuses an unknown chunk grid", () => {
    expect(() =>
      parseArray(
        { shape: [6, 7] },
        {
          name: "rectilinear",
          configuration: {
            chunk_shapes: [
              [4, 2],
              [5, 2],
            ],
          },
        },
      ),
    ).toThrow(/Invalid enum/);
  });
});
