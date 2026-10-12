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

import { describe, expect, it, vi } from "vitest";

import {
  commitSpatialSkeletonMutation,
  isSpatialSkeletonOptimisticEditingProvider,
  type SpatialSkeletonMutationContext,
  type SpatialSkeletonOptimisticMutationAdapter,
} from "#src/skeleton/optimistic_edit/api.js";

interface TestMutation {
  readonly nodeId: number;
}

function makeAdapter(
  commit: SpatialSkeletonOptimisticMutationAdapter<
    TestMutation,
    string
  >["commit"],
  classifyFailure: SpatialSkeletonOptimisticMutationAdapter<
    TestMutation,
    string
  >["classifyFailure"] = () => "indeterminate",
): SpatialSkeletonOptimisticMutationAdapter<TestMutation, string> {
  return {
    mutationScope: {},
    commit,
    classifyFailure,
  };
}

const mutation = { nodeId: 17 };
const context: SpatialSkeletonMutationContext = {
  intent: "execute",
  operationId: 4,
};

describe("spatial skeleton optimistic mutation adapter", () => {
  it("normalizes a successful provider commit", async () => {
    const commit = vi.fn(async () => "authority-result");
    const classifyFailure = vi.fn(() => "rejected" as const);
    const adapter = makeAdapter(commit, classifyFailure);

    await expect(
      commitSpatialSkeletonMutation(adapter, mutation, context),
    ).resolves.toEqual({
      status: "committed",
      result: "authority-result",
    });
    expect(commit).toHaveBeenCalledWith(mutation, context);
    expect(classifyFailure).not.toHaveBeenCalled();
  });

  it.each(["not-started", "rejected", "indeterminate"] as const)(
    "preserves the adapter's %s failure classification",
    async (status) => {
      const error = new Error("mutation failed");
      const classifyFailure = vi.fn(() => status);
      const adapter = makeAdapter(async () => {
        throw error;
      }, classifyFailure);

      await expect(
        commitSpatialSkeletonMutation(adapter, mutation, context),
      ).resolves.toEqual({ status, error });
      expect(classifyFailure).toHaveBeenCalledWith(error, mutation, context);
    },
  );

  it("conservatively treats a classification failure as indeterminate", async () => {
    const mutationError = new Error("mutation failed");
    const classificationError = new Error("classifier failed");
    const adapter = makeAdapter(
      () => Promise.reject(mutationError),
      () => {
        throw classificationError;
      },
    );

    await expect(
      commitSpatialSkeletonMutation(adapter, mutation, context),
    ).resolves.toEqual({
      status: "indeterminate",
      error: mutationError,
      classificationError,
    });
  });
});

describe("isSpatialSkeletonOptimisticEditingProvider", () => {
  it("accepts only values exposing the driver provider operation", () => {
    const provider = {
      createDriver: () => ({}),
    };

    expect(isSpatialSkeletonOptimisticEditingProvider(provider)).toBe(true);
    expect(
      isSpatialSkeletonOptimisticEditingProvider({
        getOrCreateQueue: () => ({}),
      }),
    ).toBe(false);
    expect(isSpatialSkeletonOptimisticEditingProvider(null)).toBe(false);
  });
});
