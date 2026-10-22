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

import type {
  SpatialSkeletonEditRequestContext,
  SpatialSkeletonEditRequestAdapter,
} from "#src/skeleton/edit_queue/api.js";
import { commitSpatialSkeletonEditRequest } from "#src/skeleton/edit_queue/api.js";

interface TestEditRequest {
  readonly nodeId: bigint;
}

function makeAdapter(
  commit: SpatialSkeletonEditRequestAdapter<TestEditRequest, string>["commit"],
  classifyFailure: SpatialSkeletonEditRequestAdapter<
    TestEditRequest,
    string
  >["classifyFailure"] = () => "indeterminate",
): SpatialSkeletonEditRequestAdapter<TestEditRequest, string> {
  return {
    editRequestScope: {},
    commit,
    classifyFailure,
  };
}

const editRequest = { nodeId: 17n };
const context: SpatialSkeletonEditRequestContext = {
  intent: "execute",
  operationId: 4,
};

describe("spatial skeleton optimistic edit request adapter", () => {
  it("normalizes a successful provider commit", async () => {
    const commit = vi.fn(async () => "authority-result");
    const classifyFailure = vi.fn(() => "rejected" as const);
    const adapter = makeAdapter(commit, classifyFailure);

    await expect(
      commitSpatialSkeletonEditRequest(adapter, editRequest, context),
    ).resolves.toEqual({
      status: "committed",
      result: "authority-result",
    });
    expect(commit).toHaveBeenCalledWith(editRequest, context);
    expect(classifyFailure).not.toHaveBeenCalled();
  });

  it.each(["not-started", "rejected", "indeterminate"] as const)(
    "preserves the adapter's %s failure classification",
    async (status) => {
      const error = new Error("edit request failed");
      const classifyFailure = vi.fn(() => status);
      const adapter = makeAdapter(async () => {
        throw error;
      }, classifyFailure);

      await expect(
        commitSpatialSkeletonEditRequest(adapter, editRequest, context),
      ).resolves.toEqual({ status, error });
      expect(classifyFailure).toHaveBeenCalledWith(error, editRequest, context);
    },
  );

  it("conservatively treats a classification failure as indeterminate", async () => {
    const editRequestError = new Error("edit request failed");
    const classificationError = new Error("classifier failed");
    const adapter = makeAdapter(
      () => Promise.reject(editRequestError),
      () => {
        throw classificationError;
      },
    );

    await expect(
      commitSpatialSkeletonEditRequest(adapter, editRequest, context),
    ).resolves.toEqual({
      status: "indeterminate",
      error: editRequestError,
      classificationError,
    });
  });
});
