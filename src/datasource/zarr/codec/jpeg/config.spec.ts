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

import { describe, it, expect } from "vitest";
import { parseJpegConfiguration } from "#src/datasource/zarr/codec/jpeg/config.js";

const parse = (c: object) => parseJpegConfiguration(c);

describe("parseJpegConfiguration", () => {
  it("accepts grayscale with or without the default subsampling", () => {
    expect(parse({ quality: 90, encoded_color_space: "grayscale" })).toEqual({
      encodedColorSpace: "grayscale",
      numComponents: 1,
    });
    expect(
      parse({
        quality: 90,
        encoded_color_space: "grayscale",
        subsampling: [[1, 1]],
      }).numComponents,
    ).toBe(1);
  });

  it("rejects grayscale subsampling other than the default", () => {
    expect(() =>
      parse({
        quality: 90,
        encoded_color_space: "grayscale",
        subsampling: [[2, 2]],
      }),
    ).toThrow();
    expect(() =>
      parse({
        quality: 90,
        encoded_color_space: "grayscale",
        subsampling: [
          [1, 1],
          [1, 1],
          [1, 1],
        ],
      }),
    ).toThrow();
  });

  it("requires and checks subsampling for ycbcr", () => {
    expect(
      parse({
        quality: 90,
        encoded_color_space: "ycbcr",
        subsampling: [
          [2, 2],
          [1, 1],
          [1, 1],
        ],
      }).numComponents,
    ).toBe(3);
    expect(() =>
      parse({ quality: 90, encoded_color_space: "ycbcr" }),
    ).toThrow();
    expect(() =>
      parse({
        quality: 90,
        encoded_color_space: "ycbcr",
        subsampling: [
          [2, 2],
          [2, 1],
          [1, 1],
        ],
      }),
    ).toThrow();
    expect(() =>
      parse({
        quality: 90,
        encoded_color_space: "ycbcr",
        subsampling: [
          [5, 1],
          [1, 1],
          [1, 1],
        ],
      }),
    ).toThrow();
    expect(() =>
      parse({
        quality: 90,
        encoded_color_space: "ycbcr",
        subsampling: [
          [2, 2],
          [1, 1],
        ],
      }),
    ).toThrow();
  });

  it("rejects rgb, which jpgjs cannot decode correctly", () => {
    expect(() => parse({ quality: 90, encoded_color_space: "rgb" })).toThrow(
      /rgb/,
    );
  });

  it("requires quality 1-100", () => {
    expect(() =>
      parse({ quality: 0, encoded_color_space: "grayscale" }),
    ).toThrow();
    expect(() =>
      parse({ quality: 101, encoded_color_space: "grayscale" }),
    ).toThrow();
    expect(() => parse({ encoded_color_space: "grayscale" })).toThrow();
    expect(
      parse({ quality: 1, encoded_color_space: "grayscale" }).numComponents,
    ).toBe(1);
  });

  it("checks the color-space combination", () => {
    expect(() =>
      parse({
        quality: 90,
        encoded_color_space: "grayscale",
        decoded_color_space: "rgb",
      }),
    ).toThrow();
    expect(() =>
      parse({
        quality: 90,
        encoded_color_space: "ycbcr",
        decoded_color_space: "ycbcr",
        subsampling: [
          [1, 1],
          [1, 1],
          [1, 1],
        ],
      }),
    ).toThrow(/ycbcr/);
    expect(() => parse({ quality: 90, encoded_color_space: "cmyk" })).toThrow();
  });
});
