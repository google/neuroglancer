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

import type { CatmaidClient } from "#src/datasource/catmaid/api.js";
import {
  type CatmaidSpatialSkeletonCommandPayload,
  requireCatmaidAddNodeCommandOptions,
  requireCatmaidDeleteNodeCommandPayload,
  requireCatmaidMergeCommandPayload,
  requireCatmaidMoveNodeCommandOptions,
  requireCatmaidInsertNodeCommandOptions,
  requireCatmaidNodeConfidenceCommandOptions,
  requireCatmaidNodeDescriptionCommandOptions,
  requireCatmaidNodeRadiusCommandOptions,
  requireCatmaidNodeTrueEndCommandOptions,
  requireCatmaidRerootCommandPayload,
  requireCatmaidSplitCommandPayload,
} from "#src/datasource/catmaid/spatial_skeleton_edit/command_payloads.js";
import type { CatmaidSpatialSkeletonEditOperations } from "#src/datasource/catmaid/spatial_skeleton_edit/edit_operations.js";
import { CatmaidSpatialSkeletonOptimisticMutationAdapter } from "#src/datasource/catmaid/spatial_skeleton_edit/mutation_adapter.js";
import { getCatmaidMutationScope } from "#src/datasource/catmaid/spatial_skeleton_edit/mutation_scope.js";
import {
  getCatmaidQueueInputRequirement,
  getCatmaidQueueInputRequirements,
  getCatmaidMergeQueueInputRequirements,
} from "#src/datasource/catmaid/spatial_skeleton_edit/queue_input_requirements.js";
import {
  CATMAID_PROVISIONAL_NUMERIC_ID_POLICY,
  CatmaidSpatialSkeletonWorkflowDriver,
  type CatmaidSpatialSkeletonCommandDescriptor,
} from "#src/datasource/catmaid/spatial_skeleton_edit/workflow_driver.js";
import type {
  CatmaidSpatialSkeletonAddNodeRequest,
  CatmaidSpatialSkeletonAddNodeResult,
  CatmaidSpatialSkeletonConfidenceUpdateRequest,
  CatmaidSpatialSkeletonDeleteNodeRequest,
  CatmaidSpatialSkeletonDescriptionUpdateRequest,
  CatmaidSpatialSkeletonDescriptionUpdateResult,
  CatmaidSpatialSkeletonInsertNodeRequest,
  CatmaidSpatialSkeletonInsertNodeResult,
  CatmaidSpatialSkeletonMergeRequest,
  CatmaidSpatialSkeletonMergeResult,
  CatmaidSpatialSkeletonMoveNodeRequest,
  CatmaidSpatialSkeletonRadiusUpdateRequest,
  CatmaidSpatialSkeletonRerootRequest,
  CatmaidSpatialSkeletonSplitRequest,
  CatmaidSpatialSkeletonSplitResult,
  CatmaidSpatialSkeletonTrueEndUpdateRequest,
} from "#src/datasource/catmaid/spatial_skeleton_edit_api.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import type { SpatialSkeletonEditCommandFactory } from "#src/skeleton/command_factories.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
  type SpatialSkeletonCommandContext,
  type SpatialSkeletonEditCommand,
  type SpatialSkeletonQueueInputRequirements,
} from "#src/skeleton/command_protocol.js";
import type {
  SpatialSkeletonOptimisticDriverRegistration,
  SpatialSkeletonOptimisticEditingProvider,
} from "#src/skeleton/optimistic_edit/api.js";

export interface CatmaidSpatialSkeletonEditCommandContext {
  getClient(): CatmaidClient;
}

function getCatmaidEditPosition(
  position: SpatialSkeletonVector,
): readonly [number, number, number] {
  const value = Array.from(position, Number);
  return Object.freeze([value[0]!, value[1]!, value[2]!] as const);
}

function cloneNode(node: SpatiallyIndexedSkeletonNode) {
  return Object.freeze({
    ...node,
    position: getCatmaidEditPosition(node.position),
  });
}

