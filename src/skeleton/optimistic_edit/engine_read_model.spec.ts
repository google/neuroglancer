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
  projectSpatialSkeletonOptimisticQueueSnapshot,
  projectSpatialSkeletonOptimisticRecentActivity,
  type SpatialSkeletonOptimisticEngineReadModelEntry,
} from "#src/skeleton/optimistic_edit/engine_read_model.js";
import { HttpError } from "#src/util/http_request.js";

function rejectedEntry(
  error: unknown,
): SpatialSkeletonOptimisticEngineReadModelEntry {
  return {
    sequence: 1,
    kind: "execute",
    terminal: true,
    dependencySequences: [],
    lifecycle: {
      preview: "rolled-back",
      authority: "unchanged",
      reconciliation: "not-required",
      history: "rejected",
      authorityReason: "rejected",
    },
    rejectionReason: error,
    canceledLaterIntentCount: 0,
    metadata: { kind: "deleteNode", commandLabel: "Delete node" },
  };
}

describe("optimistic queue failure explanations", () => {
  it("retains the final-node explanation in both queue and completed activity without the request URL", () => {
    const error = new HttpError(
      "https://catmaid.example.test/1/treenode/delete?private=secret",
      409,
      "Conflict",
    );
    const explanation =
      "Skeleton cannot be deleted because it is associated with a task. Please link the task to a different skeleton before deleting it.";
    error.message += ` ${explanation}`;
    const entries = [rejectedEntry(error)];
    const reason = `Request failed with HTTP 409 (Conflict). ${explanation}`;
    expect(
      projectSpatialSkeletonOptimisticQueueSnapshot(entries, 1)[0],
    ).toMatchObject({ reason, error });
    expect(
      projectSpatialSkeletonOptimisticRecentActivity(entries, 1, 10)[0],
    ).toMatchObject({ status: "not-saved", reason });
    expect(reason).not.toContain(error.url);
  });

  it.each(["", "A very long provider explanation. ".repeat(30)])(
    "bounds HTTP diagnostics and provider explanations: %s",
    (explanation) => {
      const error = new HttpError(
        "https://catmaid.example.test/private",
        409,
        "Conflict",
      );
      error.message += ` ${explanation}`;
      const reason = projectSpatialSkeletonOptimisticRecentActivity(
        [rejectedEntry(error)],
        1,
        10,
      )[0]!.reason!;
      expect(reason).toContain("Request failed with HTTP 409 (Conflict).");
      expect(reason.length).toBeLessThanOrEqual(240);
      expect(reason).not.toContain(error.url);
      if (explanation.length !== 0) expect(reason.endsWith("…")).toBe(true);
    },
  );
});
