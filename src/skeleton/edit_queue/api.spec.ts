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
  >["classifyFailure"],
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

describe("saving one edit request", () => {
  it("treats an edit as possibly saved when its failure cannot be classified", async () => {
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
