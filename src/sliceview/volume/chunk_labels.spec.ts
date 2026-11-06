import { describe, it, expect } from "vitest";
import { distinctLabels } from "#src/sliceview/volume/chunk_labels.js";
import { DataType } from "#src/util/data_type.js";

const sorted = (a: BigUint64Array) => [...a].sort((x, y) => (x < y ? -1 : 1));

describe("distinctLabels", () => {
  it("reads uint32 labels, leaving out 0", () => {
    const data = Uint32Array.of(0, 5, 5, 0, 7, 5, 7, 7);
    expect(sorted(distinctLabels(data, DataType.UINT32))).toEqual([5n, 7n]);
  });

  it("reads uint64 labels stored as word pairs", () => {
    const data = Uint32Array.of(0, 0, 1, 1, 1, 1, 2, 0, 0, 0);
    expect(sorted(distinctLabels(data, DataType.UINT64))).toEqual([
      2n,
      (1n << 32n) | 1n,
    ]);
  });

  it("reads uint64 labels stored as bigints", () => {
    const data = BigUint64Array.of(0n, 9n, 9n, 1n << 40n);
    expect(sorted(distinctLabels(data, DataType.UINT64))).toEqual([
      9n,
      1n << 40n,
    ]);
  });
});
