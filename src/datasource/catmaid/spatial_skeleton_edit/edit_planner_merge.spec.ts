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
  CatmaidSpatialSkeletonWorkflowDriver,
  type CatmaidSpatialSkeletonCommandDescriptor,
  type CatmaidWorkflow,
} from "#src/datasource/catmaid/spatial_skeleton_edit/edit_planner.js";
import type {
  CatmaidOptimisticMutation,
  CatmaidOptimisticMutationResult,
} from "#src/datasource/catmaid/spatial_skeleton_edit/edit_requests.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonQueueInput,
} from "#src/skeleton/edit/command_protocol.js";
import { createCompleteSkeletonSnapshot } from "#src/skeleton/edit_queue/complete_skeleton.js";
import type { SpatialSkeletonProjectionInverseDelta } from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import type {
  SpatialSkeletonAuthoritativeReconciliation,
  SpatialSkeletonProjectionIntentDelta,
} from "#src/skeleton/edit_queue/preview.js";
import {
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
  type SpatialSkeletonLogicalNodeHandle,
  type SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";

class TestIdentities {
  private readonly nodeHandles = new Map<
    bigint,
    SpatialSkeletonLogicalNodeHandle
  >();
  private readonly segmentHandles = new Map<
    bigint,
    SpatialSkeletonLogicalSegmentHandle
  >();
  private readonly nodeBindings = new Map<string, bigint>();
  private readonly segmentBindings = new Map<string, bigint>();

  getOrCreateNodeHandle(nodeId: bigint) {
    let handle = this.nodeHandles.get(nodeId);
    if (handle === undefined) {
      handle = spatialSkeletonLogicalNode(`authority:${nodeId}`);
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
      handle = spatialSkeletonLogicalSegment(`authority:${segmentId}`);
      this.segmentHandles.set(segmentId, handle);
      this.segmentBindings.set(handle.stableId, segmentId);
    }
    return handle;
  }

  resolveNode(handle: SpatialSkeletonLogicalNodeHandle) {
    return this.nodeBindings.get(handle.stableId);
  }

  resolveSegment(handle: SpatialSkeletonLogicalSegmentHandle) {
    return this.segmentBindings.get(handle.stableId);
  }

  resolveAuthoritativeNode = this.resolveNode;
  resolveAuthoritativeSegment = this.resolveSegment;

  resolveNodeTarget(handle: SpatialSkeletonLogicalNodeHandle) {
    const physicalId = this.resolveNode(handle);
    return physicalId === undefined
      ? ({ state: "unbound" } as const)
      : ({ state: "authoritative", physicalId } as const);
  }

  resolveSegmentTarget(handle: SpatialSkeletonLogicalSegmentHandle) {
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

function makeDriver(
  nodesBySegment: ReadonlyMap<bigint, readonly SkeletonNode[]>,
) {
  currentQueueInput = Object.freeze({
    segments: Object.freeze(
      [...nodesBySegment].map(([segmentId, nodes]) =>
        Object.freeze({
          segmentId,
          snapshot: createCompleteSkeletonSnapshot(nodes),
          cacheRevision: Number(segmentId) + 100,
        }),
      ),
    ),
  });
  const identities = new TestIdentities();
  const driver = new CatmaidSpatialSkeletonWorkflowDriver(identities, {
    allocateNodeId: (intentId) => BigInt(1_000_000 - intentId),
    allocateSegmentId: (intentId) => BigInt(2_000_000 - intentId),
  });
  return { driver, identities };
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
    readonly workflow: ReturnType<
      CatmaidSpatialSkeletonWorkflowDriver["createLogicalIntent"]
    >["workflow"];
    readonly projection: SpatialSkeletonProjectionIntentDelta;
    readonly inverseProjection?: SpatialSkeletonProjectionInverseDelta;
  },
) {
  if (intent === "execute") {
    return { intentId, intent, queueInput: currentQueueInput } as any;
  }
  if (recipe === undefined) throw new Error(`${intent} requires a recipe.`);
  return { intentId, intent, recipe } as any;
}

type CanonicalAttempt = Readonly<{
  mutation: CatmaidOptimisticMutation;
  result: CatmaidOptimisticMutationResult;
}>;

function workflowContext(
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
  driver: CatmaidSpatialSkeletonWorkflowDriver,
  workflow: CatmaidWorkflow,
  result: CatmaidOptimisticMutationResult,
  attempts: CanonicalAttempt[],
  intent: "execute" | "undo" | "redo" = "execute",
) {
  const before = workflowContext(1, intent, attempts);
  const next = driver.nextAttempt(workflow, before);
  if (next === undefined) throw new Error("Expected a CATMAID attempt.");
  const mutation = next.materializeMutation();
  if (mutation instanceof Promise) {
    throw new Error("CATMAID test materialization must be synchronous.");
  }
  attempts.push(Object.freeze({ mutation, result }));
  return mutation;
}

describe("CatmaidSpatialSkeletonWorkflowDriver merge", () => {
  it("binds both merge identities to CATMAID's reversed survivor", () => {
    const { driver, identities } = makeDriver(
      new Map([
        [11n, [node(101, 11)]],
        [17n, [node(201, 17)]],
      ]),
    );
    const logical = driver.createLogicalIntent(
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
      bindings: logical.projection.inspectionSeed?.authoritativeBindings,
    });
    const attempts: CanonicalAttempt[] = [];
    expect(
      commitNextAttempt(
        driver,
        logical.workflow,
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
    const reconciliation = driver.createReconciliation(
      logical.workflow,
      workflowContext(1, "execute", attempts),
    );
    identities.apply(reconciliation);
    const merge = logical.projection.delta as any;

    expect(identities.resolveSegment(merge.firstSegment)).toBe(17n);
    expect(identities.resolveSegment(merge.secondSegment)).toBe(17n);
    expect(identities.resolveSegment(merge.resultSegment)).toBe(17n);
    expect(merge.resultSegment.stableId).not.toBe(merge.firstSegment.stableId);
    expect(merge.resultSegment.stableId).not.toBe(merge.secondSegment.stableId);
    expect(reconciliation.retiredResources).toEqual([]);
    expect(reconciliation.finalizedProjectionDelta).toMatchObject({
      kind: "merge",
      firstSegment: merge.secondSegment,
      secondSegment: merge.firstSegment,
      resultSegment: merge.resultSegment,
      firstNode: merge.secondNode,
      secondNode: merge.firstNode,
    });
    expect(logical.projection.uiHints).toMatchObject({
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
      const setup = makeDriver(
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
      const execute = setup.driver.createLogicalIntent(
        descriptor,
        context(1, "execute"),
      );
      return { ...setup, descriptor, execute };
    };

    for (const directionAdjusted of [false, true]) {
      const { driver, execute } = makeMerge();
      const attempts: CanonicalAttempt[] = [];
      const resultSegmentId = directionAdjusted ? 17n : 11n;
      const deletedSegmentId = directionAdjusted ? 11n : 17n;
      commitNextAttempt(
        driver,
        execute.workflow,
        { resultSegmentId, deletedSegmentId, directionAdjusted } as any,
        attempts,
      );
      const reconciliation = driver.createReconciliation(
        execute.workflow,
        workflowContext(1, "execute", attempts),
      );
      expect(reconciliation.retiredSegmentIds).toEqual([deletedSegmentId]);
      expect(reconciliation.finalizedProjectionDelta === undefined).toBe(
        !directionAdjusted,
      );
    }

    for (const directionAdjusted of [false, true]) {
      const { driver, descriptor, execute } = makeMerge();
      const semantic = execute.workflow.semantic;
      if (semantic.kind !== "merge")
        throw new Error("Expected merge semantic.");
      const inverseProjection = {
        kind: "unmerge",
        mergedSegment: semantic.mergedSegment,
        firstSegment: semantic.secondSegment,
        secondSegment: semantic.firstSegment,
        firstNode: semantic.secondNode,
        secondNode: semantic.firstNode,
        formerSecondTopology: [
          { node: semantic.firstNode, parent: null, confidence: undefined },
        ],
      } as SpatialSkeletonProjectionInverseDelta;
      const redo = driver.createLogicalIntent(
        descriptor,
        context(3, "redo", {
          workflow: execute.workflow,
          projection: execute.projection,
          inverseProjection,
        }),
      );
      const attempts: CanonicalAttempt[] = [];
      expect(
        commitNextAttempt(
          driver,
          redo.workflow,
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
      const reconciliation = driver.createReconciliation(
        redo.workflow,
        workflowContext(3, "redo", attempts),
      );
      expect(reconciliation.retiredSegmentIds).toEqual([
        directionAdjusted ? 17n : 11n,
      ]);
      expect(reconciliation.finalizedProjectionDelta === undefined).toBe(
        !directionAdjusted,
      );
    }
  });

  it.each([false, true])(
    "retires the Split Undo target or rejects a reversed Merge (direction adjusted: %s)",
    (directionAdjusted) => {
      const nodes = [node(1, 23), node(2, 23, 1)];
      const { driver, identities } = makeDriver(new Map([[23n, nodes]]));
      const descriptor = command(
        SpatialSkeletonActions.splitSkeletons,
        "Split",
        {
          kind: "split",
          node: nodes[1],
        },
      );
      const execute = driver.createLogicalIntent(
        descriptor,
        context(1, "execute"),
      );
      const semantic = execute.workflow.semantic;
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
      const undo = driver.createLogicalIntent(
        descriptor,
        context(2, "undo", {
          workflow: execute.workflow,
          projection: execute.projection,
          inverseProjection: {
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
        driver,
        undo.workflow,
        {
          resultSegmentId: directionAdjusted ? 24n : 23n,
          deletedSegmentId: directionAdjusted ? 23n : 24n,
          directionAdjusted,
        } as any,
        attempts,
        "undo",
      );
      const reconcile = () =>
        driver.createReconciliation(
          undo.workflow,
          workflowContext(2, "undo", attempts),
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
    const { driver, identities } = makeDriver(
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
    const execute = driver.createLogicalIntent(
      descriptor,
      context(1, "execute"),
    );
    const semantic = execute.workflow.semantic;
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
    const inverseProjection = {
      kind: "unmerge",
      mergedSegment: semantic.mergedSegment,
      firstSegment: semantic.secondSegment,
      secondSegment: semantic.firstSegment,
      firstNode: semantic.secondNode,
      secondNode: semantic.firstNode,
      formerSecondTopology: [
        { node: semantic.firstNode, parent: null, confidence: undefined },
      ],
    } as SpatialSkeletonProjectionInverseDelta;
    const undo = driver.createLogicalIntent(
      descriptor,
      context(2, "undo", {
        workflow: execute.workflow,
        projection: execute.projection,
        inverseProjection,
      }),
    );

    expect(undo.workflow.semantic).toMatchObject({
      kind: "merge",
      inverseOrientation: "first-from-second",
      originalRoot: semantic.firstNode,
      originalRootConfidence: undefined,
    });
    expect(undo.projection.delta).toBe(inverseProjection);
    const splitBack = driver.nextAttempt(
      undo.workflow,
      workflowContext(2, "undo", []),
    );
    expect(splitBack?.materializeMutation()).toMatchObject({
      kind: "split",
      request: { nodeId: 101n },
    });

    const redo = driver.createLogicalIntent(
      descriptor,
      context(3, "redo", {
        workflow: execute.workflow,
        projection: execute.projection,
        inverseProjection,
      }),
    );
    expect(redo.workflow.semantic).toMatchObject({
      kind: "merge",
      inverseOrientation: "first-from-second",
    });
    expect(redo.projection.delta).toMatchObject({
      kind: "merge",
      firstSegment: semantic.secondSegment,
      secondSegment: semantic.firstSegment,
      firstNode: semantic.secondNode,
      secondNode: semantic.firstNode,
    });
    const redoAttempt = driver.nextAttempt(
      redo.workflow,
      workflowContext(3, "redo", []),
    );
    expect(redoAttempt?.materializeMutation()).toMatchObject({
      kind: "merge",
      request: {
        fromNodeId: 201n,
        toNodeId: 101n,
      },
    });
  });

  it("retries a coalesced Merge without an inverse using its original orientation", () => {
    const { driver } = makeDriver(
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
    const execute = driver.createLogicalIntent(
      descriptor,
      context(1, "execute"),
    );
    const redo = driver.createLogicalIntent(
      descriptor,
      context(3, "redo", {
        workflow: execute.workflow,
        projection: execute.projection,
      }),
    );

    expect(redo.workflow.semantic).toMatchObject({
      kind: "merge",
      inverseOrientation: "second-from-first",
    });
    expect(redo.projection.delta).toStrictEqual(execute.projection.delta);
  });
});
