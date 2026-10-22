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
  SpatialSkeletonActions,
  getSpatialSkeletonActionSupportLabel,
} from "#src/skeleton/edit_commands.js";
import {
  getSpatialSkeletonActionErrorMessage,
  isSpatialSkeletonInspectionRequiredError,
  SpatialSkeletonInspectionRequiredError,
} from "#src/skeleton/edit_queue/edit_errors.js";

describe("spatial skeleton edit errors", () => {
  it("preserves a typed inspection error as the user-facing action message", () => {
    const error = new SpatialSkeletonInspectionRequiredError(
      {
        segmentId: 11n,
        nodeId: 5n,
      },
      "snapshot-unavailable",
      getSpatialSkeletonActionSupportLabel(SpatialSkeletonActions.moveNodes),
    );

    expect(isSpatialSkeletonInspectionRequiredError(error)).toBe(true);
    expect(error).toMatchObject({ segmentId: 11n, nodeId: 5n });
    expect(getSpatialSkeletonActionErrorMessage("move node", error)).toEqual({
      message: "Inspect skeleton 11 before node movement.",
      requiresDismissal: false,
    });
  });

  it("tells a missing node apart from a skeleton that has not loaded yet", () => {
    const error = new SpatialSkeletonInspectionRequiredError(
      {
        segmentId: 11n,
        nodeId: 5n,
      },
      "node-unavailable",
    );

    expect(error.message).toBe(
      "Node 5 is not present in inspected skeleton 11. Re-inspect skeleton 11 before editing it.",
    );
    expect(error.reason).toBe("node-unavailable");
  });
});
