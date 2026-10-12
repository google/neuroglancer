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

import { toCatmaidPositionInModelSpace } from "#src/datasource/catmaid/api.js";
import type { CatmaidSpatialSkeletonCommandPayload } from "#src/datasource/catmaid/spatial_skeleton_edit/command_payloads.js";
import type {
  CatmaidOptimisticMutation,
  CatmaidOptimisticMutationResult,
} from "#src/datasource/catmaid/spatial_skeleton_edit/mutation_adapter.js";
import { resolveCatmaidPreparedCommand } from "#src/datasource/catmaid/spatial_skeleton_edit/prepared_command.js";
import { CatmaidWorkflowAuthorityDriverBase } from "#src/datasource/catmaid/spatial_skeleton_edit/workflow_authority.js";
import type {
  CatmaidAttributeSemantic,
  CatmaidCapturedSegment,
  CatmaidCreatedNodeSemantic,
  CatmaidDeleteNodeSemantic,
  CatmaidMergeSemantic,
  CatmaidMoveNodeSemantic,
  CatmaidRetainedNode,
  CatmaidRerootSemantic,
  CatmaidSemanticRecipe,
  CatmaidSplitSemantic,
  CatmaidWorkflow,
} from "#src/datasource/catmaid/spatial_skeleton_edit/workflow_recipe.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import {
  type SpatialSkeletonAction,
  type SpatialSkeletonEditCommand,
  type SpatialSkeletonQueueInput,
} from "#src/skeleton/command_protocol.js";
import type { CompleteSkeletonSnapshotHandle } from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  getSpatialSkeletonLogicalResourceKey,
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
  type SpatialSkeletonLogicalNodeHandle,
  type SpatialSkeletonLogicalResourceHandle,
  type SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import type {
  SpatialSkeletonOptimisticIdentityService,
  SpatialSkeletonProvisionalNumericIdPolicy,
  SpatialSkeletonProvisionalNumericIdService,
} from "#src/skeleton/optimistic_edit/api.js";
import type {
  SpatialSkeletonIntentCreationContext,
  SpatialSkeletonIntentDriver,
  SpatialSkeletonLogicalIntent,
  SpatialSkeletonOptimisticPreparationDescriptor,
} from "#src/skeleton/optimistic_edit/ports.js";
import type {
  SpatialSkeletonAuthoritativeReconciliation,
  SpatialSkeletonProjectionInspectionSeed,
  SpatialSkeletonProjectionIntentDelta,
  SpatialSkeletonProjectionUiHints,
} from "#src/skeleton/optimistic_edit/projection_runtime.js";
import type { SpatialSkeletonOptimisticAuthorityPresentation } from "#src/skeleton/optimistic_edit/types.js";
import type { SpatialSkeletonIntentResource } from "#src/skeleton/spatial_skeleton_intent_journal.js";
import type {
  SpatialSkeletonProjectionDelta,
  SpatialSkeletonProjectionInverseDelta,
} from "#src/skeleton/spatial_skeleton_projection_reducer.js";

export type { CatmaidWorkflow } from "#src/datasource/catmaid/spatial_skeleton_edit/workflow_recipe.js";

// Match CATMAID creation defaults so later history captures complete values.
const CATMAID_CREATED_NODE_ATTRIBUTES = Object.freeze({
  radius: 0,
  confidence: 0,
  isTrueEnd: false,
});

const CATMAID_OPTIMISTIC_STALLED_WARNING = Object.freeze({
  delayMs: 30_000,
  message:
    "CATMAID has not confirmed the optimistic skeleton edit yet. The server mutation lane is stalled, but you may continue previewing independent edits while the request remains in order.",
});

const CATMAID_OPTIMISTIC_OPERATION_NOUNS = Object.freeze({
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
}) satisfies Readonly<
  Record<CatmaidSpatialSkeletonCommandPayload["kind"], string>
>;

export function getCatmaidOptimisticAuthorityPresentation(
  kind: CatmaidSpatialSkeletonCommandPayload["kind"],
): SpatialSkeletonOptimisticAuthorityPresentation {
  return Object.freeze({
    authorityLabel: "CATMAID",
    operationNoun: CATMAID_OPTIMISTIC_OPERATION_NOUNS[kind],
    stalledWarning: CATMAID_OPTIMISTIC_STALLED_WARNING,
  });
}

/** Immutable queue input returned by CATMAID command factories. */
export interface CatmaidSpatialSkeletonCommandDescriptor
  extends SpatialSkeletonEditCommand {
  readonly action: SpatialSkeletonAction;
  readonly payload: CatmaidSpatialSkeletonCommandPayload;
}

function copyVector(value: ArrayLike<number>): SpatialSkeletonVector {
  return Object.freeze(Array.from(value));
}

function uniqueResources(
  handles: readonly SpatialSkeletonLogicalResourceHandle[],
) {
  const resources = new Map<string, SpatialSkeletonIntentResource>();
  for (const handle of handles) {
    resources.set(getSpatialSkeletonLogicalResourceKey(handle), {
      handle,
      access: "write",
    });
  }
  return Object.freeze([...resources.values()]);
}

function freezeNode(node: SpatiallyIndexedSkeletonNode) {
  return Object.freeze({
    nodeId: node.nodeId,
    segmentId: node.segmentId,
    position: toCatmaidPositionInModelSpace(node.position, "node position"),
    parentNodeId: node.parentNodeId,
    radius: node.radius,
    confidence: node.confidence,
    description: node.description,
    isTrueEnd: node.isTrueEnd ?? false,
  });
}

function makeRetainedNode(
  capturedNodeId: number,
  handle: SpatialSkeletonLogicalNodeHandle,
): CatmaidRetainedNode {
  return Object.freeze({
    capturedNodeId,
    handle,
    get kind() {
      return handle.kind;
    },
    get stableId() {
      return handle.stableId;
    },
  });
}

function getDirection(
  intent: "execute" | "undo" | "redo",
): "forward" | "inverse" {
  return intent === "undo" ? "inverse" : "forward";
}

