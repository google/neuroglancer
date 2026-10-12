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
  CatmaidOptimisticMutation,
  CatmaidOptimisticMutationResult,
} from "#src/datasource/catmaid/spatial_skeleton_edit/mutation_adapter.js";
import {
  CatmaidSpatialSkeletonWorkflowDriver,
  getCatmaidOptimisticAuthorityPresentation,
  type CatmaidSpatialSkeletonCommandDescriptor,
  type CatmaidWorkflow,
} from "#src/datasource/catmaid/spatial_skeleton_edit/workflow_driver.js";
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonQueueInput,
} from "#src/skeleton/command_protocol.js";
import { createCompleteSkeletonSnapshot } from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
  type SpatialSkeletonLogicalNodeHandle,
  type SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import type {
  SpatialSkeletonAuthoritativeReconciliation,
  SpatialSkeletonProjectionIntentDelta,
} from "#src/skeleton/optimistic_edit/projection_runtime.js";
import type { SpatialSkeletonProjectionInverseDelta } from "#src/skeleton/spatial_skeleton_projection_reducer.js";

class TestIdentities {
  private readonly nodeHandles = new Map<
    number,
    SpatialSkeletonLogicalNodeHandle
  >();
  private readonly segmentHandles = new Map<
    number,
    SpatialSkeletonLogicalSegmentHandle
  >();
  private readonly nodeBindings = new Map<string, number>();
  private readonly segmentBindings = new Map<string, number>();

  getOrCreateNodeHandle(nodeId: number) {
    let handle = this.nodeHandles.get(nodeId);
    if (handle === undefined) {
      handle = spatialSkeletonLogicalNode(`authority:${nodeId}`);
      this.nodeHandles.set(nodeId, handle);
      this.nodeBindings.set(handle.stableId, nodeId);
    }
    return handle;
  }

  getOrCreateNodeHandles(nodeIds: readonly number[]) {
    return new Map(
      [...new Set(nodeIds)].map((nodeId) => [
        nodeId,
        this.getOrCreateNodeHandle(nodeId),
      ]),
    );
  }

