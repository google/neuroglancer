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

import {
  committedSpatialSkeletonOptimisticEditSettlement,
  createInitialSpatialSkeletonOptimisticIntentLifecycle,
  unchangedSpatialSkeletonOptimisticEditSettlement,
  type SpatialSkeletonOptimisticEditSettlement,
} from "#src/skeleton/optimistic_edit/lifecycle.js";

describe("spatial skeleton optimistic lifecycle", () => {
  it("creates an independent lifecycle with every generic axis", () => {
    const first = createInitialSpatialSkeletonOptimisticIntentLifecycle();
    const second = createInitialSpatialSkeletonOptimisticIntentLifecycle();

    expect(first).toEqual({
      preview: "reserved",
      authority: "queued",
      reconciliation: "waiting",
      history: "staged",
    });
    expect(second).not.toBe(first);
  });

  it("represents only definitive authority settlements", () => {
    const settlements = [
      committedSpatialSkeletonOptimisticEditSettlement({ revision: 2 }),
      unchangedSpatialSkeletonOptimisticEditSettlement(
        "rejected",
        new Error("conflict"),
      ),
    ] satisfies readonly SpatialSkeletonOptimisticEditSettlement[];

    expect(settlements.map(({ outcome }) => outcome)).toEqual([
      "committed",
      "unchanged",
    ]);
    expect(settlements[1]).toMatchObject({
      outcome: "unchanged",
      reason: "rejected",
      error: expect.any(Error),
    });
  });
});
