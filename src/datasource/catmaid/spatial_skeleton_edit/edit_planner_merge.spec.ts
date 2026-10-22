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
  CatmaidSpatialSkeletonCommandDescriptor,
  CatmaidEditPlan,
} from "#src/datasource/catmaid/spatial_skeleton_edit/edit_planner.js";
import { CatmaidEditPlanner } from "#src/datasource/catmaid/spatial_skeleton_edit/edit_planner.js";
import type {
  CatmaidEditRequest,
  CatmaidEditRequestResult,
} from "#src/datasource/catmaid/spatial_skeleton_edit/edit_requests.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonActions } from "#src/skeleton/edit_commands.js";
import { createCompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";
import type { SpatialSkeletonEditInverseDelta } from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import type {
  SpatialSkeletonAuthoritativeReconciliation,
  SpatialSkeletonPreviewIntentDelta,
} from "#src/skeleton/edit_queue/preview.js";
import type { SpatialSkeletonQueueInput } from "#src/skeleton/edit_queue/queue_input.js";
import type {
  SpatialSkeletonStableNodeHandle,
  SpatialSkeletonStableSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import {
  spatialSkeletonStableNode,
  spatialSkeletonStableSegment,
} from "#src/skeleton/edit_queue/stable_id_handles.js";

class TestIdentities {
  private readonly nodeHandles = new Map<
    bigint,
    SpatialSkeletonStableNodeHandle
  >();
  private readonly segmentHandles = new Map<
    bigint,
    SpatialSkeletonStableSegmentHandle
  >();
  private readonly nodeBindings = new Map<string, bigint>();
  private readonly segmentBindings = new Map<string, bigint>();

  getOrCreateNodeHandle(nodeId: bigint) {
    let handle = this.nodeHandles.get(nodeId);
    if (handle === undefined) {
      handle = spatialSkeletonStableNode(`authority:${nodeId}`);
      this.nodeHandles.set(nodeId, handle);
      this.nodeBindings.set(handle.stableId, nodeId);
    }
    return handle;
  }

  getOrCreateNodeHandles(nodeIds: readonly bigint[]) {
    return new Map(
      [...new Set(nodeIds)].map((nodeId) => [
        nodeId,
        this.getOrCreateNodeHandle(nodeId),
      ]),
    );
  }

  getOrCreateSegmentHandle(segmentId: bigint) {
    let handle = this.segmentHandles.get(segmentId);
    if (handle === undefined) {
      handle = spatialSkeletonStableSegment(`authority:${segmentId}`);
      this.segmentHandles.set(segmentId, handle);
      this.segmentBindings.set(handle.stableId, segmentId);
    }
    return handle;
  }

  resolveNode(handle: SpatialSkeletonStableNodeHandle) {
    return this.nodeBindings.get(handle.stableId);
  }

  resolveSegment(handle: SpatialSkeletonStableSegmentHandle) {
    return this.segmentBindings.get(handle.stableId);
  }

  resolveAuthoritativeNode = this.resolveNode;
  resolveAuthoritativeSegment = this.resolveSegment;

  resolveNodeTarget(handle: SpatialSkeletonStableNodeHandle) {
    const physicalId = this.resolveNode(handle);
    return physicalId === undefined
      ? ({ state: "unbound" } as const)
      : ({ state: "authoritative", physicalId } as const);
  }

  resolveSegmentTarget(handle: SpatialSkeletonStableSegmentHandle) {
    const physicalId = this.resolveSegment(handle);
    return physicalId === undefined
      ? ({ state: "unbound" } as const)
      : ({ state: "authoritative", physicalId } as const);
  }

  apply(reconciliation: SpatialSkeletonAuthoritativeReconciliation) {
    for (const [handle, physicalId] of reconciliation.bindings?.nodes ?? []) {
      this.nodeBindings.set(handle.stableId, physicalId);
      this.nodeHandles.set(physicalId, handle);
    }
    for (const [handle, physicalId] of reconciliation.bindings?.segments ??
      []) {
      this.segmentBindings.set(handle.stableId, physicalId);
      this.segmentHandles.set(physicalId, handle);
    }
  }
}

function node(
  nodeId: number,
  segmentId: number,
  parentNodeId?: number,
  attributes?: SkeletonNode["attributes"],
): SkeletonNode {
  return {
    nodeId: BigInt(nodeId),
    segmentId: BigInt(segmentId),
    parentNodeId: parentNodeId === undefined ? undefined : BigInt(parentNodeId),
    position: Object.freeze([nodeId, nodeId + 1, nodeId + 2]),
    attributes,
  };
}

function makePlanner(
  nodesBySegment: ReadonlyMap<bigint, readonly SkeletonNode[]>,
) {
  currentQueueInput = Object.freeze({
    segments: Object.freeze(
      [...nodesBySegment].map(([segmentId, nodes]) =>
        Object.freeze({
          segmentId,
          snapshot: createCompleteSkeleton(nodes),
          cacheRevision: Number(segmentId) + 100,
        }),
      ),
    ),
  });
  const identities = new TestIdentities();
  const planner = new CatmaidEditPlanner(identities, {
    allocateNodeId: (intentId) => BigInt(1_000_000 - intentId),
    allocateSegmentId: (intentId) => BigInt(2_000_000 - intentId),
  });
  return { planner, identities };
}

let currentQueueInput: SpatialSkeletonQueueInput = Object.freeze({
  segments: Object.freeze([]),
});

function command(
  action: CatmaidSpatialSkeletonCommandDescriptor["action"],
  label: string,
  payload: CatmaidSpatialSkeletonCommandDescriptor["payload"],
): CatmaidSpatialSkeletonCommandDescriptor {
  return Object.freeze({
    action,
    label,
    payload,
    getQueueInputRequirements: () =>
      Object.freeze({ required: Object.freeze([]) }),
  });
}

function context(
  intentId: number,
  intent: "execute" | "undo" | "redo",
  recipe?: {
    readonly plan: ReturnType<CatmaidEditPlanner["planIntent"]>["plan"];
    readonly preview: SpatialSkeletonPreviewIntentDelta;
    readonly inversePreview?: SpatialSkeletonEditInverseDelta;
  },
) {
  if (intent === "execute") {
    return { intentId, intent, queueInput: currentQueueInput } as any;
  }
  if (recipe === undefined) throw new Error(`${intent} requires a recipe.`);
  return { intentId, intent, recipe } as any;
}

type CanonicalAttempt = Readonly<{
  editRequest: CatmaidEditRequest;
  result: CatmaidEditRequestResult;
}>;

function planContext(
  intentId: number,
  intent: "execute" | "undo" | "redo",
  committedAttempts: readonly CanonicalAttempt[],
) {
  return {
    intentId,
    intent,
    committedAttempts: Object.freeze([...committedAttempts]),
  } as any;
}

function commitNextAttempt(
  planner: CatmaidEditPlanner,
  plan: CatmaidEditPlan,
  result: CatmaidEditRequestResult,
  attempts: CanonicalAttempt[],
  intent: "execute" | "undo" | "redo" = "execute",
) {
  const before = planContext(1, intent, attempts);
  const next = planner.nextAttempt(plan, before);
  if (next === undefined) throw new Error("Expected a CATMAID attempt.");
  const editRequest = next.materializeEditRequest();
  if (editRequest instanceof Promise) {
    throw new Error("CATMAID test materialization must be synchronous.");
  }
  attempts.push(Object.freeze({ editRequest, result }));
  return editRequest;
}

describe("CatmaidEditPlanner merge", () => {
  it("binds both merge identities to CATMAID's reversed survivor", () => {
    const { planner, identities } = makePlanner(
      new Map([
        [11n, [node(101, 11)]],
        [17n, [node(201, 17)]],
      ]),
    );
    const logical = planner.planIntent(
      command(SpatialSkeletonActions.mergeSkeletons, "Merge skeletons", {
        kind: "merge",
        options: {
          firstNode: { nodeId: 101n, segmentId: 11n },
          secondNode: { nodeId: 201n, segmentId: 17n },
        },
      }),
      context(1, "execute"),
    );
    identities.apply({
      bindings: logical.preview.inspectionSeed?.authoritativeBindings,
    });
    const attempts: CanonicalAttempt[] = [];
    expect(
      commitNextAttempt(
        planner,
        logical.plan,
        {
          resultSegmentId: 17n,
          deletedSegmentId: 11n,
          directionAdjusted: true,
        } as any,
        attempts,
      ),
    ).toMatchObject({
      kind: "merge",
      request: {
        fromNodeId: 101n,
        toNodeId: 201n,
      },
    });
    const reconciliation = planner.createReconciliation(
      logical.plan,
      planContext(1, "execute", attempts),
    );
    identities.apply(reconciliation);
    const merge = logical.preview.delta as any;

    expect(identities.resolveSegment(merge.firstSegment)).toBe(17n);
    expect(identities.resolveSegment(merge.secondSegment)).toBe(17n);
    expect(identities.resolveSegment(merge.resultSegment)).toBe(17n);
    expect(merge.resultSegment.stableId).not.toBe(merge.firstSegment.stableId);
    expect(merge.resultSegment.stableId).not.toBe(merge.secondSegment.stableId);
    expect(reconciliation.retiredResources).toEqual([]);
    expect(reconciliation.finalizedPreviewDelta).toMatchObject({
      kind: "merge",
      firstSegment: merge.secondSegment,
      secondSegment: merge.firstSegment,
      resultSegment: merge.resultSegment,
      firstNode: merge.secondNode,
      secondNode: merge.firstNode,
    });
    expect(logical.preview.uiHints).toMatchObject({
      segmentMembershipRemaps: [
        {
          from: { stableId: "authority:11" },
          to: { stableId: "intent:1:merge-output" },
        },
        {
          from: { stableId: "authority:17" },
          to: { stableId: "intent:1:merge-output" },
        },
      ],
      segmentVisibility: [
        { segment: { stableId: "intent:1:merge-output" }, visible: true },
        { segment: { stableId: "authority:17" }, visible: false },
      ],
      selectedNode: {
        kind: "select",
        node: { stableId: "authority:201" },
        segment: { stableId: "intent:1:merge-output" },
      },
    });
  });

  it("honors CATMAID merge orientation in both canonical directions", () => {
    const makeMerge = () => {
      const setup = makePlanner(
        new Map([
          [11n, [node(100, 11), node(101, 11, 100)]],
          [17n, [node(200, 17), node(201, 17, 200)]],
        ]),
      );
      const descriptor = command(
        SpatialSkeletonActions.mergeSkeletons,
        "Merge",
        {
          kind: "merge",
          options: {
            firstNode: { nodeId: 101n, segmentId: 11n },
            secondNode: { nodeId: 201n, segmentId: 17n },
          },
        },
      );
      const execute = setup.planner.planIntent(
        descriptor,
        context(1, "execute"),
      );
      return { ...setup, descriptor, execute };
    };

    for (const directionAdjusted of [false, true]) {
      const { planner, execute } = makeMerge();
      const attempts: CanonicalAttempt[] = [];
      const resultSegmentId = directionAdjusted ? 17n : 11n;
      const deletedSegmentId = directionAdjusted ? 11n : 17n;
      commitNextAttempt(
        planner,
        execute.plan,
        { resultSegmentId, deletedSegmentId, directionAdjusted } as any,
        attempts,
      );
      const reconciliation = planner.createReconciliation(
        execute.plan,
        planContext(1, "execute", attempts),
      );
      expect(reconciliation.retiredSegmentIds).toEqual([deletedSegmentId]);
      expect(reconciliation.finalizedPreviewDelta === undefined).toBe(
        !directionAdjusted,
      );
    }

    for (const directionAdjusted of [false, true]) {
      const { planner, descriptor, execute } = makeMerge();
      const semantic = execute.plan.semantic;
      if (semantic.kind !== "merge")
        throw new Error("Expected merge semantic.");
      const inversePreview = {
        kind: "unmerge",
        mergedSegment: semantic.mergedSegment,
        firstSegment: semantic.secondSegment,
        secondSegment: semantic.firstSegment,
        firstNode: semantic.secondNode,
        secondNode: semantic.firstNode,
        formerSecondTopology: [
          { node: semantic.firstNode, parent: null, confidence: undefined },
        ],
      } as SpatialSkeletonEditInverseDelta;
      const redo = planner.planIntent(
        descriptor,
        context(3, "redo", {
          plan: execute.plan,
          preview: execute.preview,
          inversePreview,
        }),
      );
      const attempts: CanonicalAttempt[] = [];
      expect(
        commitNextAttempt(
          planner,
          redo.plan,
          {
            resultSegmentId: directionAdjusted ? 11n : 17n,
            deletedSegmentId: directionAdjusted ? 17n : 11n,
            directionAdjusted,
          } as any,
          attempts,
          "redo",
        ),
      ).toMatchObject({
        kind: "merge",
        request: { fromNodeId: 201n, toNodeId: 101n },
      });
      const reconciliation = planner.createReconciliation(
        redo.plan,
        planContext(3, "redo", attempts),
      );
      expect(reconciliation.retiredSegmentIds).toEqual([
        directionAdjusted ? 17n : 11n,
      ]);
      expect(reconciliation.finalizedPreviewDelta === undefined).toBe(
        !directionAdjusted,
      );
    }
  });

  it.each([false, true])(
    "retires the Split Undo target or rejects a reversed Merge (direction adjusted: %s)",
    (directionAdjusted) => {
      const nodes = [node(1, 23), node(2, 23, 1)];
      const { planner, identities } = makePlanner(new Map([[23n, nodes]]));
      const descriptor = command(
        SpatialSkeletonActions.splitSkeletons,
        "Split",
        {
          kind: "split",
          node: nodes[1],
        },
      );
      const execute = planner.planIntent(descriptor, context(1, "execute"));
      const semantic = execute.plan.semantic;
      if (semantic.kind !== "split")
        throw new Error("Expected split semantic.");
      identities.apply({
        bindings: {
          segments: [
            [semantic.sourceSegment, 23n],
            [semantic.downstreamSegment, 24n],
          ],
        },
      });
      const undo = planner.planIntent(
        descriptor,
        context(2, "undo", {
          plan: execute.plan,
          preview: execute.preview,
          inversePreview: {
            kind: "join-split",
            sourceSegment: semantic.sourceSegment,
            downstreamSegment: semantic.downstreamSegment,
            resultSegment: semantic.sourceSegment,
            formerParent: semantic.formerParent,
            node: semantic.node,
          },
        }),
      );
      const attempts: CanonicalAttempt[] = [];
      commitNextAttempt(
        planner,
        undo.plan,
        {
          resultSegmentId: directionAdjusted ? 24n : 23n,
          deletedSegmentId: directionAdjusted ? 23n : 24n,
          directionAdjusted,
        } as any,
        attempts,
        "undo",
      );
      const reconcile = () =>
        planner.createReconciliation(
          undo.plan,
          planContext(2, "undo", attempts),
        );
      if (directionAdjusted) {
        expect(reconcile).toThrow(
          /reversed the merge used to undo a split.*reload is required/i,
        );
      } else {
        expect(reconcile()).toMatchObject({
          bindings: {
            segments: [
              [semantic.sourceSegment, 23n],
              [semantic.downstreamSegment, 23n],
            ],
          },
          retiredResources: [],
          retiredSegmentIds: [24n],
        });
      }
    },
  );

  it("derives reversed merge Undo and Redo orientation from the retained canonical inverse", () => {
    const { planner, identities } = makePlanner(
      new Map([
        [11n, [node(101, 11)]],
        [17n, [node(201, 17)]],
      ]),
    );
    const descriptor = command(
      SpatialSkeletonActions.mergeSkeletons,
      "Merge skeletons",
      {
        kind: "merge",
        options: {
          firstNode: { nodeId: 101n, segmentId: 11n },
          secondNode: { nodeId: 201n, segmentId: 17n },
        },
      },
    );
    const execute = planner.planIntent(descriptor, context(1, "execute"));
    const semantic = execute.plan.semantic;
    if (semantic.kind !== "merge") throw new Error("Expected merge semantic.");
    identities.apply({
      bindings: {
        segments: [
          [semantic.firstSegment, 99n],
          [semantic.secondSegment, 99n],
          [semantic.mergedSegment, 99n],
        ],
      },
    });
    const inversePreview = {
      kind: "unmerge",
      mergedSegment: semantic.mergedSegment,
      firstSegment: semantic.secondSegment,
      secondSegment: semantic.firstSegment,
      firstNode: semantic.secondNode,
      secondNode: semantic.firstNode,
      formerSecondTopology: [
        { node: semantic.firstNode, parent: null, confidence: undefined },
      ],
    } as SpatialSkeletonEditInverseDelta;
    const undo = planner.planIntent(
      descriptor,
      context(2, "undo", {
        plan: execute.plan,
        preview: execute.preview,
        inversePreview,
      }),
    );

    expect(undo.plan.semantic).toMatchObject({
      kind: "merge",
      inverseOrientation: "first-from-second",
      originalRoot: semantic.firstNode,
      originalRootConfidence: undefined,
    });
    expect(undo.preview.delta).toBe(inversePreview);
    const splitBack = planner.nextAttempt(
      undo.plan,
      planContext(2, "undo", []),
    );
    expect(splitBack?.materializeEditRequest()).toMatchObject({
      kind: "split",
      request: { nodeId: 101n },
    });

    const redo = planner.planIntent(
      descriptor,
      context(3, "redo", {
        plan: execute.plan,
        preview: execute.preview,
        inversePreview,
      }),
    );
    expect(redo.plan.semantic).toMatchObject({
      kind: "merge",
      inverseOrientation: "first-from-second",
    });
    expect(redo.preview.delta).toMatchObject({
      kind: "merge",
      firstSegment: semantic.secondSegment,
      secondSegment: semantic.firstSegment,
      firstNode: semantic.secondNode,
      secondNode: semantic.firstNode,
    });
    const redoAttempt = planner.nextAttempt(
      redo.plan,
      planContext(3, "redo", []),
    );
    expect(redoAttempt?.materializeEditRequest()).toMatchObject({
      kind: "merge",
      request: {
        fromNodeId: 201n,
        toNodeId: 101n,
      },
    });
  });

  it("retries a coalesced Merge without an inverse using its original orientation", () => {
    const { planner } = makePlanner(
      new Map([
        [11n, [node(101, 11)]],
        [17n, [node(201, 17)]],
      ]),
    );
    const descriptor = command(
      SpatialSkeletonActions.mergeSkeletons,
      "Merge skeletons",
      {
        kind: "merge",
        options: {
          firstNode: { nodeId: 101n, segmentId: 11n },
          secondNode: { nodeId: 201n, segmentId: 17n },
        },
      },
    );
    const execute = planner.planIntent(descriptor, context(1, "execute"));
    const redo = planner.planIntent(
      descriptor,
      context(3, "redo", {
        plan: execute.plan,
        preview: execute.preview,
      }),
    );

    expect(redo.plan.semantic).toMatchObject({
      kind: "merge",
      inverseOrientation: "second-from-first",
    });
    expect(redo.preview.delta).toStrictEqual(execute.preview.delta);
  });
});