  getOrCreateSegmentHandle(segmentId: number) {
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
): SpatiallyIndexedSkeletonNode {
  return {
    nodeId,
    segmentId,
    parentNodeId,
    position: Object.freeze([nodeId, nodeId + 1, nodeId + 2]),
  };
}

function makeDriver(
  nodesBySegment: ReadonlyMap<number, readonly SpatiallyIndexedSkeletonNode[]>,
) {
  currentQueueInput = Object.freeze({
    segments: Object.freeze(
      [...nodesBySegment].map(([segmentId, nodes]) =>
        Object.freeze({
          segmentId,
          snapshot: createCompleteSkeletonSnapshot(nodes),
          cacheRevision: segmentId + 100,
        }),
      ),
    ),
  });
  const identities = new TestIdentities();
  const driver = new CatmaidSpatialSkeletonWorkflowDriver(identities, {
    allocateNodeId: (intentId) => 1_000_000 - intentId,
    allocateSegmentId: (intentId) => 2_000_000 - intentId,
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

describe("CatmaidSpatialSkeletonWorkflowDriver", () => {
  it("provides exact CATMAID operation nouns and one immutable stall policy", () => {
    const expected = {
      "add-node": "node creation",
      "move-node": "node movement",
      "delete-node": "node deletion",
      reroot: "skeleton rerooting",
      split: "skeleton splitting",
      merge: "skeleton merging",
      description: "node description editing",
      "true-end": "node true-end editing",
      radius: "node radius editing",
      confidence: "node confidence editing",
    } as const;

    for (const [kind, operationNoun] of Object.entries(expected)) {
      expect(
        getCatmaidOptimisticAuthorityPresentation(
          kind as keyof typeof expected,
        ),
      ).toMatchObject({
        authorityLabel: "CATMAID",
        operationNoun,
        stalledWarning: {
          delayMs: 30_000,
          message:
            "CATMAID has not confirmed the optimistic skeleton edit yet. The server mutation lane is stalled, but you may continue previewing independent edits while the request remains in order.",
        },
      });
    }
  });

  it("builds a move entirely from queue input and clears an omitted token", () => {
    const original = node(2, 23, 1);
    const { driver } = makeDriver(new Map([[23, [node(1, 23), original]]]));
    const logical = driver.createLogicalIntent(
      command(SpatialSkeletonActions.moveNodes, "Move node", {
        kind: "move-node",
        options: {
          node: original,
          nextPositionInModelSpace: Object.freeze([10, 11, 12]),
        },
      }),
      context(1, "execute"),
    );

    expect(logical.kind).toBe("moveNode");
    expect(logical.projection.delta).toMatchObject({
      kind: "move",
      position: [10, 11, 12],
    });
    expect(logical.workflow).not.toHaveProperty("projection");
    expect(logical.workflow).not.toHaveProperty("resources");

    const attempts: CanonicalAttempt[] = [];
    const mutation = commitNextAttempt(
      driver,
      logical.workflow,
      {} as any,
      attempts,
    );
    expect(mutation).toMatchObject({
      kind: "move-node",
      request: {
        nodeId: 2,
        position: [10, 11, 12],
      },
    });
    const reconciliation = driver.createReconciliation(
      logical.workflow,
      workflowContext(1, "execute", attempts),
    );
    expect(reconciliation).toEqual({
      bindings: { nodes: [], segments: [] },
      retiredResources: [],
    });
  });

  it("rejects Execute when its admitted inspected bundle is incomplete", () => {
    const original = node(2, 23, 1);
    const { driver } = makeDriver(new Map([[23, [node(1, 23), original]]]));
    const descriptor = command(SpatialSkeletonActions.moveNodes, "Move node", {
      kind: "move-node",
      options: {
        node: original,
        nextPositionInModelSpace: Object.freeze([10, 11, 12]),
      },
    });

    expect(() =>
      driver.createLogicalIntent(descriptor, {
        intentId: 1,
        intent: "execute",
        queueInput: Object.freeze({ segments: Object.freeze([]) }),
      }),
    ).toThrow(/requires admitted complete skeleton 23/);
  });

  it("schedules CATMAID work exclusively by logical segment", () => {
    const { driver } = makeDriver(
      new Map([
        [11, [node(101, 11)]],
        [17, [node(201, 17)]],
        [23, [node(1, 23), node(2, 23, 1)]],
      ]),
    );
    const intents = [
      driver.createLogicalIntent(
        command(SpatialSkeletonActions.addNodes, "Add node", {
          kind: "add-node",
          options: {
            skeletonId: 23,
            parentNodeId: 1,
            positionInModelSpace: [1, 2, 3],
          },
        }),
        context(1, "execute"),
      ),
      driver.createLogicalIntent(
        command(SpatialSkeletonActions.moveNodes, "Move node", {
          kind: "move-node",
          options: {
            node: node(2, 23, 1),
            nextPositionInModelSpace: [4, 5, 6],
          },
        }),
        context(2, "execute"),
      ),
      driver.createLogicalIntent(
        command(SpatialSkeletonActions.splitSkeletons, "Split skeleton", {
          kind: "split",
          node: node(2, 23, 1),
        }),
        context(3, "execute"),
      ),
      driver.createLogicalIntent(
        command(SpatialSkeletonActions.mergeSkeletons, "Merge skeletons", {
          kind: "merge",
          options: {
            firstNode: { nodeId: 101, segmentId: 11 },
            secondNode: { nodeId: 201, segmentId: 17 },
          },
        }),
        context(4, "execute"),
      ),
    ];

    expect(
      intents.map((intent) =>
        intent.logicalResources.map(({ handle }) => handle.kind),
      ),
    ).toEqual([
      ["segment"],
      ["segment"],
      ["segment", "segment"],
      ["segment", "segment", "segment"],
    ]);
  });

  it("binds exactly the CATMAID nodes retained by each structural recipe without materializing snapshots", () => {
    const main = [
      node(1, 23),
      node(2, 23, 1),
      node(3, 23, 2),
      node(4, 23, 1),
      node(5, 23, 3),
    ];
    const first = [node(100, 11), node(101, 11, 100), node(102, 11, 100)];
    const second = [node(200, 17), node(201, 17, 200), node(202, 17, 201)];
    const { driver } = makeDriver(
      new Map([
        [23, main],
        [11, first],
        [17, second],
      ]),
    );
    const materializeSpies = currentQueueInput.segments.map(({ snapshot }) =>
      vi.spyOn(snapshot, "materialize"),
    );
    const retainedIds = (
      descriptor: CatmaidSpatialSkeletonCommandDescriptor,
      intentId: number,
    ) => {
      const intent = driver.createLogicalIntent(
        descriptor,
        context(intentId, "execute"),
      );
      const retainedNodes = intent.workflow.semantic.retainedNodes;
      expect(retainedNodes).toBeInstanceOf(Map);
      expect(
        [...retainedNodes].every(
          ([nodeId, retained]) => nodeId === retained.capturedNodeId,
        ),
      ).toBe(true);
      return {
        intent,
        ids: [...retainedNodes.keys()].sort((a, b) => a - b),
      };
    };

    expect(
      retainedIds(
        command(SpatialSkeletonActions.addNodes, "Add", {
          kind: "add-node",
          options: {
            skeletonId: 23,
            parentNodeId: 2,
            positionInModelSpace: [1, 2, 3],
          },
        }),
        1,
      ).ids,
    ).toEqual([2]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.moveNodes, "Move", {
          kind: "move-node",
          options: { node: main[2], nextPositionInModelSpace: [4, 5, 6] },
        }),
        2,
      ).ids,
    ).toEqual([3]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.editNodeDescription, "Description", {
          kind: "description",
          options: { node: main[2], nextDescription: "next" },
        }),
        3,
      ).ids,
    ).toEqual([3]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.addNodes, "Root Add", {
          kind: "add-node",
          options: {
            skeletonId: 0,
            parentNodeId: undefined,
            positionInModelSpace: [1, 2, 3],
          },
        }),
        4,
      ).ids,
    ).toEqual([]);

    expect(
      retainedIds(
        command(SpatialSkeletonActions.deleteNodes, "Delete", {
          kind: "delete-node",
          node: main[1],
        }),
        6,
      ).ids,
    ).toEqual([1, 2, 3]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.reroot, "Reroot", {
          kind: "reroot",
          node: main[2],
        }),
        7,
      ).ids,
    ).toEqual([1, 2, 3]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.splitSkeletons, "Split", {
          kind: "split",
          node: main[2],
        }),
        8,
      ).ids,
    ).toEqual([2, 3]);
    const merge = retainedIds(
      command(SpatialSkeletonActions.mergeSkeletons, "Merge", {
        kind: "merge",
        options: {
          firstNode: first[1],
          secondNode: second[1],
        },
      }),
      9,
    );
    expect(merge.ids).toEqual([100, 101, 200, 201]);
    expect(merge.intent.workflow.semantic).toMatchObject({});
    expect(materializeSpies.every((spy) => spy.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it.each([
    { input: "  normalized  ", normalized: "normalized" },
    { input: "ends", normalized: undefined },
    { input: "  \n\t", normalized: undefined },
    { input: "", normalized: undefined },
  ])(
    "uses the normalized description for canonical Undo and Redo: $input",
    ({ input, normalized }) => {
      const original = Object.freeze({
        ...node(2, 23, 1),
        description: "before",
      });
      const { driver } = makeDriver(new Map([[23, [node(1, 23), original]]]));
      const descriptor = command(
        SpatialSkeletonActions.editNodeDescription,
        "Edit description",
        {
          kind: "description",
          options: {
            node: original,
            nextDescription: input,
          },
        },
      );
      const execute = driver.createLogicalIntent(
        descriptor,
        context(1, "execute"),
      );
      const executeAttempts: CanonicalAttempt[] = [];
      expect(
        commitNextAttempt(
          driver,
          execute.workflow,
          { description: normalized } as any,
          executeAttempts,
        ),
      ).toMatchObject({
        kind: "description",
        request: { description: input },
      });
      const reconciliation = driver.createReconciliation(
        execute.workflow,
        workflowContext(1, "execute", executeAttempts),
      );
      expect(reconciliation.finalizedProjectionDelta).toMatchObject({
        kind: "node-attributes",
        changes: { description: normalized },
      });
      const executeDelta = execute.projection.delta;
      if (executeDelta.kind !== "node-attributes") {
        throw new Error("Expected a description projection.");
      }
      const canonicalProjection = Object.freeze({
        ...execute.projection,
        delta: reconciliation.finalizedProjectionDelta!,
      });
      const inverseProjection = Object.freeze({
        kind: "node-attributes" as const,
        segment: executeDelta.segment,
        node: executeDelta.node,
        changes: Object.freeze({ description: "before" }),
      });
      const recipe = {
        workflow: execute.workflow,
        projection: canonicalProjection,
        inverseProjection,
      };

      const undo = driver.createLogicalIntent(
        descriptor,
        context(2, "undo", recipe),
      );
      expect(undo.projection.delta).toBe(inverseProjection);
      const undoAttempts: CanonicalAttempt[] = [];
      expect(
        commitNextAttempt(
          driver,
          undo.workflow,
          { description: "before" } as any,
          undoAttempts,
          "undo",
        ),
      ).toMatchObject({
        kind: "description",
        request: { description: "before" },
      });

      const redo = driver.createLogicalIntent(
        descriptor,
        context(3, "redo", recipe),
      );
      expect(redo.projection.delta).toMatchObject({
        kind: "node-attributes",
        changes: { description: normalized },
      });
      const redoAttempts: CanonicalAttempt[] = [];
      expect(
        commitNextAttempt(
          driver,
          redo.workflow,
          { description: normalized } as any,
          redoAttempts,
          "redo",
        ),
      ).toMatchObject({
        kind: "description",
        request: { description: normalized ?? "" },
      });
    },
  );

  it.each([
    ["reroot", 0],
    ["reroot", 25],
    ["reroot", 100],
    ["merge", 0],
    ["merge", 25],
    ["merge", 100],
    ["reversed merge", 0],
    ["reversed merge", 25],
    ["reversed merge", 100],
  ] as const)(
    "restores %s root confidence %s using the current node ID",
    (kind, confidence) => {
      const first = [{ ...node(101, 11), confidence }, node(102, 11, 101)];
      const second = [{ ...node(201, 17), confidence }, node(202, 17, 201)];
      const { driver, identities } = makeDriver(
        new Map([
          [11, first],
          [17, second],
        ]),
      );
      const descriptor =
        kind === "reroot"
          ? command(SpatialSkeletonActions.reroot, "Reroot", {
              kind: "reroot",
              node: first[1],
            })
          : command(SpatialSkeletonActions.mergeSkeletons, "Merge", {
              kind: "merge",
              options: { firstNode: first[1], secondNode: second[1] },
            });
      const execute = driver.createLogicalIntent(
        descriptor,
        context(1, "execute"),
      );
      let semantic = execute.workflow.semantic;
      const rootId = kind === "merge" ? 201 : 101;
      const rootHandle = identities.getOrCreateNodeHandle(rootId);
      if (kind === "reversed merge" && semantic.kind === "merge") {
        semantic = {
          ...semantic,
          inverseOrientation: "first-from-second",
          originalRoot: {
            ...rootHandle,
            capturedNodeId: rootId,
            handle: rootHandle,
          },
          originalRootConfidence: confidence,
        };
      }
      const inverse = {
        ...execute.workflow,
        semantic,
        direction: "inverse",
      } as CatmaidWorkflow;
      // A later deletion/restoration can replace the physical root before Undo.
      identities.apply({ bindings: { nodes: [[rootHandle, 901]] } });
      const attempts: CanonicalAttempt[] = [];
      if (kind !== "reroot") {
        expect(
          commitNextAttempt(
            driver,
            inverse,
            {
              existingSegmentId: kind === "merge" ? 11 : 17,
              newSegmentId: 700,
            } as any,
            attempts,
            "undo",
          ),
        ).toMatchObject({ kind: "split" });
      }
      expect(
        commitNextAttempt(driver, inverse, undefined as any, attempts, "undo"),
      ).toMatchObject({ kind: "reroot", request: { nodeId: 901 } });
      if (confidence !== 100) {
        expect(
          commitNextAttempt(
            driver,
            inverse,
            undefined as any,
            attempts,
            "undo",
          ),
        ).toEqual({ kind: "confidence", request: { nodeId: 901, confidence } });
      }
      expect(
        driver.nextAttempt(inverse, workflowContext(2, "undo", attempts)),
      ).toBeUndefined();
    },
  );

  it("materializes every CATMAID Execute request as its minimum scalar payload", () => {
    const richLeaf = Object.freeze({
      ...node(3, 23, 2),
      description: "leaf",
      isTrueEnd: true,
      radius: 4,
      confidence: 80,
    });
    const first = [node(100, 11), node(101, 11, 100)];
    const second = [node(200, 17), node(201, 17, 200)];
    const { driver } = makeDriver(
      new Map([
        [23, [node(1, 23), node(2, 23, 1), richLeaf]],
        [11, first],
        [17, second],
      ]),
    );
    const materializeSpies = currentQueueInput.segments.map(({ snapshot }) =>
      vi.spyOn(snapshot, "materialize"),
    );
    const mutation = (
      descriptor: CatmaidSpatialSkeletonCommandDescriptor,
      intentId: number,
    ) => {
      const logical = driver.createLogicalIntent(
        descriptor,
        context(intentId, "execute"),
      );
      return driver
        .nextAttempt(
          logical.workflow,
          workflowContext(intentId, "execute", []),
        )!
        .materializeMutation();
    };

    const cases: readonly [
      CatmaidSpatialSkeletonCommandDescriptor["action"],
      CatmaidSpatialSkeletonCommandDescriptor["payload"],
      object,
    ][] = [
      [
        SpatialSkeletonActions.addNodes,
        {
          kind: "add-node",
          options: {
            skeletonId: 23,
            parentNodeId: 2,
            positionInModelSpace: [1, 2, 3],
          },
        },
        { kind: "add-node", request: { position: [1, 2, 3], parentNodeId: 2 } },
      ],
      [
        SpatialSkeletonActions.moveNodes,
        {
          kind: "move-node",
          options: { node: richLeaf, nextPositionInModelSpace: [7, 8, 9] },
        },
        { kind: "move-node", request: { nodeId: 3, position: [7, 8, 9] } },
      ],
      [
        SpatialSkeletonActions.deleteNodes,
        { kind: "delete-node", node: richLeaf },
        { kind: "delete-node", request: { nodeId: 3 } },
      ],
      [
        SpatialSkeletonActions.reroot,
        { kind: "reroot", node: richLeaf },
        { kind: "reroot", request: { nodeId: 3 } },
      ],
      [
        SpatialSkeletonActions.editNodeDescription,
        {
          kind: "description",
          options: { node: richLeaf, nextDescription: "next" },
        },
        {
          kind: "description",
          request: { nodeId: 3, description: "next", isTrueEnd: true },
        },
      ],
      [
        SpatialSkeletonActions.editNodeTrueEnd,
        { kind: "true-end", options: { node: richLeaf, nextIsTrueEnd: false } },
        { kind: "true-end", request: { nodeId: 3, isTrueEnd: false } },
      ],
      [
        SpatialSkeletonActions.editNodeRadius,
        { kind: "radius", options: { node: richLeaf, nextRadius: 12 } },
        { kind: "radius", request: { nodeId: 3, radius: 12 } },
      ],
      [
        SpatialSkeletonActions.editNodeConfidence,
        { kind: "confidence", options: { node: richLeaf, nextConfidence: 90 } },
        { kind: "confidence", request: { nodeId: 3, confidence: 90 } },
      ],
      [
        SpatialSkeletonActions.splitSkeletons,
        { kind: "split", node: richLeaf },
        { kind: "split", request: { nodeId: 3 } },
      ],
      [
        SpatialSkeletonActions.mergeSkeletons,
        {
          kind: "merge",
          options: { firstNode: first[1], secondNode: second[1] },
        },
        {
          kind: "merge",
          request: { fromNodeId: 101, toNodeId: 201 },
          inputSegmentIds: [11, 17],
        },
      ],
    ];
    cases.forEach(([action, payload, expected], index) => {
      const actual = mutation(command(action, "Edit", payload), index + 1);
      expect(actual.kind).toBe((expected as { kind: string }).kind);
      expect(actual.request).toEqual((expected as { request: object }).request);
      if (actual.kind === "merge") {
        expect(actual.inputSegmentIds).toEqual(
          (expected as { inputSegmentIds: readonly number[] }).inputSegmentIds,
        );
      }
    });
    expect(materializeSpies.every((spy) => spy.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it("resolves retained logical handles when the authority lease starts", () => {
    const original = node(2, 23, 1);
    const { driver, identities } = makeDriver(
      new Map([[23, [node(1, 23), original]]]),
    );
    const logical = driver.createLogicalIntent(
      command(SpatialSkeletonActions.moveNodes, "Move", {
        kind: "move-node",
        options: {
          node: original,
          nextPositionInModelSpace: [10, 11, 12],
        },
      }),
      context(1, "execute"),
    );
    const delta = logical.projection.delta;
    if (delta.kind !== "move") throw new Error("Expected move projection.");
    identities.apply({ bindings: { nodes: [[delta.node, 900]] } });

    expect(
      driver
        .nextAttempt(logical.workflow, workflowContext(1, "execute", []))!
        .materializeMutation(),
    ).toEqual({
      kind: "move-node",
      request: { nodeId: 900, position: [10, 11, 12] },
    });
  });

  it("restores a deleted description and true-end label in one CATMAID request", () => {
    const deleted = Object.freeze({
      ...node(2, 23, 1),
      description: "terminal",
      isTrueEnd: true,
    });
    const { driver, identities } = makeDriver(
      new Map([[23, [node(1, 23), deleted]]]),
    );
    const descriptor = command(SpatialSkeletonActions.deleteNodes, "Delete", {
      kind: "delete-node",
      node: deleted,
    });
    const execute = driver.createLogicalIntent(
      descriptor,
      context(1, "execute"),
    );
    const undo = driver.createLogicalIntent(
      descriptor,
      context(2, "undo", {
        workflow: execute.workflow,
        projection: execute.projection,
        inverseProjection: {
          kind: "restore-delete",
          segment: identities.getOrCreateSegmentHandle(23),
          snapshot: {
            node: identities.getOrCreateNodeHandle(2),
            parent: identities.getOrCreateNodeHandle(1),
            position: deleted.position,
            attributes: { description: "terminal", isTrueEnd: true },
          },
          children: [],
        },
      }),
    );
    const attempts: CanonicalAttempt[] = [];
    expect(
      commitNextAttempt(
        driver,
        undo.workflow,
        { nodeId: 20, segmentId: 23 } as any,
        attempts,
        "undo",
      ),
    ).toMatchObject({
      kind: "add-node",
      request: { position: new Float32Array([2, 3, 4]), parentNodeId: 1 },
    });
    expect(
      commitNextAttempt(
        driver,
        undo.workflow,
        { description: "terminal" } as any,
        attempts,
        "undo",
      ),
    ).toEqual({
      kind: "description",
      request: { nodeId: 20, description: "terminal", isTrueEnd: true },
    });
    expect(
      driver.nextAttempt(undo.workflow, workflowContext(2, "undo", attempts)),
    ).toBeUndefined();
  });

  it("reuses one immutable recipe across execute, undo, and redo with fresh identities", () => {
    const { driver, identities } = makeDriver(new Map([[23, [node(1, 23)]]]));
    const descriptor = command(SpatialSkeletonActions.addNodes, "Add node", {
      kind: "add-node",
      options: {
        skeletonId: 23,
        parentNodeId: 1,
        positionInModelSpace: Object.freeze([4, 5, 6]),
      },
    });
    const execute = driver.createLogicalIntent(
      descriptor,
      context(1, "execute"),
    );
    expect(execute.kind).toBe("addNode");
    expect(execute.projection.provisionalBindings?.nodes?.[0]?.[1]).toBe(
      999_999,
    );
    expect(execute.projection.uiHints).toMatchObject({
      segmentVisibility: [{ visible: true, select: "pin" }],
      selectedNode: {
        kind: "select",
        position: [4, 5, 6],
        moveView: true,
      },
    });

    const executeAttempts: CanonicalAttempt[] = [];
    expect(
      commitNextAttempt(
        driver,
        execute.workflow,
        { nodeId: 2, segmentId: 23 } as any,
        executeAttempts,
      ),
    ).toMatchObject({
      kind: "add-node",
      request: { parentNodeId: 1 },
    });
    const executeReconciliation = driver.createReconciliation(
      execute.workflow,
      workflowContext(1, "execute", executeAttempts),
    );
    identities.apply(executeReconciliation);
    const createdHandle = (execute.projection.delta as any).node;
    expect(identities.resolveNode(createdHandle)).toBe(2);

    const inverseProjection = {
      kind: "delete",
      segment: (execute.projection.delta as any).segment,
      node: createdHandle,
    } as SpatialSkeletonProjectionInverseDelta;
    const recipe = {
      workflow: execute.workflow,
      projection: execute.projection,
      inverseProjection,
    };
    const undo = driver.createLogicalIntent(
      descriptor,
      context(2, "undo", recipe),
    );
    expect(undo.projection.delta).toBe(inverseProjection);
    expect(undo.workflow).not.toBe(execute.workflow);
    expect(undo.projection.uiHints).toMatchObject({
      selectedNode: { kind: "select", node: { stableId: "authority:1" } },
    });
    const undoAttempts: CanonicalAttempt[] = [];
    const undoMutation = commitNextAttempt(
      driver,
      undo.workflow,
      {} as any,
      undoAttempts,
      "undo",
    );
    expect(undoMutation).toEqual({
      kind: "delete-node",
      request: { nodeId: 2 },
    });
    expect(executeAttempts).toHaveLength(1);

    const redo = driver.createLogicalIntent(
      descriptor,
      context(3, "redo", recipe),
    );
    expect(redo.projection.delta).toStrictEqual(execute.projection.delta);
    expect(redo.projection.provisionalBindings?.nodes?.[0]?.[1]).toBe(999_997);
    expect(redo.projection.uiHints).toMatchObject({
      segmentVisibility: [{ visible: true, select: "preserve" }],
      selectedNode: { kind: "select", moveView: false },
    });
    const redoAttempts: CanonicalAttempt[] = [];
    expect(
      commitNextAttempt(
        driver,
        redo.workflow,
        { nodeId: 3, segmentId: 23 } as any,
        redoAttempts,
        "redo",
      ),
    ).toMatchObject({
      kind: "add-node",
      request: { parentNodeId: 1 },
    });
    identities.apply(
      driver.createReconciliation(
        redo.workflow,
        workflowContext(3, "redo", redoAttempts),
      ),
    );
    expect(identities.resolveNode(createdHandle)).toBe(3);
  });

  it("binds both merge identities to CATMAID's reversed survivor", () => {
    const { driver, identities } = makeDriver(
      new Map([
        [11, [node(101, 11)]],
        [17, [node(201, 17)]],
      ]),
    );
    const logical = driver.createLogicalIntent(
      command(SpatialSkeletonActions.mergeSkeletons, "Merge skeletons", {
        kind: "merge",
        options: {
          firstNode: { nodeId: 101, segmentId: 11 },
          secondNode: { nodeId: 201, segmentId: 17 },
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
          resultSegmentId: 17,
          deletedSegmentId: 11,
          directionAdjusted: true,
        } as any,
        attempts,
      ),
    ).toMatchObject({
      kind: "merge",
      request: {
        fromNodeId: 101,
        toNodeId: 201,
      },
    });
    const reconciliation = driver.createReconciliation(
      logical.workflow,
      workflowContext(1, "execute", attempts),
    );
    identities.apply(reconciliation);
    const merge = logical.projection.delta as any;

    expect(identities.resolveSegment(merge.firstSegment)).toBe(17);
    expect(identities.resolveSegment(merge.secondSegment)).toBe(17);
    expect(identities.resolveSegment(merge.resultSegment)).toBe(17);
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

  it("targets the appropriate root for Execute, Undo, and Redo", () => {
    const nodes = [node(1, 23), node(2, 23, 1), node(3, 23, 2), node(4, 23, 1)];
    const { driver } = makeDriver(new Map([[23, nodes]]));
    const descriptor = command(SpatialSkeletonActions.reroot, "Reroot", {
      kind: "reroot",
      node: nodes[2],
    });
    const execute = driver.createLogicalIntent(
      descriptor,
      context(1, "execute"),
    );
    const semantic = execute.workflow.semantic;
    if (semantic.kind !== "reroot")
      throw new Error("Expected reroot semantic.");
    expect(semantic.node.stableId).toBe("authority:3");
    expect(semantic.originalRoot.stableId).toBe("authority:1");
    const recipe = {
      workflow: execute.workflow,
      projection: execute.projection,
      inverseProjection: {
        kind: "restore-topology",
        segment: semantic.segment,
        patches: nodes.slice(0, 3).map((node) => ({
          node: semantic.retainedNodes.get(node.nodeId)!,
          parent:
            node.parentNodeId === undefined
              ? null
              : semantic.retainedNodes.get(node.parentNodeId)!,
          confidence: node.confidence,
        })),
      } as SpatialSkeletonProjectionInverseDelta,
    };

    for (const [intent, intentId] of [
      ["execute", 1],
      ["undo", 2],
      ["redo", 3],
    ] as const) {
      const logical =
        intent === "execute"
          ? execute
          : driver.createLogicalIntent(
              descriptor,
              context(intentId, intent, recipe),
            );
      const attempts: CanonicalAttempt[] = [];
      const mutation = commitNextAttempt(
        driver,
        logical.workflow,
        undefined,
        attempts,
        intent,
      );
      expect(mutation).toEqual({
        kind: "reroot",
        request: { nodeId: intent === "undo" ? 1 : 3 },
      });
      expect(
        driver.nextAttempt(
          logical.workflow,
          workflowContext(intentId, intent, attempts),
        ),
      ).toBeUndefined();
      const reconciliation = driver.createReconciliation(
        logical.workflow,
        workflowContext(intentId, intent, attempts),
      );
      expect(reconciliation).toEqual({
        bindings: { nodes: [], segments: [] },
        retiredResources: [],
      });
    }
  });

  it("honors CATMAID merge orientation in both canonical directions", () => {
    const makeMerge = () => {
      const setup = makeDriver(
        new Map([
          [11, [node(100, 11), node(101, 11, 100)]],
          [17, [node(200, 17), node(201, 17, 200)]],
        ]),
      );
      const descriptor = command(
        SpatialSkeletonActions.mergeSkeletons,
        "Merge",
        {
          kind: "merge",
          options: {
            firstNode: { nodeId: 101, segmentId: 11 },
            secondNode: { nodeId: 201, segmentId: 17 },
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
      const resultSegmentId = directionAdjusted ? 17 : 11;
      const deletedSegmentId = directionAdjusted ? 11 : 17;
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
            resultSegmentId: directionAdjusted ? 11 : 17,
            deletedSegmentId: directionAdjusted ? 17 : 11,
            directionAdjusted,
          } as any,
          attempts,
          "redo",
        ),
      ).toMatchObject({
        kind: "merge",
        request: { fromNodeId: 201, toNodeId: 101 },
      });
      const reconciliation = driver.createReconciliation(
        redo.workflow,
        workflowContext(3, "redo", attempts),
      );
      expect(reconciliation.retiredSegmentIds).toEqual([
        directionAdjusted ? 17 : 11,
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
      const { driver, identities } = makeDriver(new Map([[23, nodes]]));
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
            [semantic.sourceSegment, 23],
            [semantic.downstreamSegment, 24],
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
          resultSegmentId: directionAdjusted ? 24 : 23,
          deletedSegmentId: directionAdjusted ? 23 : 24,
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
              [semantic.sourceSegment, 23],
              [semantic.downstreamSegment, 23],
            ],
          },
          retiredResources: [],
          retiredSegmentIds: [24],
        });
      }
    },
  );

  it("derives reversed merge Undo and Redo orientation from the retained canonical inverse", () => {
    const { driver, identities } = makeDriver(
      new Map([
        [11, [node(101, 11)]],
        [17, [node(201, 17)]],
      ]),
    );
    const descriptor = command(
      SpatialSkeletonActions.mergeSkeletons,
      "Merge skeletons",
      {
        kind: "merge",
        options: {
          firstNode: { nodeId: 101, segmentId: 11 },
          secondNode: { nodeId: 201, segmentId: 17 },
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
          [semantic.firstSegment, 99],
          [semantic.secondSegment, 99],
          [semantic.mergedSegment, 99],
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
      request: { nodeId: 101 },
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
        fromNodeId: 201,
        toNodeId: 101,
      },
    });
  });

  it("retries a coalesced Merge without an inverse using its original orientation", () => {
    const { driver } = makeDriver(
      new Map([
        [11, [node(101, 11)]],
        [17, [node(201, 17)]],
      ]),
    );
    const descriptor = command(
      SpatialSkeletonActions.mergeSkeletons,
      "Merge skeletons",
      {
        kind: "merge",
        options: {
          firstNode: { nodeId: 101, segmentId: 11 },
          secondNode: { nodeId: 201, segmentId: 17 },
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

  it("describes delete selection without owning layer presentation state", () => {
    const { driver } = makeDriver(
      new Map([[23, [node(1, 23), node(2, 23, 1)]]]),
    );
    const childDelete = driver.createLogicalIntent(
      command(SpatialSkeletonActions.deleteNodes, "Delete node", {
        kind: "delete-node",
        node: node(2, 23, 1),
      }),
      context(1, "execute"),
    );
    expect(childDelete.projection.uiHints).toMatchObject({
      selectedNode: {
        kind: "select",
        node: { stableId: "authority:1" },
        segment: { stableId: "authority:23" },
        moveView: true,
      },
    });

    const { driver: soleRootDriver } = makeDriver(
      new Map([[31, [node(7, 31)]]]),
    );
    const rootDelete = soleRootDriver.createLogicalIntent(
      command(SpatialSkeletonActions.deleteNodes, "Delete node", {
        kind: "delete-node",
        node: node(7, 31),
      }),
      context(2, "execute"),
    );
    expect(rootDelete.projection.uiHints).toMatchObject({
      segmentVisibility: [
        {
          segment: { stableId: "authority:31" },
          visible: false,
          deselect: true,
        },
      ],
      selectedNode: { kind: "clear" },
    });
  });
});
