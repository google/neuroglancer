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

import {
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";

export type ColorSpace = "grayscale" | "ycbcr" | "rgb";

export interface JpegConfiguration {
  encodedColorSpace: ColorSpace;
  numComponents: 1 | 3;
}

const COLOR_SPACES: readonly ColorSpace[] = ["grayscale", "ycbcr", "rgb"];

function verifyColorSpace(x: unknown): ColorSpace {
  if (typeof x !== "string" || !COLOR_SPACES.includes(x as ColorSpace)) {
    throw new Error(`jpeg: invalid color space ${JSON.stringify(x)}`);
  }
  return x as ColorSpace;
}

function verifySubsampling(x: unknown, numComponents: number): number[][] {
  if (!Array.isArray(x) || x.length !== numComponents) {
    throw new Error(
      `jpeg: subsampling must have ${numComponents} entries: ${JSON.stringify(x)}`,
    );
  }
  return x.map((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !pair.every((f) => Number.isInteger(f) && f >= 1 && f <= 4)
    ) {
      throw new Error(
        `jpeg: each subsampling entry must be [h, v] with integers 1-4: ${JSON.stringify(x)}`,
      );
    }
    return pair as number[];
  });
}

/**
 * Parse the configuration of the zarr-extensions `jpeg` codec (codecs/jpeg,
 * merged as 96a2509). Neuroglancer's JPEG decoder (jpgjs) always applies the
 * inverse YCbCr transform to 3-component data, so `rgb` is rejected, as the
 * spec requires of a decoder that cannot honour it. Decoding to YCbCr samples
 * is not supported. The stream itself records the transform and the
 * subsampling, so only the component count is needed to decode.
 */
export function parseJpegConfiguration(
  configuration: unknown,
): JpegConfiguration {
  verifyObject(configuration);
  verifyObjectProperty(configuration, "quality", (x) => {
    const q = verifyInt(x);
    if (q < 1 || q > 100) throw new Error(`jpeg: invalid quality ${q}`);
    return q;
  });
  const encoded = verifyObjectProperty(
    configuration,
    "encoded_color_space",
    verifyColorSpace,
  );
  if (encoded === "rgb") {
    throw new Error(
      "jpeg: encoded_color_space rgb is not supported: this decoder always applies the inverse YCbCr transform",
    );
  }
  const decoded = verifyOptionalObjectProperty(
    configuration,
    "decoded_color_space",
    verifyColorSpace,
    encoded === "grayscale" ? "grayscale" : "rgb",
  );
  if (
    encoded === "grayscale" ? decoded !== "grayscale" : decoded === "grayscale"
  ) {
    throw new Error(`jpeg: cannot decode ${encoded} as ${decoded}`);
  }
  if (decoded === "ycbcr") {
    throw new Error("jpeg: decoding to ycbcr samples is not supported");
  }

  const numComponents = encoded === "grayscale" ? 1 : 3;
  const subsampling = verifyOptionalObjectProperty(
    configuration,
    "subsampling",
    (x) => verifySubsampling(x, numComponents),
  );
  if (encoded === "ycbcr") {
    if (subsampling === undefined) {
      throw new Error("jpeg: subsampling is required for ycbcr");
    }
    const [, cb, cr] = subsampling;
    if ([cb, cr].some(([h, v]) => h !== 1 || v !== 1)) {
      throw new Error(
        `jpeg: the chroma components must have factor [1, 1]: ${JSON.stringify(subsampling)}`,
      );
    }
  } else if (
    subsampling !== undefined &&
    (subsampling[0][0] !== 1 || subsampling[0][1] !== 1)
  ) {
    throw new Error(
      `jpeg: subsampling for grayscale must be [[1, 1]] if present: ${JSON.stringify(subsampling)}`,
    );
  }
  return { encodedColorSpace: encoded, numComponents };
}