function freezePayload(
  payload: CatmaidSpatialSkeletonCommandPayload,
): CatmaidSpatialSkeletonCommandPayload {
  switch (payload.kind) {
    case "add-node":
      return Object.freeze({
        kind: payload.kind,
        options: Object.freeze({
          ...payload.options,
          ...(payload.options.childNodeIds === undefined
            ? {}
            : {
                childNodeIds: Object.freeze([...payload.options.childNodeIds]),
              }),
          positionInModelSpace: getCatmaidEditPosition(
            payload.options.positionInModelSpace,
          ),
        }),
      });
    case "move-node":
      return Object.freeze({
        kind: payload.kind,
        options: Object.freeze({
          node: cloneNode(payload.options.node),
          nextPositionInModelSpace: getCatmaidEditPosition(
            payload.options.nextPositionInModelSpace,
          ),
        }),
      });
    case "delete-node":
      return Object.freeze({
        kind: payload.kind,
        node: cloneNode(payload.node),
      });
    case "reroot":
    case "split":
      return Object.freeze({
        kind: payload.kind,
        node: Object.freeze({
          ...payload.node,
          ...(payload.node.position === undefined
            ? {}
            : {
                position: getCatmaidEditPosition(payload.node.position),
              }),
        }),
      });
    case "description":
    case "true-end":
    case "radius":
    case "confidence":
      return Object.freeze({
        kind: payload.kind,
        options: Object.freeze({
          ...payload.options,
          node: cloneNode(payload.options.node),
        }),
      }) as CatmaidSpatialSkeletonCommandPayload;
    case "merge":
      return Object.freeze({
        kind: payload.kind,
        options: Object.freeze({
          firstNode: Object.freeze({
            ...payload.options.firstNode,
            ...(payload.options.firstNode.position === undefined
              ? {}
              : {
                  position: getCatmaidEditPosition(
                    payload.options.firstNode.position,
                  ),
                }),
          }),
          secondNode: Object.freeze({
            ...payload.options.secondNode,
            ...(payload.options.secondNode.position === undefined
              ? {}
              : {
                  position: getCatmaidEditPosition(
                    payload.options.secondNode.position,
                  ),
                }),
          }),
        }),
      });
  }
}

function getQueueInputRequirements(
  payload: CatmaidSpatialSkeletonCommandPayload,
  context: SpatialSkeletonCommandContext,
): SpatialSkeletonQueueInputRequirements {
  switch (payload.kind) {
    case "add-node":
      if (payload.options.parentNodeId === undefined) {
        return getCatmaidQueueInputRequirements();
      }
      return getCatmaidQueueInputRequirements(
        getCatmaidQueueInputRequirement(
          context,
          payload.options.skeletonId,
          payload.options.parentNodeId,
        ),
        ...(payload.options.childNodeIds ?? []).map((nodeId) =>
          getCatmaidQueueInputRequirement(
            context,
            payload.options.skeletonId,
            nodeId,
          ),
        ),
      );
    case "move-node":
    case "description":
    case "true-end":
    case "radius":
    case "confidence":
      return getCatmaidQueueInputRequirements(
        getCatmaidQueueInputRequirement(
          context,
          payload.options.node.segmentId,
          payload.options.node.nodeId,
        ),
      );
    case "delete-node":
      return getCatmaidQueueInputRequirements(
        getCatmaidQueueInputRequirement(
          context,
          payload.node.segmentId,
          payload.node.nodeId,
        ),
      );
    case "reroot":
    case "split":
      return getCatmaidQueueInputRequirements(
        getCatmaidQueueInputRequirement(
          context,
          payload.node.segmentId,
          payload.node.nodeId,
        ),
      );
    case "merge":
      return getCatmaidMergeQueueInputRequirements(
        getCatmaidQueueInputRequirement(
          context,
          payload.options.firstNode.segmentId,
          payload.options.firstNode.nodeId,
        ),
        getCatmaidQueueInputRequirement(
          context,
          payload.options.secondNode.segmentId,
          payload.options.secondNode.nodeId,
        ),
      );
  }
}

function makeCommandDescriptor(
  action: SpatialSkeletonAction,
  label: string,
  payload: CatmaidSpatialSkeletonCommandPayload,
): CatmaidSpatialSkeletonCommandDescriptor {
  const retainedPayload = freezePayload(payload);
  return Object.freeze({
    action,
    label,
    payload: retainedPayload,
    getQueueInputRequirements(context: SpatialSkeletonCommandContext) {
      return getQueueInputRequirements(retainedPayload, context);
    },
  });
}

