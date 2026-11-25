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

type ShapeElement = number | number[];

/**
 * Computes the encoded chunk shape of the zarr-extensions `reshape` codec.
 * Each element of `shape` is a fixed size, `-1` (inferred, at most once), or a
 * list of decoded dimensions whose sizes multiply. The codec never reorders
 * elements, so listed dimensions must be strictly increasing and must line up
 * with the fixed sizes around them.
 */
export function computeReshapedShape(
  shape: unknown,
  decodedShape: readonly number[],
): number[] {
  if (!Array.isArray(shape) || shape.length === 0) {
    throw new Error(`reshape: invalid shape ${JSON.stringify(shape)}`);
  }
  const rank = decodedShape.length;
  const total = decodedShape.reduce((a, b) => a * b, 1);
  const elements = shape as ShapeElement[];
  const encoded = new Array<number>(elements.length);
  let inferred = -1;
  let lastDim = -1;
  for (let i = 0; i < elements.length; ++i) {
    const e = elements[i];
    if (Array.isArray(e)) {
      if (e.length === 0) {
        throw new Error("reshape: empty list of input dimensions");
      }
      let size = 1;
      for (const d of e) {
        if (!Number.isInteger(d) || d <= lastDim || d >= rank) {
          throw new Error(
            `reshape: input dimensions must be strictly increasing and in [0, ${rank}): ${JSON.stringify(shape)}`,
          );
        }
        lastDim = d;
        size *= decodedShape[d];
      }
      encoded[i] = size;
    } else if (e === -1) {
      if (inferred !== -1) {
        throw new Error("reshape: -1 may occur at most once");
      }
      inferred = i;
    } else if (Number.isInteger(e) && e > 0) {
      encoded[i] = e;
    } else {
      throw new Error(`reshape: invalid shape element ${JSON.stringify(e)}`);
    }
  }
  if (inferred !== -1) {
    const known = encoded.reduce((a, b, i) => (i === inferred ? a : a * b), 1);
    if (known === 0 || total % known !== 0) {
      throw new Error(`reshape: cannot infer -1 in ${JSON.stringify(shape)}`);
    }
    encoded[inferred] = total / known;
  }
  if (encoded.reduce((a, b) => a * b, 1) !== total) {
    throw new Error(
      `reshape: ${JSON.stringify(shape)} does not preserve ${total} elements of [${decodedShape}]`,
    );
  }
  // a listed group must start where the preceding output elements end
  let outPrefix = 1;
  for (let i = 0; i < elements.length; ++i) {
    const e = elements[i];
    if (Array.isArray(e)) {
      const inPrefix = decodedShape.slice(0, e[0]).reduce((a, b) => a * b, 1);
      if (inPrefix !== outPrefix) {
        throw new Error(
          `reshape: dimensions ${JSON.stringify(e)} do not line up in ${JSON.stringify(shape)}`,
        );
      }
    }
    outPrefix *= encoded[i];
  }
  return encoded;
}
