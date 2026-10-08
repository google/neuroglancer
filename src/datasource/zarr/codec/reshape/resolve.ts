/**
 * @license
 * Copyright 2025 Google Inc.
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

// Implements the `reshape` array -> array codec:
// https://github.com/zarr-developers/zarr-extensions/tree/main/codecs/reshape
//
// `reshape` changes the dimensions of an array while preserving the C-order
// (lexicographical) traversal of elements (`ravel(B) == ravel(A)`).  In a codec
// chain it is used before an image codec (e.g. `jpegxl`) to turn an arbitrary
// chunk shape into the fixed 2-D/3-D/4-D shape the image codec expects, and may
// be combined with `transpose` to also reorder dimensions.

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject, verifyObjectProperty } from "#src/util/json.js";

// Each element of the `shape` configuration parameter.
type ShapeElement =
  | { kind: "size"; size: number }
  | { kind: "inputDims"; inputDims: number[] }
  | { kind: "auto" };

export interface Configuration {
  // The parsed `shape` configuration, one entry per output dimension.
  shape: ShapeElement[];
  // The resolved output (encoded) shape `B_shape`.
  outputShape: number[];
}

function parseShapeElement(value: unknown): ShapeElement {
  if (typeof value === "number") {
    if (value === -1) {
      return { kind: "auto" };
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `Expected a positive integer or -1, but received: ${JSON.stringify(
          value,
        )}`,
      );
    }
    return { kind: "size", size: value };
  }
  if (Array.isArray(value)) {
    const inputDims = value.map((x) => {
      if (typeof x !== "number" || !Number.isInteger(x) || x < 0) {
        throw new Error(
          `Expected a non-negative integer input dimension, but received: ${JSON.stringify(
            x,
          )}`,
        );
      }
      return x;
    });
    if (inputDims.length === 0) {
      throw new Error("Expected a non-empty array of input dimensions");
    }
    return { kind: "inputDims", inputDims };
  }
  throw new Error(
    `Expected a positive integer, -1, or an array of input dimensions, but received: ${JSON.stringify(
      value,
    )}`,
  );
}

function prod(values: ArrayLike<number>, start = 0, end = values.length) {
  let result = 1;
  for (let i = start; i < end; ++i) {
    result *= values[i];
  }
  return result;
}

// Computes the resolved output shape `B_shape` and validates all constraints
// from the reshape spec.
function resolveOutputShape(
  shape: ShapeElement[],
  inputShape: number[],
): number[] {
  const inputRank = inputShape.length;
  const totalInputSize = prod(inputShape);
  const outputShape = new Array<number>(shape.length);

  // First pass: compute all known dimension sizes and remember the position of
  // the single `-1` (auto) entry, if any.
  let autoIndex = -1;
  let knownProduct = 1;
  for (let i = 0; i < shape.length; ++i) {
    const element = shape[i];
    switch (element.kind) {
      case "size":
        outputShape[i] = element.size;
        knownProduct *= element.size;
        break;
      case "inputDims": {
        let size = 1;
        for (const d of element.inputDims) {
          if (d >= inputRank) {
            throw new Error(
              `reshape: input dimension ${d} is out of range for array of rank ${inputRank}`,
            );
          }
          size *= inputShape[d];
        }
        outputShape[i] = size;
        knownProduct *= size;
        break;
      }
      case "auto":
        if (autoIndex !== -1) {
          throw new Error("reshape: -1 may occur at most once in `shape`");
        }
        autoIndex = i;
        break;
    }
  }

  // Resolve the automatic dimension, if present.
  if (autoIndex !== -1) {
    if (knownProduct === 0 || totalInputSize % knownProduct !== 0) {
      throw new Error(
        `reshape: cannot satisfy prod(output_shape) == prod(input_shape) ` +
          `(${totalInputSize}) with the specified dimensions`,
      );
    }
    outputShape[autoIndex] = totalInputSize / knownProduct;
    knownProduct *= outputShape[autoIndex];
  }

  // Invariant: prod(B_shape) == prod(A_shape).
  if (knownProduct !== totalInputSize) {
    throw new Error(
      `reshape: prod(output_shape)=${knownProduct} must equal ` +
        `prod(input_shape)=${totalInputSize}`,
    );
  }

  // The flattened list of input dimensions, over all elements, must be strictly
  // monotonically increasing.  Checked in its own pass so this constraint is
  // reported before the (also-derived) alignment constraint below.
  let previousInputDim = -1;
  for (const element of shape) {
    if (element.kind !== "inputDims") continue;
    for (const d of element.inputDims) {
      if (d <= previousInputDim) {
        throw new Error(
          `reshape: input dimensions must be strictly monotonically ` +
            `increasing across all elements of \`shape\``,
        );
      }
      previousInputDim = d;
    }
  }

  // Validate the alignment constraint: the coordinates in the input array along
  // `input_dims` must correspond to the raveled index along output dimension i.
  for (let i = 0; i < shape.length; ++i) {
    const element = shape[i];
    if (element.kind !== "inputDims") continue;
    const { inputDims } = element;
    const first = inputDims[0];
    const last = inputDims[inputDims.length - 1];
    if (prod(outputShape, 0, i) !== prod(inputShape, 0, first)) {
      throw new Error(
        `reshape: output dimensions before ${i} do not align with input ` +
          `dimensions before ${first}`,
      );
    }
    if (
      prod(outputShape, i + 1, outputShape.length) !==
      prod(inputShape, last + 1, inputRank)
    ) {
      throw new Error(
        `reshape: output dimensions after ${i} do not align with input ` +
          `dimensions after ${last}`,
      );
    }
  }

  return outputShape;
}

// Returns, for each output (B) dimension, the contiguous group of whole input
// (A) dimensions that it spans, or throws if the reshape cannot be expressed as
// a whole-dimension grouping (which is required to express a non-trivial layout
// at the input array's rank).
function computeInputDimGroups(
  outputShape: number[],
  inputShape: number[],
): number[][] {
  const inputRank = inputShape.length;
  const groups: number[][] = [];
  let a = 0;
  for (let i = 0; i < outputShape.length; ++i) {
    const target = outputShape[i];
    const group: number[] = [];
    let acc = 1;
    // Consume leading unit input dimensions so they are assigned to a group.
    while (a < inputRank && acc !== target && inputShape[a] === 1) {
      group.push(a);
      ++a;
    }
    while (a < inputRank && acc < target) {
      acc *= inputShape[a];
      group.push(a);
      ++a;
    }
    if (acc !== target) {
      throw new Error(
        "reshape: this reshape splits an input dimension across output " +
          "dimensions, which cannot be composed with a non-identity layout " +
          "(e.g. a transpose applied to the reshaped array)",
      );
    }
    // Absorb trailing unit dimensions into this group when it is the last
    // output dimension, so that every input dimension is assigned.
    if (i === outputShape.length - 1) {
      while (a < inputRank && inputShape[a] === 1) {
        group.push(a);
        ++a;
      }
    }
    groups.push(group);
  }
  if (a !== inputRank) {
    throw new Error(
      "reshape: unable to assign every input dimension to an output " +
        "dimension for this reshape/transpose composition",
    );
  }
  return groups;
}

function isIdentityFullRead(
  layout: CodecArrayLayoutInfo,
  shape: number[],
): boolean {
  const { physicalToLogicalDimension, readChunkShape } = layout;
  if (physicalToLogicalDimension.length !== shape.length) return false;
  for (let i = 0; i < shape.length; ++i) {
    if (physicalToLogicalDimension[i] !== i) return false;
    if (readChunkShape[i] !== shape[i]) return false;
  }
  return true;
}

registerCodec({
  name: "reshape",
  kind: CodecKind.arrayToArray,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    verifyObject(configuration);
    const shape = verifyObjectProperty(configuration, "shape", (value) => {
      if (!Array.isArray(value)) {
        throw new Error(
          `Expected an array, but received: ${JSON.stringify(value)}`,
        );
      }
      return value.map(parseShapeElement);
    });
    const outputShape = resolveOutputShape(shape, decodedArrayInfo.chunkShape);
    return {
      configuration: { shape, outputShape },
      encodedArrayInfo: {
        dataType: decodedArrayInfo.dataType,
        chunkShape: outputShape,
      },
    };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encodedLayout: CodecArrayLayoutInfo,
  ): CodecArrayLayoutInfo {
    const inputShape = decodedArrayInfo.chunkShape;
    // Fast path: when the reshaped (encoded) array is stored in plain C order
    // with a full read -- which is what the `bytes`/`jpegxl` array->bytes codecs
    // produce -- `ravel(B) == ravel(A)` means the decoded array is likewise
    // plain C order with a full read, regardless of how dimensions merge/split.
    if (isIdentityFullRead(encodedLayout, configuration.outputShape)) {
      return {
        physicalToLogicalDimension: Array.from(inputShape, (_, i) => i),
        readChunkShape: inputShape,
      };
    }

    // General path: expand the encoded layout to the input array's rank using a
    // whole-dimension grouping.  Throws for compositions that cannot be
    // expressed at the input array's rank.
    const groups = computeInputDimGroups(configuration.outputShape, inputShape);
    const physicalToLogicalDimension: number[] = [];
    for (const encodedDim of encodedLayout.physicalToLogicalDimension) {
      for (const inputDim of groups[encodedDim]) {
        physicalToLogicalDimension.push(inputDim);
      }
    }
    const readChunkShape = new Array<number>(inputShape.length);
    for (let encodedDim = 0; encodedDim < groups.length; ++encodedDim) {
      const group = groups[encodedDim];
      const readSize = encodedLayout.readChunkShape[encodedDim];
      if (readSize === configuration.outputShape[encodedDim]) {
        // Full read of this output dimension -> full read of every input
        // dimension it spans.
        for (const inputDim of group) {
          readChunkShape[inputDim] = inputShape[inputDim];
        }
      } else if (group.length === 1) {
        readChunkShape[group[0]] = readSize;
      } else {
        throw new Error(
          "reshape: partial read of an output dimension spanning multiple " +
            "input dimensions is not supported",
        );
      }
    }
    return { physicalToLogicalDimension, readChunkShape };
  },
});