function makeCatmaidCommandFactory<TAction extends SpatialSkeletonAction>(
  action: TAction,
  createCommand: (payload: object) => SpatialSkeletonEditCommand,
): SpatialSkeletonEditCommandFactory<TAction> {
  return {
    action,
    createCommand,
  };
}

export class CatmaidSpatialSkeletonEditCommands {
  private readonly editOperations: CatmaidSpatialSkeletonEditOperations;

  constructor(
    private readonly context: CatmaidSpatialSkeletonEditCommandContext,
  ) {
    let mutationScope: object | undefined;
    this.editOperations = Object.freeze<CatmaidSpatialSkeletonEditOperations>({
      get mutationScope() {
        return (mutationScope ??= getCatmaidMutationScope(context.getClient()));
      },
      commitAddNode: (request) => this.commitAddNode(request),
      commitInsertNode: (request) => this.commitInsertNode(request),
      commitMoveNode: (request) => this.commitMoveNode(request),
      commitDeleteNode: (request) => this.commitDeleteNode(request),
      commitReroot: (request) => this.commitReroot(request),
      commitDescription: (request) => this.commitDescription(request),
      commitTrueEnd: (request) => this.commitTrueEnd(request),
      commitRadius: (request) => this.commitRadius(request),
      commitConfidence: (request) => this.commitConfidence(request),
      commitMerge: (request) => this.commitMerge(request),
      commitSplit: (request) => this.commitSplit(request),
    });
  }

  readonly optimisticEditing: SpatialSkeletonOptimisticEditingProvider = {
    createDriver: ({ identities, provisionalIds }) => {
      const registration: SpatialSkeletonOptimisticDriverRegistration = {
        driver: new CatmaidSpatialSkeletonWorkflowDriver(
          identities,
          provisionalIds,
        ),
        mutationAdapter: new CatmaidSpatialSkeletonOptimisticMutationAdapter(
          this.editOperations,
        ),
        provisionalNumericIdPolicy: CATMAID_PROVISIONAL_NUMERIC_ID_POLICY,
      };
      return registration;
    },
  };

