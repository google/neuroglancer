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

import { describe, expect, test } from "vitest";
import { DataType } from "#src/util/data_type.js";
import { countDataInBins } from "#src/widget/invlerp.js";
import { computePercentileRangeFromValues } from "#src/widget/invlerp_range_finder.js";

describe("computePercentileRangeFromValues", () => {
  test("returns undefined for empty and all-NaN values", () => {
    expect(
      computePercentileRangeFromValues(new Float32Array(), 0, 1),
    ).toBeUndefined();
    expect(
      computePercentileRangeFromValues(
        Float32Array.of(Number.NaN, Number.NaN),
        0,
        1,
      ),
    ).toBeUndefined();
  });

  test("sorts UINT64 values", () => {
    expect(
      computePercentileRangeFromValues(BigUint64Array.of(9n, 1n, 5n), 0, 1),
    ).toEqual([1n, 9n]);
  });
});

describe("countDataInBins", () => {
  test("bins UINT64 values without mixing bigint and number arithmetic", () => {
    expect(
      countDataInBins(
        BigUint64Array.of(0n, 1n, 5n, 10n, 11n),
        DataType.UINT64,
        1n,
        10n,
        3,
      ),
    ).toEqual(Float32Array.of(1, 1, 1, 1, 1));
  });
});
