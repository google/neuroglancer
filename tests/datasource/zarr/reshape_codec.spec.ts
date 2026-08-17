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

import { describe, expect, it } from "vitest";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/reshape/resolve.js";
import "#src/datasource/zarr/codec/transpose/resolve.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

function parseChain(chunkShape: number[], codecs: unknown[]) {
  return parseCodecChainSpec(codecs, {
    dataType: DataType.UINT8,
    chunkShape,
  });
}

const bytesCodec = { name: "bytes", configuration: { endian: "little" } };

function reshapeCodec(shape: unknown) {
  return { name: "reshape", configuration: { shape } };
}

describe("reshape codec", () => {
  it("resolves an input-dims-only reshape to the reshaped image shape", () => {
    // The canonical `[1,1,32,256,256]` -> `[32,256,256]` case from the plan.
    const spec = parseChain(
      [1, 1, 32, 256, 256],
      [reshapeCodec([[2], [3], [4]]), bytesCodec],
    );
    // arrayInfo[0] is the full chunk, arrayInfo[1] is the reshaped (encoded)
    // image shape.
    expect(spec.arrayInfo[1].chunkShape).toEqual([32, 256, 256]);
    // The decoded layout (layoutInfo[0]) is plain C order with a full read.
    expect(spec.layoutInfo[0].physicalToLogicalDimension).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(spec.layoutInfo[0].readChunkShape).toEqual([1, 1, 32, 256, 256]);
  });

  it("supports fixed sizes, products, and a single -1", () => {
    const spec = parseChain(
      [100, 50, 64, 3],
      [reshapeCodec([[0, 1], [2], 3]), bytesCodec],
    );
    expect(spec.arrayInfo[1].chunkShape).toEqual([5000, 64, 3]);

    const spec2 = parseChain(
      [100, 50, 64, 3],
      [reshapeCodec([[0, 1], -1, 3]), bytesCodec],
    );
    expect(spec2.arrayInfo[1].chunkShape).toEqual([5000, 64, 3]);

    const spec3 = parseChain([4, 8, 3], [reshapeCodec([96]), bytesCodec]);
    expect(spec3.arrayInfo[1].chunkShape).toEqual([96]);
    expect(spec3.layoutInfo[0].physicalToLogicalDimension).toEqual([0, 1, 2]);
    expect(spec3.layoutInfo[0].readChunkShape).toEqual([4, 8, 3]);
  });

  it("throws when prod(output) != prod(input)", () => {
    expect(() =>
      parseChain([4, 8, 3], [reshapeCodec([100]), bytesCodec]),
    ).toThrow(/prod/);
  });

  it("throws for a non-monotonic input-dims list", () => {
    expect(() =>
      parseChain([4, 8, 3], [reshapeCodec([[1], [0], [2]]), bytesCodec]),
    ).toThrow(/monotonically/);
  });

  it("throws for more than one -1", () => {
    expect(() =>
      parseChain([4, 8, 3], [reshapeCodec([-1, -1]), bytesCodec]),
    ).toThrow(/at most once/);
  });

  it("throws when input-dims do not align with the ravel position", () => {
    // `[[0,1]]` claims output dim 0 spans input dims 0,1 but there is a trailing
    // input dim 2, violating the alignment constraint.
    expect(() =>
      parseChain([4, 8, 3], [reshapeCodec([[0, 1]]), bytesCodec]),
    ).toThrow();
  });

  it("expands a non-identity (transpose) encoded layout through whole-dim groups", () => {
    // reshape is an identity regrouping ([4,8,3] -> [4,8,3]); a following
    // transpose permutes the reshaped dims, exercising the general layout path.
    const spec = parseChain(
      [4, 8, 3],
      [
        reshapeCodec([[0], [1], [2]]),
        { name: "transpose", configuration: { order: [2, 0, 1] } },
        bytesCodec,
      ],
    );
    // The decoded layout must be a full-rank permutation of the input dims.
    const p = spec.layoutInfo[0].physicalToLogicalDimension;
    expect([...p].sort()).toEqual([0, 1, 2]);
    // Full read of every input dimension.
    expect(spec.layoutInfo[0].readChunkShape).toEqual([4, 8, 3]);
  });

  it("throws for a dimension-splitting reshape composed with a transpose", () => {
    // reshape splits input dim 0 (size 6) into [2,3]; a following transpose
    // makes the encoded layout non-identity, which cannot be expressed at the
    // input rank.
    expect(() =>
      parseChain(
        [6, 4],
        [
          reshapeCodec([2, 3, [1]]),
          { name: "transpose", configuration: { order: [2, 0, 1] } },
          bytesCodec,
        ],
      ),
    ).toThrow(/split/);
  });
});
