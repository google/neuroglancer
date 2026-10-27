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

import type { CatmaidSpatialSkeletonEditOperations } from "#src/datasource/catmaid/spatial_skeleton_edit/edit_operations.js";
import { CatmaidEditRequests } from "#src/datasource/catmaid/spatial_skeleton_edit/edit_requests.js";
import type { SpatialSkeletonEditRequestContext } from "#src/skeleton/edit_queue/api.js";
import { commitSpatialSkeletonEditRequest } from "#src/skeleton/edit_queue/api.js";
import { SpatialSkeletonEditConflictError } from "#src/skeleton/edit_queue/edit_errors.js";

function makeOperations(
  overrides: Partial<CatmaidSpatialSkeletonEditOperations> = {},
): CatmaidSpatialSkeletonEditOperations {
  return {
    editRequestScope: {},
    commitAddNode: vi.fn(async () => ({ nodeId: 101n, segmentId: 10n })),
    commitInsertNode: vi.fn(async () => ({ nodeId: 102n, segmentId: 10n })),
    commitMoveNode: vi.fn(async () => undefined),
    commitDeleteNode: vi.fn(async () => undefined),
    commitReroot: vi.fn(async () => undefined),
    commitDescription: vi.fn(async () => ({})),
    commitTrueEnd: vi.fn(async () => undefined),
    commitRadius: vi.fn(async () => undefined),
    commitConfidence: vi.fn(async () => undefined),
    commitMerge: vi.fn(async () => ({
      resultSegmentId: 10n,
      deletedSegmentId: 20n,
      directionAdjusted: false,
    })),
    commitSplit: vi.fn(async () => ({
      existingSegmentId: 10n,
      newSegmentId: 20n,
    })),
    ...overrides,
  };
}

const context: SpatialSkeletonEditRequestContext = {
  intent: "execute",
  operationId: 7,
};

describe("CatmaidEditRequests", () => {
  it("sends a move to CATMAID with the node and position the edit asked for", async () => {
    const result = undefined;
    const commitMoveNode = vi.fn(async () => result);
    const adapter = new CatmaidEditRequests(makeOperations({ commitMoveNode }));

    await expect(
      commitSpatialSkeletonEditRequest(
        adapter,
        {
          kind: "move-node",
          request: {
            nodeId: 4n,
            position: new Float32Array([8, 9, 10]),
          },
        },
        context,
      ),
    ).resolves.toEqual({ status: "committed", result });
    expect(commitMoveNode).toHaveBeenCalledWith({
      nodeId: 4n,
      position: new Float32Array([8, 9, 10]),
    });
  });

  it("a sent edit gets no cancellation signal, so it cannot be cancelled", async () => {
    const controller = new AbortController();
    const commitAddNode = vi.fn(async () => ({ nodeId: 1n, segmentId: 2n }));
    const adapter = new CatmaidEditRequests(makeOperations({ commitAddNode }));

    await commitSpatialSkeletonEditRequest(
      adapter,
      {
        kind: "add-node",
        request: {
          position: new Float32Array([1, 2, 3]),
        },
      },
      { ...context, signal: controller.signal },
    );
    expect(commitAddNode).toHaveBeenCalledWith({
      position: new Float32Array([1, 2, 3]),
    });
  });

  it("reports a CATMAID conflict as rejected and a lost connection as possibly saved", async () => {
    const conflict = new SpatialSkeletonEditConflictError("stale");
    const uncertain = new Error("connection disappeared");
    const rejectConflict = new CatmaidEditRequests(
      makeOperations({
        commitMoveNode: vi.fn(async () => Promise.reject(conflict)),
      }),
    );
    const rejectUncertain = new CatmaidEditRequests(
      makeOperations({
        commitMoveNode: vi.fn(async () => Promise.reject(uncertain)),
      }),
    );
    const editRequest = {
      kind: "move-node" as const,
      request: {
        nodeId: 4n,
        position: new Float32Array([8, 9, 10]),
      },
    };

    await expect(
      commitSpatialSkeletonEditRequest(rejectConflict, editRequest, context),
    ).resolves.toEqual({ status: "rejected", error: conflict });
    await expect(
      commitSpatialSkeletonEditRequest(rejectUncertain, editRequest, context),
    ).resolves.toEqual({ status: "indeterminate", error: uncertain });
  });

  it("reports cancellation before dispatch as not started", async () => {
    const commitMoveNode = vi.fn(async () => undefined);
    const adapter = new CatmaidEditRequests(makeOperations({ commitMoveNode }));
    const controller = new AbortController();
    controller.abort("disposed");

    const outcome = await commitSpatialSkeletonEditRequest(
      adapter,
      {
        kind: "move-node",
        request: {
          nodeId: 4n,
          position: new Float32Array([8, 9, 10]),
        },
      },
      { ...context, signal: controller.signal },
    );
    expect(outcome.status).toBe("not-started");
    expect(commitMoveNode).not.toHaveBeenCalled();
  });
});
