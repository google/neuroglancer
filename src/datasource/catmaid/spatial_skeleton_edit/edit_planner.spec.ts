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
  CatmaidSpatialSkeletonCommandDescriptor,
  CatmaidEditPlan,
} from "#src/datasource/catmaid/spatial_skeleton_edit/edit_planner.js";
import {
  CatmaidEditPlanner,
  getCatmaidAuthorityLabels,
} from "#src/datasource/catmaid/spatial_skeleton_edit/edit_planner.js";
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
import { bigintCompare } from "#src/util/bigint.js";

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

type CommittedAttempt = Readonly<{
  editRequest: CatmaidEditRequest;
  result: CatmaidEditRequestResult;
}>;

function planContext(
  intentId: number,
  intent: "execute" | "undo" | "redo",
  committedAttempts: readonly CommittedAttempt[],
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
  attempts: CommittedAttempt[],
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

describe("CatmaidEditPlanner", () => {
  it("warns when CATMAID has not confirmed an edit after 30 seconds", () => {
    expect(getCatmaidAuthorityLabels("move-node").stalledWarning).toEqual({
      delayMs: 30_000,
      message:
        "CATMAID has not confirmed the optimistic skeleton edit yet. The server edit request lane is stalled, but you may continue previewing independent edits while the request remains in order.",
    });
  });

  it("a move adds no new node or skeleton IDs", () => {
    const original = node(2, 23, 1);
    const { planner } = makePlanner(new Map([[23n, [node(1, 23), original]]]));
    const logical = planner.planIntent(
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
    expect(logical.preview.delta).toMatchObject({
      kind: "move",
      position: [10, 11, 12],
    });

    const attempts: CommittedAttempt[] = [];
    commitNextAttempt(planner, logical.plan, {} as any, attempts);
    const reconciliation = planner.createReconciliation(
      logical.plan,
      planContext(1, "execute", attempts),
    );
    expect(reconciliation).toEqual({
      bindings: { nodes: [], segments: [] },
      retiredResources: [],
    });
  });

  it("refuses an edit whose skeleton has not been loaded", () => {
    const original = node(2, 23, 1);
    const { planner } = makePlanner(new Map([[23n, [node(1, 23), original]]]));
    const descriptor = command(SpatialSkeletonActions.moveNodes, "Move node", {
      kind: "move-node",
      options: {
        node: original,
        nextPositionInModelSpace: Object.freeze([10, 11, 12]),
      },
    });

    expect(() =>
      planner.planIntent(descriptor, {
        intentId: 1,
        intent: "execute",
        queueInput: Object.freeze({ segments: Object.freeze([]) }),
      }),
    ).toThrow(/requires admitted complete skeleton 23/);
  });

  it("orders CATMAID edits by the skeletons they touch", () => {
    const { planner } = makePlanner(
      new Map([
        [11n, [node(101, 11)]],
        [17n, [node(201, 17)]],
        [23n, [node(1, 23), node(2, 23, 1)]],
      ]),
    );
    const intents = [
      planner.planIntent(
        command(SpatialSkeletonActions.addNodes, "Add node", {
          kind: "add-node",
          options: {
            skeletonId: 23n,
            parentNodeId: 1n,
            positionInModelSpace: [1, 2, 3],
          },
        }),
        context(1, "execute"),
      ),
      planner.planIntent(
        command(SpatialSkeletonActions.moveNodes, "Move node", {
          kind: "move-node",
          options: {
            node: node(2, 23, 1),
            nextPositionInModelSpace: [4, 5, 6],
          },
        }),
        context(2, "execute"),
      ),
      planner.planIntent(
        command(SpatialSkeletonActions.splitSkeletons, "Split skeleton", {
          kind: "split",
          node: node(2, 23, 1),
        }),
        context(3, "execute"),
      ),
      planner.planIntent(
        command(SpatialSkeletonActions.mergeSkeletons, "Merge skeletons", {
          kind: "merge",
          options: {
            firstNode: { nodeId: 101n, segmentId: 11n },
            secondNode: { nodeId: 201n, segmentId: 17n },
          },
        }),
        context(4, "execute"),
      ),
    ];

    expect(
      intents.map((intent) =>
        intent.stableResources.map(({ handle }) => handle.kind),
      ),
    ).toEqual([
      ["segment"],
      ["segment"],
      ["segment", "segment"],
      ["segment", "segment", "segment"],
    ]);
  });

  it("remembers only the nodes each edit needs, without copying whole skeletons", () => {
    const main = [
      node(1, 23),
      node(2, 23, 1),
      node(3, 23, 2),
      node(4, 23, 1),
      node(5, 23, 3),
    ];
    const first = [node(100, 11), node(101, 11, 100), node(102, 11, 100)];
    const second = [node(200, 17), node(201, 17, 200), node(202, 17, 201)];
    const { planner } = makePlanner(
      new Map([
        [23n, main],
        [11n, first],
        [17n, second],
      ]),
    );
    const materializeSpies = currentQueueInput.segments.map(({ snapshot }) =>
      vi.spyOn(snapshot, "materialize"),
    );
    const retainedIds = (
      descriptor: CatmaidSpatialSkeletonCommandDescriptor,
      intentId: number,
    ) => {
      const intent = planner.planIntent(
        descriptor,
        context(intentId, "execute"),
      );
      const retainedNodes = intent.plan.semantic.retainedNodes;
      expect(
        [...retainedNodes].every(
          ([nodeId, retained]) => nodeId === retained.capturedNodeId,
        ),
      ).toBe(true);
      return {
        intent,
        ids: [...retainedNodes.keys()].sort(bigintCompare),
      };
    };

    expect(
      retainedIds(
        command(SpatialSkeletonActions.addNodes, "Add", {
          kind: "add-node",
          options: {
            skeletonId: 23n,
            parentNodeId: 2n,
            positionInModelSpace: [1, 2, 3],
          },
        }),
        1,
      ).ids,
    ).toEqual([2n]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.moveNodes, "Move", {
          kind: "move-node",
          options: { node: main[2], nextPositionInModelSpace: [4, 5, 6] },
        }),
        2,
      ).ids,
    ).toEqual([3n]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.editNodeDescription, "Description", {
          kind: "description",
          options: { node: main[2], nextDescription: "next" },
        }),
        3,
      ).ids,
    ).toEqual([3n]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.addNodes, "Root Add", {
          kind: "add-node",
          options: {
            skeletonId: 0n,
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
    ).toEqual([1n, 2n, 3n]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.reroot, "Reroot", {
          kind: "reroot",
          node: main[2],
        }),
        7,
      ).ids,
    ).toEqual([1n, 2n, 3n]);
    expect(
      retainedIds(
        command(SpatialSkeletonActions.splitSkeletons, "Split", {
          kind: "split",
          node: main[2],
        }),
        8,
      ).ids,
    ).toEqual([2n, 3n]);
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
    expect(merge.ids).toEqual([100n, 101n, 200n, 201n]);
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
    "Undo restores the old description and Redo re-sends the one CATMAID stored: $input",
    ({ input, normalized }) => {
      const original = Object.freeze({
        ...node(2, 23, 1),
        description: "before",
      });
      const { planner } = makePlanner(
        new Map([[23n, [node(1, 23), original]]]),
      );
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
      const execute = planner.planIntent(descriptor, context(1, "execute"));
      const executeAttempts: CommittedAttempt[] = [];
      expect(
        commitNextAttempt(
          planner,
          execute.plan,
          { description: normalized } as any,
          executeAttempts,
        ),
      ).toMatchObject({
        kind: "description",
        request: { description: input },
      });
      const reconciliation = planner.createReconciliation(
        execute.plan,
        planContext(1, "execute", executeAttempts),
      );
      expect(reconciliation.finalizedPreviewDelta).toMatchObject({
        kind: "node-attributes",
        changes: { description: normalized },
      });
      const executeDelta = execute.preview.delta;
      if (executeDelta.kind !== "node-attributes") {
        throw new Error("Expected a description preview.");
      }
      const canonicalPreview = Object.freeze({
        ...execute.preview,
        delta: reconciliation.finalizedPreviewDelta!,
      });
      const inversePreview = Object.freeze({
        kind: "node-attributes" as const,
        segment: executeDelta.segment,
        node: executeDelta.node,
        changes: Object.freeze({ description: "before" }),
      });
      const recipe = {
        plan: execute.plan,
        preview: canonicalPreview,
        inversePreview,
      };

      const undo = planner.planIntent(descriptor, context(2, "undo", recipe));
      expect(undo.preview.delta).toBe(inversePreview);
      const undoAttempts: CommittedAttempt[] = [];
      expect(
        commitNextAttempt(
          planner,
          undo.plan,
          { description: "before" } as any,
          undoAttempts,
          "undo",
        ),
      ).toMatchObject({
        kind: "description",
        request: { description: "before" },
      });

      const redo = planner.planIntent(descriptor, context(3, "redo", recipe));
      expect(redo.preview.delta).toMatchObject({
        kind: "node-attributes",
        changes: { description: normalized },
      });
      const redoAttempts: CommittedAttempt[] = [];
      expect(
        commitNextAttempt(
          planner,
          redo.plan,
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
      const rootAttributes = { confidence: [confidence] };
      const first = [
        node(101, 11, undefined, rootAttributes),
        node(102, 11, 101),
      ];
      const second = [
        node(201, 17, undefined, rootAttributes),
        node(202, 17, 201),
      ];
      const { planner, identities } = makePlanner(
        new Map([
          [11n, first],
          [17n, second],
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
      const execute = planner.planIntent(descriptor, context(1, "execute"));
      let semantic = execute.plan.semantic;
      const rootId = kind === "merge" ? 201n : 101n;
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
        ...execute.plan,
        semantic,
        direction: "inverse",
      } as CatmaidEditPlan;
      // A later deletion/restoration can replace the physical root before Undo.
      identities.apply({ bindings: { nodes: [[rootHandle, 901n]] } });
      const attempts: CommittedAttempt[] = [];
      const undo = (result?: object) =>
        commitNextAttempt(planner, inverse, result as any, attempts, "undo");
      if (kind !== "reroot") {
        expect(
          undo({
            existingSegmentId: kind === "merge" ? 11n : 17n,
            newSegmentId: 700n,
          }),
        ).toMatchObject({ kind: "split" });
      }
      expect(undo()).toMatchObject({
        kind: "reroot",
        request: { nodeId: 901n },
      });
      if (confidence !== 100) {
        expect(undo()).toEqual({
          kind: "confidence",
          request: { nodeId: 901n, confidence },
        });
      }
      expect(
        planner.nextAttempt(inverse, planContext(2, "undo", attempts)),
      ).toBeUndefined();
    },
  );

  it("sends each edit to CATMAID with only the fields its endpoint needs", () => {
    const richLeaf = Object.freeze({
      ...node(3, 23, 2, { true_end: [1], radius: [4], confidence: [80] }),
      description: "leaf",
    });
    const first = [node(100, 11), node(101, 11, 100)];
    const second = [node(200, 17), node(201, 17, 200)];
    const { planner } = makePlanner(
      new Map([
        [23n, [node(1, 23), node(2, 23, 1), richLeaf]],
        [11n, first],
        [17n, second],
      ]),
    );
    const editRequest = (
      descriptor: CatmaidSpatialSkeletonCommandDescriptor,
      intentId: number,
    ) => {
      const logical = planner.planIntent(
        descriptor,
        context(intentId, "execute"),
      );
      return planner
        .nextAttempt(logical.plan, planContext(intentId, "execute", []))!
        .materializeEditRequest();
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
            skeletonId: 23n,
            parentNodeId: 2n,
            positionInModelSpace: [1, 2, 3],
          },
        },
        {
          kind: "add-node",
          request: { position: [1, 2, 3], parentNodeId: 2n },
        },
      ],
      [
        SpatialSkeletonActions.moveNodes,
        {
          kind: "move-node",
          options: { node: richLeaf, nextPositionInModelSpace: [7, 8, 9] },
        },
        { kind: "move-node", request: { nodeId: 3n, position: [7, 8, 9] } },
      ],
      [
        SpatialSkeletonActions.deleteNodes,
        { kind: "delete-node", node: richLeaf },
        { kind: "delete-node", request: { nodeId: 3n } },
      ],
      [
        SpatialSkeletonActions.reroot,
        { kind: "reroot", node: richLeaf },
        { kind: "reroot", request: { nodeId: 3n } },
      ],
      [
        SpatialSkeletonActions.editNodeDescription,
        {
          kind: "description",
          options: { node: richLeaf, nextDescription: "next" },
        },
        {
          kind: "description",
          request: { nodeId: 3n, description: "next", isTrueEnd: true },
        },
      ],
      [
        SpatialSkeletonActions.editNodeTrueEnd,
        { kind: "true-end", options: { node: richLeaf, nextIsTrueEnd: false } },
        { kind: "true-end", request: { nodeId: 3n, isTrueEnd: false } },
      ],
      [
        SpatialSkeletonActions.editNodeRadius,
        { kind: "radius", options: { node: richLeaf, nextRadius: 12 } },
        { kind: "radius", request: { nodeId: 3n, radius: 12 } },
      ],
      [
        SpatialSkeletonActions.editNodeConfidence,
        { kind: "confidence", options: { node: richLeaf, nextConfidence: 90 } },
        { kind: "confidence", request: { nodeId: 3n, confidence: 90 } },
      ],
      [
        SpatialSkeletonActions.splitSkeletons,
        { kind: "split", node: richLeaf },
        { kind: "split", request: { nodeId: 3n } },
      ],
      [
        SpatialSkeletonActions.mergeSkeletons,
        {
          kind: "merge",
          options: { firstNode: first[1], secondNode: second[1] },
        },
        {
          kind: "merge",
          request: { fromNodeId: 101n, toNodeId: 201n },
          inputSegmentIds: [11n, 17n],
        },
      ],
    ];
    cases.forEach(([action, payload, expected], index) => {
      const actual = editRequest(command(action, "Edit", payload), index + 1);
      expect(actual.kind).toBe((expected as { kind: string }).kind);
      expect(actual.request).toEqual((expected as { request: object }).request);
      if (actual.kind === "merge") {
        expect(actual.inputSegmentIds).toEqual(
          (expected as { inputSegmentIds: readonly bigint[] }).inputSegmentIds,
        );
      }
    });
  });

  it("sends a move to the node's current ID when the ID changed after planning", () => {
    const original = node(2, 23, 1);
    const { planner, identities } = makePlanner(
      new Map([[23n, [node(1, 23), original]]]),
    );
    const logical = planner.planIntent(
      command(SpatialSkeletonActions.moveNodes, "Move", {
        kind: "move-node",
        options: {
          node: original,
          nextPositionInModelSpace: [10, 11, 12],
        },
      }),
      context(1, "execute"),
    );
    const delta = logical.preview.delta;
    if (delta.kind !== "move") throw new Error("Expected move preview.");
    identities.apply({ bindings: { nodes: [[delta.node, 900n]] } });

    expect(
      planner
        .nextAttempt(logical.plan, planContext(1, "execute", []))!
        .materializeEditRequest(),
    ).toEqual({
      kind: "move-node",
      request: { nodeId: 900n, position: [10, 11, 12] },
    });
  });

  it("restores a deleted description and true-end label in one CATMAID request", () => {
    const deleted = Object.freeze({
      ...node(2, 23, 1, { true_end: [1] }),
      description: "terminal",
    });
    const { planner, identities } = makePlanner(
      new Map([[23n, [node(1, 23), deleted]]]),
    );
    const descriptor = command(SpatialSkeletonActions.deleteNodes, "Delete", {
      kind: "delete-node",
      node: deleted,
    });
    const execute = planner.planIntent(descriptor, context(1, "execute"));
    const undo = planner.planIntent(
      descriptor,
      context(2, "undo", {
        plan: execute.plan,
        preview: execute.preview,
        inversePreview: {
          kind: "restore-delete",
          segment: identities.getOrCreateSegmentHandle(23n),
          snapshot: {
            node: identities.getOrCreateNodeHandle(2n),
            parent: identities.getOrCreateNodeHandle(1n),
            position: deleted.position,
            attributes: { description: "terminal", isTrueEnd: true },
          },
          children: [],
        },
      }),
    );
    const attempts: CommittedAttempt[] = [];
    expect(
      commitNextAttempt(
        planner,
        undo.plan,
        { nodeId: 20n, segmentId: 23n } as any,
        attempts,
        "undo",
      ),
    ).toMatchObject({
      kind: "add-node",
      request: { position: new Float32Array([2, 3, 4]), parentNodeId: 1n },
    });
    expect(
      commitNextAttempt(
        planner,
        undo.plan,
        { description: "terminal" } as any,
        attempts,
        "undo",
      ),
    ).toEqual({
      kind: "description",
      request: { nodeId: 20n, description: "terminal", isTrueEnd: true },
    });
    expect(
      planner.nextAttempt(undo.plan, planContext(2, "undo", attempts)),
    ).toBeUndefined();
  });

  it("Redo of an added node creates it again under a new ID that the same handle follows", () => {
    const { planner, identities } = makePlanner(
      new Map([[23n, [node(1, 23)]]]),
    );
    const descriptor = command(SpatialSkeletonActions.addNodes, "Add node", {
      kind: "add-node",
      options: {
        skeletonId: 23n,
        parentNodeId: 1n,
        positionInModelSpace: Object.freeze([4, 5, 6]),
      },
    });
    const execute = planner.planIntent(descriptor, context(1, "execute"));
    expect(execute.kind).toBe("addNode");
    expect(execute.preview.provisionalBindings?.nodes?.[0]?.[1]).toBe(999_999n);
    expect(execute.preview.uiHints).toMatchObject({
      segmentVisibility: [{ visible: true, select: "pin" }],
      selectedNode: {
        kind: "select",
        position: [4, 5, 6],
        moveView: true,
      },
    });

    const executeAttempts: CommittedAttempt[] = [];
    expect(
      commitNextAttempt(
        planner,
        execute.plan,
        { nodeId: 2n, segmentId: 23n } as any,
        executeAttempts,
      ),
    ).toMatchObject({
      kind: "add-node",
      request: { parentNodeId: 1n },
    });
    const executeReconciliation = planner.createReconciliation(
      execute.plan,
      planContext(1, "execute", executeAttempts),
    );
    identities.apply(executeReconciliation);
    const createdHandle = (execute.preview.delta as any).node;
    expect(identities.resolveNode(createdHandle)).toBe(2n);

    const inversePreview = {
      kind: "delete",
      segment: (execute.preview.delta as any).segment,
      node: createdHandle,
    } as SpatialSkeletonEditInverseDelta;
    const recipe = {
      plan: execute.plan,
      preview: execute.preview,
      inversePreview,
    };
    const undo = planner.planIntent(descriptor, context(2, "undo", recipe));
    expect(undo.preview.delta).toBe(inversePreview);
    expect(undo.plan).not.toBe(execute.plan);
    expect(undo.preview.uiHints).toMatchObject({
      selectedNode: { kind: "select", node: { stableId: "authority:1" } },
    });
    const undoAttempts: CommittedAttempt[] = [];
    const undoEditRequest = commitNextAttempt(
      planner,
      undo.plan,
      {} as any,
      undoAttempts,
      "undo",
    );
    expect(undoEditRequest).toEqual({
      kind: "delete-node",
      request: { nodeId: 2n },
    });
    expect(executeAttempts).toHaveLength(1);

    const redo = planner.planIntent(descriptor, context(3, "redo", recipe));
    expect(redo.preview.delta).toStrictEqual(execute.preview.delta);
    expect(redo.preview.provisionalBindings?.nodes?.[0]?.[1]).toBe(999_997n);
    expect(redo.preview.uiHints).toMatchObject({
      segmentVisibility: [{ visible: true, select: "preserve" }],
      selectedNode: { kind: "select", moveView: false },
    });
    const redoAttempts: CommittedAttempt[] = [];
    expect(
      commitNextAttempt(
        planner,
        redo.plan,
        { nodeId: 3n, segmentId: 23n } as any,
        redoAttempts,
        "redo",
      ),
    ).toMatchObject({
      kind: "add-node",
      request: { parentNodeId: 1n },
    });
    identities.apply(
      planner.createReconciliation(
        redo.plan,
        planContext(3, "redo", redoAttempts),
      ),
    );
    expect(identities.resolveNode(createdHandle)).toBe(3n);
  });

  it("reroots at the chosen node on Execute and Redo, and at the original root on Undo", () => {
    const nodes = [node(1, 23), node(2, 23, 1), node(3, 23, 2), node(4, 23, 1)];
    const { planner } = makePlanner(new Map([[23n, nodes]]));
    const descriptor = command(SpatialSkeletonActions.reroot, "Reroot", {
      kind: "reroot",
      node: nodes[2],
    });
    const execute = planner.planIntent(descriptor, context(1, "execute"));
    const semantic = execute.plan.semantic;
    if (semantic.kind !== "reroot")
      throw new Error("Expected reroot semantic.");
    expect(semantic.node.stableId).toBe("authority:3");
    expect(semantic.originalRoot.stableId).toBe("authority:1");
    const recipe = {
      plan: execute.plan,
      preview: execute.preview,
      inversePreview: {
        kind: "restore-topology",
        segment: semantic.segment,
        patches: nodes.slice(0, 3).map((node) => ({
          node: semantic.retainedNodes.get(node.nodeId)!,
          parent:
            node.parentNodeId === undefined
              ? null
              : semantic.retainedNodes.get(node.parentNodeId)!,
          confidence: node.attributes?.confidence?.[0],
        })),
      } as SpatialSkeletonEditInverseDelta,
    };

    for (const [intent, intentId] of [
      ["execute", 1],
      ["undo", 2],
      ["redo", 3],
    ] as const) {
      const logical =
        intent === "execute"
          ? execute
          : planner.planIntent(descriptor, context(intentId, intent, recipe));
      const attempts: CommittedAttempt[] = [];
      const editRequest = commitNextAttempt(
        planner,
        logical.plan,
        undefined,
        attempts,
        intent,
      );
      expect(editRequest).toEqual({
        kind: "reroot",
        request: { nodeId: intent === "undo" ? 1n : 3n },
      });
      expect(
        planner.nextAttempt(
          logical.plan,
          planContext(intentId, intent, attempts),
        ),
      ).toBeUndefined();
      const reconciliation = planner.createReconciliation(
        logical.plan,
        planContext(intentId, intent, attempts),
      );
      expect(reconciliation).toEqual({
        bindings: { nodes: [], segments: [] },
        retiredResources: [],
      });
    }
  });

  it("after a delete, selects the parent, or clears the selection when the skeleton is gone", () => {
    const { planner } = makePlanner(
      new Map([[23n, [node(1, 23), node(2, 23, 1)]]]),
    );
    const childDelete = planner.planIntent(
      command(SpatialSkeletonActions.deleteNodes, "Delete node", {
        kind: "delete-node",
        node: node(2, 23, 1),
      }),
      context(1, "execute"),
    );
    expect(childDelete.preview.uiHints).toMatchObject({
      selectedNode: {
        kind: "select",
        node: { stableId: "authority:1" },
        segment: { stableId: "authority:23" },
        moveView: true,
      },
    });

    const { planner: soleRootPlanner } = makePlanner(
      new Map([[31n, [node(7, 31)]]]),
    );
    const rootDelete = soleRootPlanner.planIntent(
      command(SpatialSkeletonActions.deleteNodes, "Delete node", {
        kind: "delete-node",
        node: node(7, 31),
      }),
      context(2, "execute"),
    );
    expect(rootDelete.preview.uiHints).toMatchObject({
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

  describe("merge", () => {
    it("when CATMAID keeps the second skeleton, both merged skeletons resolve to it", () => {
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
      const attempts: CommittedAttempt[] = [];
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
      expect(merge.resultSegment.stableId).not.toBe(
        merge.firstSegment.stableId,
      );
      expect(merge.resultSegment.stableId).not.toBe(
        merge.secondSegment.stableId,
      );
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

    it("retires whichever skeleton CATMAID deleted, on Merge and on Redo", () => {
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
        const attempts: CommittedAttempt[] = [];
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
        const attempts: CommittedAttempt[] = [];
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
        );
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
      "Undo of a split keeps the original skeleton, or asks for a reload when CATMAID keeps the split-off one (CATMAID kept the split-off one: %s)",
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
        const attempts: CommittedAttempt[] = [];
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

    it("after CATMAID reversed a merge, Undo splits at the original node and Redo merges in CATMAID's direction", () => {
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
      if (semantic.kind !== "merge")
        throw new Error("Expected merge semantic.");
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

    it("Redo of a Merge with no recorded inverse merges in the original direction", () => {
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
});
