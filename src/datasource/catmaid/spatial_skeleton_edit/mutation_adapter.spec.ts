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
import { CatmaidSpatialSkeletonOptimisticMutationAdapter } from "#src/datasource/catmaid/spatial_skeleton_edit/mutation_adapter.js";
import { SpatialSkeletonEditConflictError } from "#src/skeleton/edit_errors.js";
import {
  commitSpatialSkeletonMutation,
  type SpatialSkeletonMutationContext,
} from "#src/skeleton/optimistic_edit/api.js";

function makeOperations(
  overrides: Partial<CatmaidSpatialSkeletonEditOperations> = {},
): CatmaidSpatialSkeletonEditOperations {
  return {
    mutationScope: {},
    commitAddNode: vi.fn(async () => ({ nodeId: 101, segmentId: 10 })),
    commitInsertNode: vi.fn(async () => ({ nodeId: 102, segmentId: 10 })),
    commitMoveNode: vi.fn(async () => undefined),
    commitDeleteNode: vi.fn(async () => undefined),
    commitReroot: vi.fn(async () => undefined),
    commitDescription: vi.fn(async () => ({})),
    commitTrueEnd: vi.fn(async () => undefined),
    commitRadius: vi.fn(async () => undefined),
    commitConfidence: vi.fn(async () => undefined),
    commitMerge: vi.fn(async () => ({
      resultSegmentId: 10,
      deletedSegmentId: 20,
      directionAdjusted: false,
    })),
    commitSplit: vi.fn(async () => ({
      existingSegmentId: 10,
      newSegmentId: 20,
    })),
    ...overrides,
  };
}

const context: SpatialSkeletonMutationContext = {
  intent: "execute",
  operationId: 7,
};

describe("CATMAID optimistic mutation adapter", () => {
  it("does not expose physical mutation-resource scheduling", () => {
    const adapter = new CatmaidSpatialSkeletonOptimisticMutationAdapter(
      makeOperations(),
    );
    expect("getMutationResources" in adapter).toBe(false);
    expect("mutationResources" in adapter).toBe(false);
  });

  it("maps a semantic queue mutation to CATMAID's unchecked transport", async () => {
    const result = undefined;
    const commitMoveNode = vi.fn(async () => result);
    const adapter = new CatmaidSpatialSkeletonOptimisticMutationAdapter(
      makeOperations({ commitMoveNode }),
    );

    await expect(
      commitSpatialSkeletonMutation(
        adapter,
        {
          kind: "move-node",
          request: {
            nodeId: 4,
            position: new Float32Array([8, 9, 10]),
          },
        },
        context,
      ),
    ).resolves.toEqual({ status: "committed", result });
    expect(commitMoveNode).toHaveBeenCalledWith({
      nodeId: 4,
      position: new Float32Array([8, 9, 10]),
    });
  });

  it("uses the generic cancellation signal only before CATMAID dispatch", async () => {
    const controller = new AbortController();
    const commitAddNode = vi.fn(async () => ({ nodeId: 1, segmentId: 2 }));
    const adapter = new CatmaidSpatialSkeletonOptimisticMutationAdapter(
      makeOperations({ commitAddNode }),
    );

    await commitSpatialSkeletonMutation(
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

  it("normalizes definitive CATMAID rejection and uncertain failures", async () => {
    const conflict = new SpatialSkeletonEditConflictError("stale");
    const uncertain = new Error("connection disappeared");
    const rejectConflict = new CatmaidSpatialSkeletonOptimisticMutationAdapter(
      makeOperations({
        commitMoveNode: vi.fn(async () => Promise.reject(conflict)),
      }),
    );
    const rejectUncertain = new CatmaidSpatialSkeletonOptimisticMutationAdapter(
      makeOperations({
        commitMoveNode: vi.fn(async () => Promise.reject(uncertain)),
      }),
    );
    const mutation = {
      kind: "move-node" as const,
      request: {
        nodeId: 4,
        position: new Float32Array([8, 9, 10]),
      },
    };

    await expect(
      commitSpatialSkeletonMutation(rejectConflict, mutation, context),
    ).resolves.toEqual({ status: "rejected", error: conflict });
    await expect(
      commitSpatialSkeletonMutation(rejectUncertain, mutation, context),
    ).resolves.toEqual({ status: "indeterminate", error: uncertain });
  });

  it("reports cancellation before dispatch as not started", async () => {
    const commitMoveNode = vi.fn(async () => undefined);
    const adapter = new CatmaidSpatialSkeletonOptimisticMutationAdapter(
      makeOperations({ commitMoveNode }),
    );
    const controller = new AbortController();
    controller.abort("disposed");

    const outcome = await commitSpatialSkeletonMutation(
      adapter,
      {
        kind: "move-node",
        request: {
          nodeId: 4,
          position: new Float32Array([8, 9, 10]),
        },
      },
      { ...context, signal: controller.signal },
    );
    expect(outcome.status).toBe("not-started");
    expect(commitMoveNode).not.toHaveBeenCalled();
  });

  it("uses the datasource's stable mutation scope", () => {
    const mutationScope = {};
    const adapter = new CatmaidSpatialSkeletonOptimisticMutationAdapter(
      makeOperations({ mutationScope }),
    );

    expect(adapter.mutationScope).toBe(mutationScope);
  });
});