  readonly addNodesCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.addNodes,
    (payload) =>
      makeCommandDescriptor(SpatialSkeletonActions.addNodes, "Add node", {
        kind: "add-node",
        options: requireCatmaidAddNodeCommandOptions(payload),
      }),
  );

  readonly insertNodesCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.insertNodes,
    (payload) =>
      makeCommandDescriptor(SpatialSkeletonActions.insertNodes, "Insert node", {
        kind: "add-node",
        options: requireCatmaidInsertNodeCommandOptions(payload),
      }),
  );

  readonly moveNodesCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.moveNodes,
    (payload) =>
      makeCommandDescriptor(SpatialSkeletonActions.moveNodes, "Move node", {
        kind: "move-node",
        options: requireCatmaidMoveNodeCommandOptions(payload),
      }),
  );

  readonly deleteNodesCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.deleteNodes,
    (payload) =>
      makeCommandDescriptor(SpatialSkeletonActions.deleteNodes, "Delete node", {
        kind: "delete-node",
        node: requireCatmaidDeleteNodeCommandPayload(payload),
      }),
  );

  readonly rerootCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.reroot,
    (payload) =>
      makeCommandDescriptor(SpatialSkeletonActions.reroot, "Reroot skeleton", {
        kind: "reroot",
        node: requireCatmaidRerootCommandPayload(payload),
      }),
  );

  readonly editNodeDescriptionCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.editNodeDescription,
    (payload) =>
      makeCommandDescriptor(
        SpatialSkeletonActions.editNodeDescription,
        "Edit node description",
        {
          kind: "description",
          options: requireCatmaidNodeDescriptionCommandOptions(payload),
        },
      ),
  );

  readonly editNodeTrueEndCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.editNodeTrueEnd,
    (payload) =>
      makeCommandDescriptor(
        SpatialSkeletonActions.editNodeTrueEnd,
        "Edit node true end state",
        {
          kind: "true-end",
          options: requireCatmaidNodeTrueEndCommandOptions(payload),
        },
      ),
  );

  readonly editNodeRadiusCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.editNodeRadius,
    (payload) =>
      makeCommandDescriptor(
        SpatialSkeletonActions.editNodeRadius,
        "Edit node radius",
        {
          kind: "radius",
          options: requireCatmaidNodeRadiusCommandOptions(payload),
        },
      ),
  );

  readonly editNodeConfidenceCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.editNodeConfidence,
    (payload) =>
      makeCommandDescriptor(
        SpatialSkeletonActions.editNodeConfidence,
        "Edit node confidence",
        {
          kind: "confidence",
          options: requireCatmaidNodeConfidenceCommandOptions(payload),
        },
      ),
  );

  readonly mergeSkeletonsCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.mergeSkeletons,
    (payload) =>
      makeCommandDescriptor(
        SpatialSkeletonActions.mergeSkeletons,
        "Merge skeletons",
        {
          kind: "merge",
          options: requireCatmaidMergeCommandPayload(payload),
        },
      ),
  );

  readonly splitSkeletonsCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.splitSkeletons,
    (payload) =>
      makeCommandDescriptor(
        SpatialSkeletonActions.splitSkeletons,
        "Split skeleton",
        {
          kind: "split",
          node: requireCatmaidSplitCommandPayload(payload),
        },
      ),
  );

  private get client() {
    return this.context.getClient();
  }

  private commitAddNode(
    request: CatmaidSpatialSkeletonAddNodeRequest,
  ): Promise<CatmaidSpatialSkeletonAddNodeResult> {
    const [x, y, z] = getCatmaidEditPosition(request.position);
    return this.client.addNode(x, y, z, request.parentNodeId);
  }

  private commitInsertNode(
    request: CatmaidSpatialSkeletonInsertNodeRequest,
  ): Promise<CatmaidSpatialSkeletonInsertNodeResult> {
    const [x, y, z] = getCatmaidEditPosition(request.position);
    return this.client.insertNode(
      x,
      y,
      z,
      request.parentNodeId,
      request.childNodeIds,
    );
  }

  private commitMoveNode(
    request: CatmaidSpatialSkeletonMoveNodeRequest,
  ): Promise<void> {
    const [x, y, z] = getCatmaidEditPosition(request.position);
    return this.client.moveNode(request.nodeId, x, y, z);
  }

  private commitDeleteNode(
    request: CatmaidSpatialSkeletonDeleteNodeRequest,
  ): Promise<void> {
    return this.client.deleteNode(request.nodeId);
  }

  private commitReroot(
    request: CatmaidSpatialSkeletonRerootRequest,
  ): Promise<void> {
    return this.client.rerootSkeleton(request.nodeId);
  }

  private commitDescription(
    request: CatmaidSpatialSkeletonDescriptionUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonDescriptionUpdateResult> {
    return this.client.updateDescription(request.nodeId, request.description, {
      isTrueEnd: request.isTrueEnd,
    });
  }

  private commitTrueEnd(
    request: CatmaidSpatialSkeletonTrueEndUpdateRequest,
  ): Promise<void> {
    return this.client.toggleTrueEnd(request.nodeId, request.isTrueEnd);
  }

  private commitRadius(
    request: CatmaidSpatialSkeletonRadiusUpdateRequest,
  ): Promise<void> {
    return this.client.updateRadius(request.nodeId, request.radius);
  }

  private commitConfidence(
    request: CatmaidSpatialSkeletonConfidenceUpdateRequest,
  ): Promise<void> {
    return this.client.updateConfidence(request.nodeId, request.confidence);
  }

  private commitMerge(
    request: CatmaidSpatialSkeletonMergeRequest,
  ): Promise<CatmaidSpatialSkeletonMergeResult> {
    return this.client.mergeSkeletons(request.fromNodeId, request.toNodeId);
  }

  private commitSplit(
    request: CatmaidSpatialSkeletonSplitRequest,
  ): Promise<CatmaidSpatialSkeletonSplitResult> {
    return this.client.splitSkeleton(request.nodeId);
  }
}