/** Deterministic, state-free policy; the generic identity service owns use. */
export const CATMAID_PROVISIONAL_NUMERIC_ID_POLICY: SpatialSkeletonProvisionalNumericIdPolicy =
  Object.freeze({
    allocateNodeId(intentId: number) {
      return 0x8000_0000 - intentId;
    },
    allocateSegmentId(intentId: number) {
      return 0xffff_fffe - intentId;
    },
  });

export class CatmaidSpatialSkeletonWorkflowDriver
  extends CatmaidWorkflowAuthorityDriverBase
  implements
    SpatialSkeletonIntentDriver<
      CatmaidSpatialSkeletonCommandDescriptor,
      CatmaidWorkflow,
      SpatialSkeletonProjectionIntentDelta,
      CatmaidOptimisticMutation,
      CatmaidOptimisticMutationResult,
      SpatialSkeletonAuthoritativeReconciliation,
      SpatialSkeletonProjectionInverseDelta
    >
{
  constructor(
    identity: SpatialSkeletonOptimisticIdentityService,
    private readonly provisionalIds: SpatialSkeletonProvisionalNumericIdService,
  ) {
    super(identity);
  }

  describeIntent(input: CatmaidSpatialSkeletonCommandDescriptor) {
    const payload = input.payload;
    return Object.freeze({
      kind: this.getQueueKind(payload.kind),
      commandLabel: input.label,
      authorityPresentation: getCatmaidOptimisticAuthorityPresentation(
        payload.kind,
      ),
      ...(payload.kind === "merge"
        ? {
            preparation: Object.freeze({
              kind: "merge" as const,
              segmentIds: Object.freeze([
                payload.options.firstNode.segmentId,
                payload.options.secondNode.segmentId,
              ]),
              endpointNodeIds: Object.freeze([
                payload.options.firstNode.nodeId,
                payload.options.secondNode.nodeId,
              ]),
              lastKnownPositions: Object.freeze(
                [payload.options.firstNode, payload.options.secondNode].flatMap(
                  (node) =>
                    node.position === undefined
                      ? []
                      : [
                          Object.freeze({
                            nodeId: node.nodeId,
                            position: node.position,
                          }),
                        ],
                ),
              ),
            }),
          }
        : {}),
    });
  }

  createLogicalIntent(
    input: CatmaidSpatialSkeletonCommandDescriptor,
    context: SpatialSkeletonIntentCreationContext<
      CatmaidWorkflow,
      SpatialSkeletonProjectionIntentDelta,
      SpatialSkeletonProjectionInverseDelta
    >,
  ): SpatialSkeletonLogicalIntent<
    CatmaidWorkflow,
    SpatialSkeletonProjectionIntentDelta
  > {
    const direction = getDirection(context.intent);
    let semantic: CatmaidSemanticRecipe;
    let delta: SpatialSkeletonProjectionDelta;
    if (context.intent === "execute") {
      semantic = this.createSemanticRecipe(
        input,
        context.intentId,
        context.queueInput,
      );
      delta = this.makeForwardDelta(semantic);
    } else {
      const prior = context.recipe;
      semantic = this.prepareHistorySemantic(
        prior.workflow.semantic,
        prior.projection.delta,
        prior.inverseProjection,
      );
      if (context.intent === "undo") {
        if (prior.inverseProjection === undefined) {
          throw new Error("CATMAID Undo is missing its canonical inverse.");
        }
        delta = prior.inverseProjection;
      } else {
        delta = this.makeForwardDelta(semantic);
      }
    }

    const projection = this.makeProjection(
      semantic,
      delta,
      context.intent,
      context.intentId,
      context.intent === "execute",
    );
    const workflow = Object.freeze({
      kind: semantic.kind,
      direction,
      semantic,
    }) as CatmaidWorkflow;
    return {
      kind: this.getQueueKind(semantic.kind),
      commandLabel: input.label,
      authorityPresentation: getCatmaidOptimisticAuthorityPresentation(
        semantic.kind,
      ),
      logicalResources: this.getLogicalResources(semantic),
      preparation: this.makePreparationDescriptor(semantic),
      projection,
      workflow,
    };
  }

  private createSemanticRecipe(
    command: CatmaidSpatialSkeletonCommandDescriptor,
    intentId: number,
    queueInput: SpatialSkeletonQueueInput,
  ): CatmaidSemanticRecipe {
    command = resolveCatmaidPreparedCommand(command, queueInput, this.identity);
    switch (command.payload.kind) {
      case "add-node":
        return this.createAddSemantic(command, intentId, queueInput);
      case "move-node":
        return this.createMoveSemantic(command, queueInput);
      case "delete-node":
        return this.createDeleteSemantic(command, queueInput);
      case "reroot":
        return this.createRerootSemantic(command, queueInput);
      case "description":
      case "true-end":
      case "radius":
      case "confidence":
        return this.createAttributeSemantic(command, queueInput);
      case "split":
        return this.createSplitSemantic(command, intentId, queueInput);
      case "merge":
        return this.createMergeSemantic(command, intentId, queueInput);
    }
  }

  /** History follows the engine's finalized canonical projection artifacts. */
  private prepareHistorySemantic(
    semantic: CatmaidSemanticRecipe,
    forwardProjection: SpatialSkeletonProjectionDelta,
    inverseProjection: SpatialSkeletonProjectionInverseDelta | undefined,
  ): CatmaidSemanticRecipe {
    if (semantic.kind === "reroot" && inverseProjection !== undefined) {
      if (inverseProjection.kind !== "restore-topology") {
        throw new Error(
          "CATMAID reroot history has an invalid canonical inverse.",
        );
      }
      const root = inverseProjection.patches.find(
        ({ parent }) => parent === null,
      );
      if (root === undefined) {
        throw new Error("CATMAID canonical reroot inverse lost its root.");
      }
      return Object.freeze({
        ...semantic,
        originalRoot: this.retainHistoryNode(root.node),
        originalRootConfidence: root.confidence,
      });
    }
    if (semantic.kind === "description") {
      if (
        forwardProjection.kind !== "node-attributes" ||
        forwardProjection.segment.stableId !== semantic.segment.stableId ||
        forwardProjection.node.stableId !== semantic.node.stableId ||
        !("description" in forwardProjection.changes)
      ) {
        throw new Error(
          "CATMAID description history has an invalid canonical projection.",
        );
      }
      const after = forwardProjection.changes.description;
      return after === semantic.after
        ? semantic
        : Object.freeze({ ...semantic, after });
    }
    if (semantic.kind === "confidence" && inverseProjection !== undefined) {
      if (
        inverseProjection.kind !== "node-attributes" ||
        inverseProjection.node.stableId !== semantic.node.stableId ||
        !("confidence" in inverseProjection.changes)
      ) {
        throw new Error(
          "CATMAID confidence history has an invalid canonical inverse.",
        );
      }
      return Object.freeze({
        ...semantic,
        before: inverseProjection.changes.confidence ?? 0,
      });
    }
    if (semantic.kind === "split" && inverseProjection !== undefined) {
      if (inverseProjection.kind !== "join-split") {
        throw new Error(
          "CATMAID split history has an invalid canonical inverse.",
        );
      }
      return Object.freeze({
        ...semantic,
        formerParent: this.retainHistoryNode(inverseProjection.formerParent),
      });
    }
    if (semantic.kind === "delete-node" && inverseProjection !== undefined) {
      if (inverseProjection.kind !== "restore-delete") {
        throw new Error(
          "CATMAID delete history has an invalid canonical inverse.",
        );
      }
      const { snapshot, children } = inverseProjection;
      const parent =
        snapshot.parent === null
          ? undefined
          : this.retainHistoryNode(snapshot.parent);
      return Object.freeze({
        ...semantic,
        parent,
        children: Object.freeze(
          children.map((node) => this.retainHistoryNode(node)),
        ),
        deletedSnapshot: freezeNode({
          ...semantic.deletedSnapshot,
          ...snapshot.attributes,
          position: snapshot.position,
          parentNodeId: parent?.capturedNodeId,
        }),
        wasSoleRoot: parent === undefined && children.length === 0,
      });
    }
    if (semantic.kind !== "merge") return semantic;
    if (inverseProjection === undefined) return semantic;
    if (inverseProjection.kind !== "unmerge") {
      throw new Error(
        "CATMAID merge history has an invalid canonical inverse.",
      );
    }
    const inverseOrientation =
      inverseProjection.firstNode.stableId === semantic.firstNode.stableId &&
      inverseProjection.secondNode.stableId === semantic.secondNode.stableId
        ? ("second-from-first" as const)
        : inverseProjection.firstNode.stableId ===
              semantic.secondNode.stableId &&
            inverseProjection.secondNode.stableId ===
              semantic.firstNode.stableId
          ? ("first-from-second" as const)
          : undefined;
    if (inverseOrientation === undefined)
      throw new Error("CATMAID canonical merge inverse lost its endpoints.");
    const originalRoot = inverseProjection.formerSecondTopology.find(
      ({ parent }) => parent === null,
    );
    if (originalRoot === undefined)
      throw new Error("CATMAID canonical merge inverse lost its root.");
    return Object.freeze({
      ...semantic,
      inverseOrientation,
      originalRoot: this.retainHistoryNode(originalRoot.node),
      originalRootConfidence: originalRoot.confidence,
    });
  }

  private retainHistoryNode(handle: SpatialSkeletonLogicalNodeHandle) {
    const nodeId = this.identity.resolveNode(handle);
    if (nodeId === undefined) {
      throw new Error(
        "CATMAID canonical history node has no numeric identity.",
      );
    }
    return makeRetainedNode(nodeId, handle);
  }

  private makeForwardDelta(
    semantic: CatmaidSemanticRecipe,
  ): SpatialSkeletonProjectionDelta {
    switch (semantic.kind) {
      case "add-node":
        if (semantic.children?.length) {
          return Object.freeze({
            kind: "restore-delete",
            segment: semantic.segment,
            snapshot: Object.freeze({
              node: semantic.node,
              parent: semantic.parent ?? null,
              position: semantic.position,
              attributes: semantic.attributes,
            }),
            children: semantic.children,
          });
        }
        return Object.freeze({
          kind: "add",
          segment: semantic.segment,
          node: semantic.node,
          parent: semantic.parent,
          position: semantic.position,
          attributes: semantic.attributes,
        });
      case "move-node":
        return Object.freeze({
          kind: "move",
          segment: semantic.segment,
          node: semantic.node,
          position: semantic.after,
        });
      case "delete-node":
        return Object.freeze({
          kind: "delete",
          segment: semantic.segment,
          node: semantic.node,
        });
      case "description":
        return Object.freeze({
          kind: "node-attributes",
          segment: semantic.segment,
          node: semantic.node,
          changes: Object.freeze({
            description: semantic.after as string | undefined,
          }),
        });
      case "true-end":
        return Object.freeze({
          kind: "node-attributes",
          segment: semantic.segment,
          node: semantic.node,
          changes: Object.freeze({
            isTrueEnd: semantic.after as boolean | undefined,
          }),
        });
      case "radius":
        return Object.freeze({
          kind: "node-attributes",
          segment: semantic.segment,
          node: semantic.node,
          changes: Object.freeze({
            radius: semantic.after as number | undefined,
          }),
        });
      case "confidence":
        return Object.freeze({
          kind: "node-attributes",
          segment: semantic.segment,
          node: semantic.node,
          changes: Object.freeze({
            confidence: semantic.after as number | undefined,
          }),
        });
      case "reroot":
        return Object.freeze({
          kind: "reroot",
          segment: semantic.segment,
          node: semantic.node,
        });
      case "split":
        return Object.freeze({
          kind: "split",
          sourceSegment: semantic.sourceSegment,
          downstreamSegment: semantic.downstreamSegment,
          node: semantic.node,
        });
      case "merge":
        return semantic.inverseOrientation === "second-from-first"
          ? Object.freeze({
              kind: "merge" as const,
              firstSegment: semantic.firstSegment,
              secondSegment: semantic.secondSegment,
              resultSegment: semantic.mergedSegment,
              firstNode: semantic.firstNode,
              secondNode: semantic.secondNode,
            })
          : Object.freeze({
              kind: "merge" as const,
              firstSegment: semantic.secondSegment,
              secondSegment: semantic.firstSegment,
              resultSegment: semantic.mergedSegment,
              firstNode: semantic.secondNode,
              secondNode: semantic.firstNode,
            });
    }
  }

  private getLogicalResources(
    semantic: CatmaidSemanticRecipe,
  ): readonly SpatialSkeletonIntentResource[] {
    switch (semantic.kind) {
      case "add-node":
      case "delete-node":
      case "move-node":
      case "description":
      case "true-end":
      case "radius":
      case "confidence":
      case "reroot":
        return uniqueResources([semantic.segment]);
      case "split":
        return uniqueResources([
          semantic.sourceSegment,
          semantic.downstreamSegment,
        ]);
      case "merge":
        return uniqueResources([
          semantic.firstSegment,
          semantic.secondSegment,
          semantic.mergedSegment,
        ]);
    }
  }

  private makePreparationDescriptor(
    semantic: CatmaidSemanticRecipe,
  ): SpatialSkeletonOptimisticPreparationDescriptor | undefined {
    switch (semantic.kind) {
      case "delete-node":
        return Object.freeze({
          kind: "delete",
          logicalNodeHandles: Object.freeze([semantic.node]),
          logicalSegmentHandles: Object.freeze([semantic.segment]),
          segmentIds: Object.freeze(
            semantic.capturedSegments.map(({ physicalId }) => physicalId),
          ),
          nodeId: semantic.node.capturedNodeId,
          lastKnownPositions: Object.freeze([
            {
              nodeId: semantic.deletedSnapshot.nodeId,
              position: semantic.deletedSnapshot.position,
            },
          ]),
        });
      case "reroot":
        return Object.freeze({
          kind: "reroot",
          logicalNodeHandles: Object.freeze([
            semantic.node,
            semantic.originalRoot,
          ]),
          logicalSegmentHandles: Object.freeze([semantic.segment]),
          segmentIds: Object.freeze(
            semantic.capturedSegments.map(({ physicalId }) => physicalId),
          ),
          nodeId: semantic.node.capturedNodeId,
          rootNodeId: semantic.originalRoot.capturedNodeId,
        });
      case "split":
        return Object.freeze({
          kind: "split",
          logicalNodeHandles: Object.freeze([
            semantic.node,
            semantic.formerParent,
          ]),
          logicalSegmentHandles: Object.freeze([
            semantic.sourceSegment,
            semantic.downstreamSegment,
          ]),
          segmentIds: Object.freeze(
            semantic.capturedSegments.map(({ physicalId }) => physicalId),
          ),
          cutNodeId: semantic.node.capturedNodeId,
          cutParentNodeId: semantic.formerParent.capturedNodeId,
        });
      case "merge":
        return Object.freeze({
          kind: "merge",
          logicalNodeHandles: Object.freeze([
            semantic.firstNode,
            semantic.secondNode,
          ]),
          logicalSegmentHandles: Object.freeze([
            semantic.firstSegment,
            semantic.secondSegment,
            semantic.mergedSegment,
          ]),
          segmentIds: Object.freeze(
            semantic.capturedSegments.map(({ physicalId }) => physicalId),
          ),
          endpointNodeIds: Object.freeze([
            semantic.firstNode.capturedNodeId,
            semantic.secondNode.capturedNodeId,
          ]),
        });
      default:
        return undefined;
    }
  }

  private captureSegments(
    queueInput: SpatialSkeletonQueueInput,
    segmentIds: readonly number[],
    eagerNodeIds: readonly number[],
  ) {
    const captured: CatmaidCapturedSegment[] = [];
    for (const segmentId of new Set(segmentIds)) {
      const entry = this.requireQueueInputSegment(queueInput, segmentId);
      const segment = this.segmentHandle(segmentId);
      captured.push(
        Object.freeze({
          segment,
          physicalId: segmentId,
          snapshot: entry.snapshot,
          cacheRevision: entry.cacheRevision,
        }),
      );
    }
    const requestedNodeIds = [...new Set(eagerNodeIds)];
    for (const nodeId of requestedNodeIds) {
      if (
        !captured.some(({ snapshot }) => snapshot.getNode(nodeId) !== undefined)
      ) {
        throw new Error(`CATMAID queue input is missing node ${nodeId}.`);
      }
    }
    const handles = this.identity.getOrCreateNodeHandles(requestedNodeIds);
    return {
      capturedSegments: Object.freeze(captured),
      retainedNodes: new Map(
        requestedNodeIds.map(
          (nodeId) =>
            [nodeId, makeRetainedNode(nodeId, handles.get(nodeId)!)] as const,
        ),
      ),
    };
  }

  private getRetainedNode(
    capture: {
      readonly retainedNodes: ReadonlyMap<number, CatmaidRetainedNode>;
    },
    nodeId: number,
  ) {
    return capture.retainedNodes.get(nodeId)!;
  }

  private requireQueueInputSegment(
    queueInput: SpatialSkeletonQueueInput,
    segmentId: number,
  ) {
    const entry = queueInput.segments.find(
      (candidate) => candidate.segmentId === segmentId,
    );
    if (entry === undefined) {
      throw new Error(
        `CATMAID edit requires admitted complete skeleton ${segmentId}.`,
      );
    }
    return entry;
  }

  private getPathToRoot(
    snapshot: CompleteSkeletonSnapshotHandle,
    targetNodeId: number,
  ) {
    const path: SpatiallyIndexedSkeletonNode[] = [];
    const seen = new Set<number>();
    let current = snapshot.getNode(targetNodeId);
    if (current === undefined) {
      throw new Error(`CATMAID queue input is missing node ${targetNodeId}.`);
    }
    while (current !== undefined) {
      if (seen.has(current.nodeId)) {
        throw new Error("CATMAID retained path to root is cyclic.");
      }
      seen.add(current.nodeId);
      path.push(current);
      if (current.parentNodeId === undefined) break;
      const parent = snapshot.getNode(current.parentNodeId);
      if (parent === undefined) {
        throw new Error(
          `CATMAID retained path is missing parent ${current.parentNodeId}.`,
        );
      }
      current = parent;
    }
    return Object.freeze(path);
  }

  private requireCapturedNode(
    capture: ReturnType<
      CatmaidSpatialSkeletonWorkflowDriver["captureSegments"]
    >,
    nodeId: number,
  ) {
    for (const { snapshot } of capture.capturedSegments) {
      const node = snapshot.getNode(nodeId);
      if (node !== undefined) return freezeNode(node);
    }
    throw new Error(`CATMAID queue input is missing node ${nodeId}.`);
  }

  private createAddSemantic(
    command: CatmaidSpatialSkeletonCommandDescriptor,
    intentId: number,
    queueInput: SpatialSkeletonQueueInput,
  ): CatmaidCreatedNodeSemantic {
    if (command.payload.kind !== "add-node")
      throw new Error("Invalid add recipe.");
    const { options } = command.payload;
    const capture =
      options.parentNodeId === undefined
        ? {
            capturedSegments: Object.freeze([]),
            retainedNodes: new Map<number, CatmaidRetainedNode>(),
          }
        : this.captureSegments(
            queueInput,
            [options.skeletonId],
            [options.parentNodeId, ...(options.childNodeIds ?? [])],
          );
    const parent =
      options.parentNodeId === undefined
        ? undefined
        : this.getRetainedNode(capture, options.parentNodeId);
    const children = Object.freeze(
      (options.childNodeIds ?? []).map((nodeId) => {
        const child = this.requireCapturedNode(capture, nodeId);
        if (
          child.parentNodeId !== options.parentNodeId ||
          child.segmentId !== options.skeletonId
        ) {
          throw new Error(
            `Node ${nodeId} is not a child of node ${options.parentNodeId}.`,
          );
        }
        return this.getRetainedNode(capture, nodeId);
      }),
    );
    const node = spatialSkeletonLogicalNode(`intent:${intentId}:created-node`);
    const createsSegment = parent === undefined;
    const segment = createsSegment
      ? spatialSkeletonLogicalSegment(`intent:${intentId}:created-segment`)
      : this.segmentHandle(options.skeletonId);
    const position = copyVector(options.positionInModelSpace);
    return Object.freeze({
      kind: "add-node",
      ...capture,
      node,
      segment,
      parent,
      position,
      attributes: CATMAID_CREATED_NODE_ATTRIBUTES,
      createsSegment,
      children,
    });
  }

  private createMoveSemantic(
    command: CatmaidSpatialSkeletonCommandDescriptor,
    queueInput: SpatialSkeletonQueueInput,
  ): CatmaidMoveNodeSemantic {
    if (command.payload.kind !== "move-node")
      throw new Error("Invalid move recipe.");
    const { options } = command.payload;
    const capture = this.captureSegments(
      queueInput,
      [options.node.segmentId],
      [options.node.nodeId],
    );
    const nodeSnapshot = this.requireCapturedNode(capture, options.node.nodeId);
    const node = this.getRetainedNode(capture, nodeSnapshot.nodeId)!;
    const segment = this.segmentHandle(nodeSnapshot.segmentId);
    const before = copyVector(nodeSnapshot.position);
    const after = copyVector(options.nextPositionInModelSpace);
    return Object.freeze({
      kind: "move-node",
      ...capture,
      node,
      segment,
      before,
      after,
    });
  }

  private createDeleteSemantic(
    command: CatmaidSpatialSkeletonCommandDescriptor,
    queueInput: SpatialSkeletonQueueInput,
  ): CatmaidDeleteNodeSemantic {
    if (command.payload.kind !== "delete-node") {
      throw new Error("Invalid delete recipe.");
    }
    const segmentId = command.payload.node.segmentId;
    const entry = this.requireQueueInputSegment(queueInput, segmentId);
    const rawDeleted = entry.snapshot.getNode(command.payload.node.nodeId);
    if (rawDeleted === undefined) {
      throw new Error(
        `CATMAID queue input is missing node ${command.payload.node.nodeId}.`,
      );
    }
    const childIds: number[] = [];
    entry.snapshot.forEachNode((candidate) => {
      if (candidate.parentNodeId === rawDeleted.nodeId) {
        childIds.push(candidate.nodeId);
      }
    });
    if (rawDeleted.parentNodeId === undefined && childIds.length !== 0) {
      throw new Error(
        "Deleting a root node with children is blocked. Reroot the skeleton manually before deleting it.",
      );
    }
    const eagerNodeIds = [
      rawDeleted.nodeId,
      ...(rawDeleted.parentNodeId === undefined
        ? []
        : [rawDeleted.parentNodeId]),
      ...childIds,
    ];
    const capture = this.captureSegments(queueInput, [segmentId], eagerNodeIds);
    const deletedSnapshot = freezeNode(rawDeleted);
    const children = childIds.map(
      (nodeId) => this.getRetainedNode(capture, nodeId)!,
    );
    const node = this.getRetainedNode(capture, deletedSnapshot.nodeId)!;
    const parent =
      deletedSnapshot.parentNodeId === undefined
        ? undefined
        : this.getRetainedNode(capture, deletedSnapshot.parentNodeId);
    const segment = capture.capturedSegments[0].segment;
    return Object.freeze({
      kind: "delete-node",
      ...capture,
      node,
      segment,
      parent,
      children: Object.freeze(children),
      deletedSnapshot,
      wasSoleRoot: entry.snapshot.nodeCount === 1,
    });
  }

  private createAttributeSemantic(
    command: CatmaidSpatialSkeletonCommandDescriptor,
    queueInput: SpatialSkeletonQueueInput,
  ): CatmaidAttributeSemantic {
    const payload = command.payload;
    if (
      payload.kind !== "description" &&
      payload.kind !== "true-end" &&
      payload.kind !== "radius" &&
      payload.kind !== "confidence"
    ) {
      throw new Error("Invalid CATMAID attribute recipe.");
    }
    const options = payload.options;
    const capture = this.captureSegments(
      queueInput,
      [options.node.segmentId],
      [options.node.nodeId],
    );
    const nodeSnapshot = this.requireCapturedNode(capture, options.node.nodeId);
    const node = this.getRetainedNode(capture, nodeSnapshot.nodeId)!;
    const segment = capture.capturedSegments[0].segment;
    let before: string | boolean | number | undefined;
    let after: string | boolean | number | undefined;
    switch (payload.kind) {
      case "description":
        before = nodeSnapshot.description;
        after = payload.options.nextDescription;
        break;
      case "true-end":
        before = nodeSnapshot.isTrueEnd ?? false;
        after = payload.options.nextIsTrueEnd;
        if (after) {
          if (nodeSnapshot.parentNodeId === undefined) {
            throw new Error("Cannot set the root node as a true end.");
          }
          let hasChild = false;
          capture.capturedSegments[0].snapshot.forEachNode((candidate) => {
            if (candidate.parentNodeId === nodeSnapshot.nodeId) hasChild = true;
          });
          if (hasChild) {
            throw new Error("Only leaf nodes can be marked as true ends.");
          }
        }
        break;
      case "radius":
        before = nodeSnapshot.radius ?? 0;
        after = payload.options.nextRadius;
        break;
      case "confidence":
        before = nodeSnapshot.confidence ?? 0;
        after = payload.options.nextConfidence;
        break;
    }
    return Object.freeze({
      kind: payload.kind,
      ...capture,
      node,
      segment,
      nodeSnapshot,
      before,
      after,
    });
  }

  private createRerootSemantic(
    command: CatmaidSpatialSkeletonCommandDescriptor,
    queueInput: SpatialSkeletonQueueInput,
  ): CatmaidRerootSemantic {
    if (command.payload.kind !== "reroot")
      throw new Error("Invalid reroot recipe.");
    const segmentId = command.payload.node.segmentId;
    const entry = this.requireQueueInputSegment(queueInput, segmentId);
    const path = this.getPathToRoot(
      entry.snapshot,
      command.payload.node.nodeId,
    );
    const capture = this.captureSegments(
      queueInput,
      [segmentId],
      path.map(({ nodeId }) => nodeId),
    );
    const target = path[0];
    const root = path.at(-1)!;
    const node = this.getRetainedNode(capture, target.nodeId)!;
    const originalRoot = this.getRetainedNode(capture, root.nodeId)!;
    const segment = capture.capturedSegments[0].segment;
    return Object.freeze({
      kind: "reroot",
      ...capture,
      node,
      originalRoot,
      originalRootConfidence: root.confidence,
      segment,
    });
  }

  private createSplitSemantic(
    command: CatmaidSpatialSkeletonCommandDescriptor,
    intentId: number,
    queueInput: SpatialSkeletonQueueInput,
  ): CatmaidSplitSemantic {
    if (command.payload.kind !== "split")
      throw new Error("Invalid split recipe.");
    const segmentId = command.payload.node.segmentId;
    const entry = this.requireQueueInputSegment(queueInput, segmentId);
    const target = entry.snapshot.getNode(command.payload.node.nodeId);
    if (target === undefined) {
      throw new Error(
        `CATMAID queue input is missing node ${command.payload.node.nodeId}.`,
      );
    }
    if (target.parentNodeId === undefined)
      throw new Error("Cannot split at the root node.");
    const capture = this.captureSegments(
      queueInput,
      [segmentId],
      [target.nodeId, target.parentNodeId],
    );
    const sourceSegment = capture.capturedSegments[0].segment;
    const downstreamSegment = spatialSkeletonLogicalSegment(
      `intent:${intentId}:split-output`,
    );
    const node = this.getRetainedNode(capture, target.nodeId)!;
    const formerParent = this.getRetainedNode(capture, target.parentNodeId)!;
    return Object.freeze({
      kind: "split",
      ...capture,
      sourceSegment,
      downstreamSegment,
      node,
      formerParent,
    });
  }

  private createMergeSemantic(
    command: CatmaidSpatialSkeletonCommandDescriptor,
    intentId: number,
    queueInput: SpatialSkeletonQueueInput,
  ): CatmaidMergeSemantic {
    if (command.payload.kind !== "merge")
      throw new Error("Invalid merge recipe.");
    const { firstNode, secondNode } = command.payload.options;
    if (firstNode.segmentId === secondNode.segmentId) {
      throw new Error("Cannot merge nodes from the same skeleton.");
    }
    const firstEntry = this.requireQueueInputSegment(
      queueInput,
      firstNode.segmentId,
    );
    const secondEntry = this.requireQueueInputSegment(
      queueInput,
      secondNode.segmentId,
    );
    const firstPath = this.getPathToRoot(firstEntry.snapshot, firstNode.nodeId);
    const secondPath = this.getPathToRoot(
      secondEntry.snapshot,
      secondNode.nodeId,
    );
    const capture = this.captureSegments(
      queueInput,
      [firstNode.segmentId, secondNode.segmentId],
      [
        ...firstPath.map(({ nodeId }) => nodeId),
        ...secondPath.map(({ nodeId }) => nodeId),
      ],
    );
    const first = this.requireCapturedNode(capture, firstNode.nodeId);
    const second = this.requireCapturedNode(capture, secondNode.nodeId);
    const secondRoot = secondPath.at(-1)!;
    const firstSegment = this.segmentHandle(first.segmentId);
    const secondSegment = this.segmentHandle(second.segmentId);
    const mergedSegment = spatialSkeletonLogicalSegment(
      `intent:${intentId}:merge-output`,
    );
    const firstHandle = this.getRetainedNode(capture, first.nodeId)!;
    const secondHandle = this.getRetainedNode(capture, second.nodeId)!;
    return Object.freeze({
      kind: "merge",
      ...capture,
      firstSegment,
      secondSegment,
      mergedSegment,
      firstNode: firstHandle,
      secondNode: secondHandle,
      originalRoot: this.getRetainedNode(capture, secondRoot.nodeId)!,
      originalRootConfidence: secondRoot.confidence,
      inverseOrientation: "second-from-first",
    });
  }

  private getCapturedNodeForHint(
    semantic: CatmaidSemanticRecipe,
    retained: CatmaidRetainedNode,
  ) {
    for (const { snapshot } of semantic.capturedSegments) {
      const node = snapshot.getNode(retained.capturedNodeId);
      if (node !== undefined) return node;
    }
    return undefined;
  }

  /**
   * CATMAID describes user intent with logical handles; the generic runtime
   * resolves and applies these wishes after its model adoption. Nothing here
   * owns selection, visibility, or remapping state.
   */
  private makeUiHints(
    semantic: CatmaidSemanticRecipe,
    direction: "forward" | "inverse",
    intent: "execute" | "undo" | "redo",
    allowNavigation = true,
  ): SpatialSkeletonProjectionUiHints {
    const segmentVisibility: Array<
      NonNullable<SpatialSkeletonProjectionUiHints["segmentVisibility"]>[number]
    > = [];
    const segmentMembershipRemaps: Array<
      NonNullable<
        SpatialSkeletonProjectionUiHints["segmentMembershipRemaps"]
      >[number]
    > = [];
    const retainSegments: SpatialSkeletonLogicalSegmentHandle[] = [];
    let selectedNode: SpatialSkeletonProjectionUiHints["selectedNode"];
    const select = (
      node: SpatialSkeletonLogicalNodeHandle,
      segment: SpatialSkeletonLogicalSegmentHandle,
      position?: ArrayLike<number>,
      moveView = false,
    ) => {
      selectedNode = Object.freeze({
        kind: "select" as const,
        node,
        segment,
        ...(position === undefined
          ? {}
          : { position: Object.freeze(Array.from(position, Number)) }),
        pin: "preserve" as const,
        moveView: allowNavigation && moveView,
      });
    };
    const show = (
      segment: SpatialSkeletonLogicalSegmentHandle,
      selection?: "preserve" | "pin" | "unpin",
    ) => {
      segmentVisibility.push(
        Object.freeze({
          segment,
          visible: true,
          ...(selection === undefined ? {} : { select: selection }),
        }),
      );
    };
    const hide = (segment: SpatialSkeletonLogicalSegmentHandle) => {
      segmentVisibility.push(
        Object.freeze({ segment, visible: false, deselect: true }),
      );
    };

    switch (semantic.kind) {
      case "add-node":
        if (direction === "forward") {
          show(semantic.segment, intent === "execute" ? "pin" : "preserve");
          select(
            semantic.node,
            semantic.segment,
            semantic.position,
            intent === "execute",
          );
          retainSegments.push(semantic.segment);
        } else {
          if (semantic.createsSegment) hide(semantic.segment);
          if (semantic.parent === undefined) {
            selectedNode = Object.freeze({ kind: "clear" });
          } else {
            const parent = this.getCapturedNodeForHint(
              semantic,
              semantic.parent,
            );
            select(semantic.parent, semantic.segment, parent?.position, false);
            retainSegments.push(semantic.segment);
          }
        }
        break;
      case "delete-node":
        if (direction === "forward") {
          if (semantic.wasSoleRoot) hide(semantic.segment);
          if (semantic.parent === undefined) {
            selectedNode = Object.freeze({ kind: "clear" });
          } else {
            const parent = this.getCapturedNodeForHint(
              semantic,
              semantic.parent,
            );
            select(
              semantic.parent,
              semantic.segment,
              parent?.position,
              intent === "execute",
            );
            retainSegments.push(semantic.segment);
          }
        } else {
          show(semantic.segment, "preserve");
          select(
            semantic.node,
            semantic.segment,
            semantic.deletedSnapshot.position,
          );
          retainSegments.push(semantic.segment);
        }
        break;
      case "move-node":
        selectedNode = Object.freeze({
          kind: "refresh-if-selected",
          node: semantic.node,
          segment: semantic.segment,
          position: direction === "forward" ? semantic.after : semantic.before,
        });
        retainSegments.push(semantic.segment);
        break;
      case "description":
      case "true-end":
      case "radius":
      case "confidence":
        retainSegments.push(semantic.segment);
        break;
      case "reroot": {
        const target =
          direction === "forward" ? semantic.node : semantic.originalRoot;
        const snapshot = this.getCapturedNodeForHint(semantic, target);
        show(semantic.segment);
        select(target, semantic.segment, snapshot?.position);
        retainSegments.push(semantic.segment);
        break;
      }
      case "split":
        if (direction === "forward") {
          show(semantic.sourceSegment);
          show(semantic.downstreamSegment, "pin");
          select(semantic.node, semantic.downstreamSegment);
          retainSegments.push(
            semantic.sourceSegment,
            semantic.downstreamSegment,
          );
        } else {
          segmentMembershipRemaps.push(
            Object.freeze({
              from: semantic.downstreamSegment,
              to: semantic.sourceSegment,
            }),
          );
          show(semantic.sourceSegment);
          hide(semantic.downstreamSegment);
          select(semantic.node, semantic.sourceSegment);
          retainSegments.push(semantic.sourceSegment);
        }
        break;
      case "merge": {
        const forwardFirstSegment =
          semantic.inverseOrientation === "second-from-first"
            ? semantic.firstSegment
            : semantic.secondSegment;
        const forwardSecondSegment =
          semantic.inverseOrientation === "second-from-first"
            ? semantic.secondSegment
            : semantic.firstSegment;
        const forwardSecondNode =
          semantic.inverseOrientation === "second-from-first"
            ? semantic.secondNode
            : semantic.firstNode;
        if (direction === "forward") {
          segmentMembershipRemaps.push(
            Object.freeze({
              from: semantic.firstSegment,
              to: semantic.mergedSegment,
            }),
            Object.freeze({
              from: semantic.secondSegment,
              to: semantic.mergedSegment,
            }),
          );
          show(semantic.mergedSegment, "preserve");
          hide(forwardSecondSegment);
          select(forwardSecondNode, semantic.mergedSegment);
          retainSegments.push(semantic.mergedSegment);
        } else {
          show(forwardFirstSegment);
          show(forwardSecondSegment);
          select(forwardSecondNode, forwardSecondSegment);
          retainSegments.push(forwardFirstSegment, forwardSecondSegment);
        }
        break;
      }
    }

    return Object.freeze({
      segmentMembershipRemaps: Object.freeze(segmentMembershipRemaps),
      segmentVisibility: Object.freeze(segmentVisibility),
      ...(selectedNode === undefined ? {} : { selectedNode }),
      retainSegments: Object.freeze(retainSegments),
    });
  }

  private makeProjection(
    semantic: CatmaidSemanticRecipe,
    delta: SpatialSkeletonProjectionDelta,
    intent: "execute" | "undo" | "redo",
    intentId: number,
    includeInspectionSeed: boolean,
  ): SpatialSkeletonProjectionIntentDelta {
    const direction = getDirection(intent);
    const seed = includeInspectionSeed
      ? this.captureRetainedInspectionSeed(semantic)
      : undefined;
    const nodeBindings: Array<
      readonly [SpatialSkeletonLogicalNodeHandle, number]
    > = [];
    const segmentBindings: Array<
      readonly [SpatialSkeletonLogicalSegmentHandle, number]
    > = [];
    if (semantic.kind === "add-node" && direction === "forward") {
      nodeBindings.push([
        semantic.node,
        this.provisionalIds.allocateNodeId(intentId),
      ]);
      if (semantic.createsSegment) {
        segmentBindings.push([
          semantic.segment,
          this.provisionalIds.allocateSegmentId(intentId),
        ]);
      }
    } else if (semantic.kind === "delete-node" && direction === "inverse") {
      nodeBindings.push([
        semantic.node,
        this.provisionalIds.allocateNodeId(intentId),
      ]);
      if (semantic.wasSoleRoot) {
        segmentBindings.push([
          semantic.segment,
          this.provisionalIds.allocateSegmentId(intentId),
        ]);
      }
    } else if (semantic.kind === "split" && direction === "forward") {
      segmentBindings.push([
        semantic.downstreamSegment,
        this.provisionalIds.allocateSegmentId(intentId),
      ]);
    } else if (semantic.kind === "merge" && direction === "forward") {
      // The result has its own logical identity. Borrowing an input's current
      // ID would leave it stale if that input saves under a different ID.
      segmentBindings.push([
        semantic.mergedSegment,
        this.provisionalIds.allocateSegmentId(intentId),
      ]);
    } else if (semantic.kind === "merge" && direction === "inverse") {
      const restoredSegment =
        delta.kind === "unmerge" ? delta.secondSegment : semantic.secondSegment;
      segmentBindings.push([
        restoredSegment,
        this.provisionalIds.allocateSegmentId(intentId),
      ]);
    }
    return Object.freeze({
      delta,
      ...(seed === undefined ? {} : { inspectionSeed: seed }),
      ...(nodeBindings.length === 0 && segmentBindings.length === 0
        ? {}
        : {
            provisionalBindings: Object.freeze({
              nodes: Object.freeze(nodeBindings),
              segments: Object.freeze(segmentBindings),
            }),
          }),
      uiHints: this.makeUiHints(semantic, direction, intent),
      rollbackUiHints: this.makeUiHints(
        semantic,
        direction === "forward" ? "inverse" : "forward",
        intent,
        false,
      ),
      preparationIntentId: intentId,
    });
  }

  private captureRetainedInspectionSeed(
    semantic: CatmaidSemanticRecipe,
  ): SpatialSkeletonProjectionInspectionSeed {
    const segments: Array<{
      readonly segment: SpatialSkeletonLogicalSegmentHandle;
      readonly snapshot: CompleteSkeletonSnapshotHandle;
    }> = [];
    const nodeBindings: Array<
      readonly [SpatialSkeletonLogicalNodeHandle, number]
    > = [];
    const segmentBindings: Array<
      readonly [SpatialSkeletonLogicalSegmentHandle, number]
    > = [];
    const expectedCacheRevisions = new Map<number, number>();
    const seenNodes = new Set<string>();
    const seenSegments = new Set<string>();
    for (const captured of semantic.capturedSegments) {
      const resourceHandle = captured.segment;
      const target = this.identity.resolveSegmentTarget(resourceHandle);
      const segmentId = captured.physicalId;
      if (!seenSegments.has(resourceHandle.stableId)) {
        segments.push({ segment: resourceHandle, snapshot: captured.snapshot });
        seenSegments.add(resourceHandle.stableId);
      }
      expectedCacheRevisions.set(segmentId, captured.cacheRevision);
      if (target.state !== "provisional") {
        segmentBindings.push([resourceHandle, segmentId]);
      }
    }
    for (const {
      capturedNodeId: nodeId,
      handle,
    } of semantic.retainedNodes.values()) {
      if (seenNodes.has(handle.stableId)) continue;
      const nodeTarget = this.identity.resolveNodeTarget(handle);
      if (nodeTarget.state !== "provisional") {
        nodeBindings.push([handle, nodeId]);
      }
      seenNodes.add(handle.stableId);
    }

    return Object.freeze({
      segments: Object.freeze(segments),
      authoritativeBindings: Object.freeze({
        nodes: Object.freeze(nodeBindings),
        segments: Object.freeze(segmentBindings),
      }),
      expectedCacheRevisions,
    });
  }

  private getQueueKind(kind: CatmaidSemanticRecipe["kind"]) {
    switch (kind) {
      case "add-node":
        return "addNode";
      case "move-node":
        return "moveNode";
      case "delete-node":
        return "deleteNode";
      case "reroot":
        return "rerootSkeleton";
      case "description":
        return "editDescription";
      case "true-end":
        return "editTrueEnd";
      case "radius":
        return "editRadius";
      case "confidence":
        return "editConfidence";
      case "split":
        return "splitSkeleton";
      case "merge":
        return "mergeSkeletons";
    }
  }
}
