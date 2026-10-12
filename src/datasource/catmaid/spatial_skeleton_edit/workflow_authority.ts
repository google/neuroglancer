/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import {
  type CatmaidOptimisticMutation,
  type CatmaidOptimisticMutationResult,
} from "#src/datasource/catmaid/spatial_skeleton_edit/mutation_adapter.js";
import {
  makeSteps,
  requirePositiveId,
  type CatmaidAttributeSemantic,
  type CatmaidCreatedNodeSemantic,
  type CatmaidDeleteNodeSemantic,
  type CatmaidMergeSemantic,
  type CatmaidMoveNodeSemantic,
  type CatmaidRerootSemantic,
  type CatmaidSplitSemantic,
  type CatmaidWorkflow,
  type CatmaidWorkflowStep,
} from "#src/datasource/catmaid/spatial_skeleton_edit/workflow_recipe.js";
import {
  getSpatialSkeletonLogicalResourceKey,
  type SpatialSkeletonLogicalNodeHandle,
  type SpatialSkeletonLogicalResourceHandle,
  type SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import type { SpatialSkeletonOptimisticIdentityService } from "#src/skeleton/optimistic_edit/api.js";
import type { SpatialSkeletonMutationWorkflowContext } from "#src/skeleton/optimistic_edit/ports.js";
import type { SpatialSkeletonAuthoritativeReconciliation } from "#src/skeleton/optimistic_edit/projection_runtime.js";
import type { SpatialSkeletonProjectionDelta } from "#src/skeleton/spatial_skeleton_projection_reducer.js";

interface CatmaidMaterializationContext {
  readonly direction: "forward" | "inverse";
  readonly localNodeBindings: ReadonlyMap<string, number>;
  readonly localSegmentBindings: ReadonlyMap<string, number>;
}

type CatmaidWorkflowContext = SpatialSkeletonMutationWorkflowContext<
  CatmaidOptimisticMutation,
  CatmaidOptimisticMutationResult
>;

/** CATMAID authority half of the generic workflow driver. */
export abstract class CatmaidWorkflowAuthorityDriverBase {
  constructor(
    protected readonly identity: SpatialSkeletonOptimisticIdentityService,
  ) {}

  protected segmentHandle(segmentId: number) {
    return this.identity.getOrCreateSegmentHandle(segmentId);
  }

  nextAttempt(workflow: CatmaidWorkflow, context: CatmaidWorkflowContext) {
    const steps = makeSteps(workflow.semantic, workflow.direction);
    const step = steps[context.committedAttempts.length];
    if (step === undefined) return undefined;
    const committedAttempts = context.committedAttempts;
    return Object.freeze({
      materializeMutation: () =>
        this.makeMutationRequest(
          this.createMaterializationContext(workflow, committedAttempts),
          step,
        ),
    });
  }

  createReconciliation(
    workflow: CatmaidWorkflow,
    context: CatmaidWorkflowContext,
  ) {
    return this.reconcile(workflow, context);
  }

  private createMaterializationContext(
    workflow: CatmaidWorkflow,
    attempts: CatmaidWorkflowContext["committedAttempts"],
  ): CatmaidMaterializationContext {
    const localNodeBindings = new Map<string, number>();
    const localSegmentBindings = new Map<string, number>();
    const steps = makeSteps(workflow.semantic, workflow.direction);
    for (let index = 0; index < attempts.length; ++index) {
      const attempt = attempts[index];
      const step = steps[index]!;
      if (step.kind === "add-node" || step.kind === "insert-node") {
        const result = attempt.result as {
          readonly nodeId?: number;
          readonly segmentId?: number;
        };
        localNodeBindings.set(
          step.semantic.node.stableId,
          requirePositiveId(result.nodeId, "created node result"),
        );
        localSegmentBindings.set(
          step.semantic.segment.stableId,
          requirePositiveId(result.segmentId, "created skeleton result"),
        );
      } else if (step.kind === "split") {
        const result = attempt.result as {
          readonly existingSegmentId?: number;
          readonly newSegmentId?: number;
        };
        const existingId = requirePositiveId(
          result.existingSegmentId,
          "split existing skeleton",
        );
        const newId = requirePositiveId(
          result.newSegmentId,
          "split result skeleton",
        );
        if (step.semantic.kind === "split") {
          localSegmentBindings.set(
            step.semantic.sourceSegment.stableId,
            existingId,
          );
          localSegmentBindings.set(
            step.semantic.downstreamSegment.stableId,
            newId,
          );
        } else {
          const existingSegment =
            step.semantic.inverseOrientation === "second-from-first"
              ? step.semantic.firstSegment
              : step.semantic.secondSegment;
          const restoredSegment =
            step.semantic.inverseOrientation === "second-from-first"
              ? step.semantic.secondSegment
              : step.semantic.firstSegment;
          localSegmentBindings.set(existingSegment.stableId, existingId);
          localSegmentBindings.set(restoredSegment.stableId, newId);
        }
      } else if (step.kind === "merge") {
        const resultId = requirePositiveId(
          (attempt.result as { readonly resultSegmentId?: number })
            .resultSegmentId,
          "merge result skeleton",
        );
        if (step.semantic.kind === "split") {
          localSegmentBindings.set(
            step.semantic.sourceSegment.stableId,
            resultId,
          );
          localSegmentBindings.set(
            step.semantic.downstreamSegment.stableId,
            resultId,
          );
        } else {
          localSegmentBindings.set(
            step.semantic.firstSegment.stableId,
            resultId,
          );
          localSegmentBindings.set(
            step.semantic.secondSegment.stableId,
            resultId,
          );
          localSegmentBindings.set(
            step.semantic.mergedSegment.stableId,
            resultId,
          );
        }
      }
    }
    return Object.freeze({
      direction: workflow.direction,
      localNodeBindings,
      localSegmentBindings,
    });
  }

  private resolveNode(
    context: CatmaidMaterializationContext,
    handle: SpatialSkeletonLogicalNodeHandle,
  ) {
    const local = context.localNodeBindings.get(handle.stableId);
    if (local !== undefined) return local;
    const physicalId = this.identity.resolveAuthoritativeNode(handle);
    if (physicalId === undefined) {
      const target = this.identity.resolveNodeTarget(handle);
      throw new Error(
        `CATMAID workflow requires authoritative node ${handle.stableId}; it is ${target.state}.`,
      );
    }
    return physicalId;
  }

  private resolveSegment(
    context: CatmaidMaterializationContext,
    handle: SpatialSkeletonLogicalSegmentHandle,
  ) {
    const local = context.localSegmentBindings.get(handle.stableId);
    if (local !== undefined) return local;
    const physicalId = this.identity.resolveAuthoritativeSegment(handle);
    if (physicalId === undefined) {
      const target = this.identity.resolveSegmentTarget(handle);
      throw new Error(
        `CATMAID workflow requires authoritative skeleton ${handle.stableId}; it is ${target.state}.`,
      );
    }
    return physicalId;
  }

  private makeMutationRequest(
    context: CatmaidMaterializationContext,
    step: CatmaidWorkflowStep,
  ): CatmaidOptimisticMutation {
    switch (step.kind) {
      case "add-node": {
        const semantic = step.semantic as
          | CatmaidCreatedNodeSemantic
          | CatmaidDeleteNodeSemantic;
        const parent = semantic.parent;
        return {
          kind: "add-node",
          request: {
            position:
              semantic.kind === "delete-node"
                ? semantic.deletedSnapshot.position
                : semantic.position,
            parentNodeId:
              parent === undefined
                ? undefined
                : this.resolveNode(context, parent),
          },
        };
      }
      case "insert-node": {
        const { semantic } = step;
        if (semantic.parent === undefined) {
          throw new Error("CATMAID insert workflow is missing its parent.");
        }
        return {
          kind: "insert-node",
          request: {
            position:
              semantic.kind === "delete-node"
                ? semantic.deletedSnapshot.position
                : semantic.position,
            parentNodeId: this.resolveNode(context, semantic.parent),
            childNodeIds: (semantic.children ?? []).map((handle) =>
              this.resolveNode(context, handle),
            ),
          },
        };
      }
      case "delete-node": {
        const semantic = step.semantic as
          | CatmaidCreatedNodeSemantic
          | CatmaidDeleteNodeSemantic;
        return {
          kind: "delete-node",
          request: { nodeId: this.resolveNode(context, semantic.node) },
        };
      }
      case "move-node": {
        const semantic = step.semantic as CatmaidMoveNodeSemantic;
        return {
          kind: "move-node",
          request: {
            nodeId: this.resolveNode(context, semantic.node),
            position:
              context.direction === "forward"
                ? semantic.after
                : semantic.before,
          },
        };
      }
      case "description": {
        const semantic = step.semantic as
          | CatmaidAttributeSemantic
          | CatmaidDeleteNodeSemantic;
        const value = this.getAttributeValue(context, semantic, "description");
        return {
          kind: "description",
          request: {
            nodeId: this.resolveNode(context, semantic.node),
            description: typeof value === "string" ? value : "",
            isTrueEnd:
              semantic.kind === "delete-node"
                ? semantic.deletedSnapshot.isTrueEnd === true
                : semantic.nodeSnapshot.isTrueEnd === true,
          },
        };
      }
      case "true-end": {
        const semantic = step.semantic as
          | CatmaidAttributeSemantic
          | CatmaidDeleteNodeSemantic;
        return {
          kind: "true-end",
          request: {
            nodeId: this.resolveNode(context, semantic.node),
            isTrueEnd: Boolean(
              this.getAttributeValue(context, semantic, "true-end"),
            ),
          },
        };
      }
      case "radius": {
        const semantic = step.semantic as
          | CatmaidAttributeSemantic
          | CatmaidDeleteNodeSemantic;
        return {
          kind: "radius",
          request: {
            nodeId: this.resolveNode(context, semantic.node),
            radius: Number(this.getAttributeValue(context, semantic, "radius")),
          },
        };
      }
      case "restore-confidence":
        return {
          kind: "confidence",
          request: {
            nodeId: this.resolveNode(context, step.node),
            confidence: step.confidence,
          },
        };
      case "confidence": {
        const semantic = step.semantic as
          | CatmaidAttributeSemantic
          | CatmaidDeleteNodeSemantic;
        return {
          kind: "confidence",
          request: {
            nodeId: this.resolveNode(context, semantic.node),
            confidence: Number(
              this.getAttributeValue(context, semantic, "confidence"),
            ),
          },
        };
      }
      case "reroot": {
        const semantic = step.semantic as
          | CatmaidRerootSemantic
          | CatmaidMergeSemantic;
        const target =
          semantic.kind === "reroot" && context.direction === "forward"
            ? semantic.node
            : semantic.originalRoot;
        return {
          kind: "reroot",
          request: { nodeId: this.resolveNode(context, target) },
        };
      }
      case "split": {
        const semantic = step.semantic as
          | CatmaidSplitSemantic
          | CatmaidMergeSemantic;
        const target =
          semantic.kind === "split"
            ? semantic.node
            : semantic.inverseOrientation === "second-from-first"
              ? semantic.secondNode
              : semantic.firstNode;
        return {
          kind: "split",
          request: { nodeId: this.resolveNode(context, target) },
        };
      }
      case "merge": {
        const semantic = step.semantic as
          | CatmaidSplitSemantic
          | CatmaidMergeSemantic;
        const firstHandle =
          semantic.kind === "split"
            ? semantic.formerParent
            : semantic.inverseOrientation === "second-from-first"
              ? semantic.firstNode
              : semantic.secondNode;
        const secondHandle =
          semantic.kind === "split"
            ? semantic.node
            : semantic.inverseOrientation === "second-from-first"
              ? semantic.secondNode
              : semantic.firstNode;
        const inputSegmentIds: readonly [number, number] = Object.freeze(
          semantic.kind === "split"
            ? [
                this.resolveSegment(context, semantic.sourceSegment),
                this.resolveSegment(context, semantic.downstreamSegment),
              ]
            : [
                this.resolveSegment(context, semantic.firstSegment),
                this.resolveSegment(context, semantic.secondSegment),
              ],
        );
        const mutation: CatmaidOptimisticMutation<"merge"> = Object.freeze({
          kind: "merge",
          request: Object.freeze({
            fromNodeId: this.resolveNode(context, firstHandle),
            toNodeId: this.resolveNode(context, secondHandle),
          }),
          inputSegmentIds,
        });
        return mutation;
      }
    }
  }

  private getAttributeValue(
    context: CatmaidMaterializationContext,
    semantic: CatmaidAttributeSemantic | CatmaidDeleteNodeSemantic,
    kind: "description" | "true-end" | "radius" | "confidence",
  ) {
    if (semantic.kind === "delete-node") {
      switch (kind) {
        case "description":
          return semantic.deletedSnapshot.description;
        case "true-end":
          return semantic.deletedSnapshot.isTrueEnd ?? false;
        case "radius":
          return semantic.deletedSnapshot.radius ?? 0;
        case "confidence":
          return semantic.deletedSnapshot.confidence ?? 0;
      }
    }
    return context.direction === "forward" ? semantic.after : semantic.before;
  }

  private reconcile(
    workflow: CatmaidWorkflow,
    context: CatmaidWorkflowContext,
  ): SpatialSkeletonAuthoritativeReconciliation {
    const materialization = this.createMaterializationContext(
      workflow,
      context.committedAttempts,
    );
    const nodeBindings: Array<
      readonly [SpatialSkeletonLogicalNodeHandle, number]
    > = [];
    const segmentBindings: Array<
      readonly [SpatialSkeletonLogicalSegmentHandle, number]
    > = [];
    const retired = new Map<string, SpatialSkeletonLogicalResourceHandle>();
    const retiredSegmentIds = new Set<number>();
    let finalizedProjectionDelta: SpatialSkeletonProjectionDelta | undefined;

    const steps = makeSteps(workflow.semantic, workflow.direction);
    const attempts = context.committedAttempts;
    for (let index = 0; index < attempts.length; ++index) {
      const committed = attempts[index];
      const step = steps[index]!;
      switch (step.kind) {
        case "add-node":
        case "insert-node": {
          const result = committed.result as {
            nodeId: number;
            segmentId: number;
          };
          nodeBindings.push([step.semantic.node, result.nodeId]);
          segmentBindings.push([step.semantic.segment, result.segmentId]);
          break;
        }
        case "description": {
          const result = committed.result as {
            description?: string;
          };
          if (
            step.semantic.kind === "description" &&
            result.description !==
              this.getAttributeValue(
                materialization,
                step.semantic,
                "description",
              )
          ) {
            finalizedProjectionDelta = {
              kind: "node-attributes",
              segment: step.semantic.segment,
              node: step.semantic.node,
              changes: { description: result.description },
            };
          }
          break;
        }
        case "delete-node": {
          retired.set(
            getSpatialSkeletonLogicalResourceKey(step.semantic.node),
            step.semantic.node,
          );
          if (
            (step.semantic.kind === "add-node" &&
              step.semantic.createsSegment) ||
            (step.semantic.kind === "delete-node" && step.semantic.wasSoleRoot)
          ) {
            retired.set(
              getSpatialSkeletonLogicalResourceKey(step.semantic.segment),
              step.semantic.segment,
            );
          }
          break;
        }
        case "split": {
          const result = committed.result as {
            existingSegmentId?: number;
            newSegmentId?: number;
          };
          const existingId = requirePositiveId(
            result.existingSegmentId,
            "split existing skeleton",
          );
          const newId = requirePositiveId(
            result.newSegmentId,
            "split result skeleton",
          );
          if (step.semantic.kind === "split") {
            segmentBindings.push([step.semantic.sourceSegment, existingId]);
            segmentBindings.push([step.semantic.downstreamSegment, newId]);
          } else {
            const existingSegment =
              step.semantic.inverseOrientation === "second-from-first"
                ? step.semantic.firstSegment
                : step.semantic.secondSegment;
            const restoredSegment =
              step.semantic.inverseOrientation === "second-from-first"
                ? step.semantic.secondSegment
                : step.semantic.firstSegment;
            segmentBindings.push([existingSegment, existingId]);
            segmentBindings.push([restoredSegment, newId]);
          }
          break;
        }
        case "merge": {
          const result = committed.result as {
            resultSegmentId?: number;
            deletedSegmentId?: number;
            directionAdjusted?: boolean;
          };
          const resultId = requirePositiveId(
            result.resultSegmentId,
            "merge result skeleton",
          );
          const deletedId = requirePositiveId(
            result.deletedSegmentId,
            "merge deleted skeleton",
          );
          if (step.semantic.kind === "split") {
            if (result.directionAdjusted === true) {
              throw new Error(
                "CATMAID reversed the merge used to undo a split; reload is required to reconcile the committed topology.",
              );
            }
            const [sourceId, downstreamId] = this.requireMergeInputSegmentIds(
              committed.mutation,
            );
            if (resultId !== sourceId || deletedId !== downstreamId) {
              throw new Error(
                "CATMAID split Undo merge result does not match its retained input skeletons.",
              );
            }
            segmentBindings.push(
              [step.semantic.sourceSegment, resultId],
              [step.semantic.downstreamSegment, resultId],
            );
          } else {
            const mergeSemantic = step.semantic;
            const requestedOrientation = mergeSemantic.inverseOrientation;
            const [firstId, secondId] = this.requireMergeInputSegmentIds(
              committed.mutation,
            );
            if (
              !(
                (resultId === firstId && deletedId === secondId) ||
                (resultId === secondId && deletedId === firstId)
              )
            ) {
              throw new Error(
                "CATMAID merge result does not match either retained input skeleton.",
              );
            }
            const actualOrientation = result.directionAdjusted
              ? requestedOrientation === "second-from-first"
                ? ("first-from-second" as const)
                : ("second-from-first" as const)
              : requestedOrientation;
            const expectedResultId =
              actualOrientation === "second-from-first" ? firstId : secondId;
            const expectedDeletedId =
              actualOrientation === "second-from-first" ? secondId : firstId;
            if (
              resultId !== expectedResultId ||
              deletedId !== expectedDeletedId
            ) {
              throw new Error(
                "CATMAID merge result conflicts with its reported orientation.",
              );
            }
            // Keep both semantic identities bound to the source-wide survivor.
            // Later projected edits and history recipes may refer to either;
            // Undo overlays the restored loser with its fresh split id.
            segmentBindings.push(
              [step.semantic.firstSegment, resultId],
              [step.semantic.secondSegment, resultId],
              [step.semantic.mergedSegment, resultId],
            );
            if (actualOrientation !== requestedOrientation) {
              finalizedProjectionDelta = {
                kind: "merge",
                firstSegment:
                  actualOrientation === "second-from-first"
                    ? step.semantic.firstSegment
                    : step.semantic.secondSegment,
                secondSegment:
                  actualOrientation === "second-from-first"
                    ? step.semantic.secondSegment
                    : step.semantic.firstSegment,
                resultSegment: step.semantic.mergedSegment,
                firstNode:
                  actualOrientation === "second-from-first"
                    ? step.semantic.firstNode
                    : step.semantic.secondNode,
                secondNode:
                  actualOrientation === "second-from-first"
                    ? step.semantic.secondNode
                    : step.semantic.firstNode,
              };
            }
          }
          retiredSegmentIds.add(deletedId);
          break;
        }
      }
    }

    return Object.freeze({
      bindings: Object.freeze({
        nodes: Object.freeze(nodeBindings),
        segments: Object.freeze(segmentBindings),
      }),
      retiredResources: Object.freeze([...retired.values()]),
      ...(retiredSegmentIds.size === 0
        ? {}
        : { retiredSegmentIds: Object.freeze([...retiredSegmentIds]) }),
      ...(finalizedProjectionDelta === undefined
        ? {}
        : { finalizedProjectionDelta }),
    });
  }

  private requireMergeInputSegmentIds(
    mutation: CatmaidOptimisticMutation,
  ): readonly [number, number] {
    if (mutation.kind !== "merge") {
      throw new Error("CATMAID merge reconciliation lost its mutation.");
    }
    return mutation.inputSegmentIds;
  }
}
