/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { SkeletonNode, SkeletonVector } from "#src/skeleton/api.js";
import type { CompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";
import type { SpatialSkeletonEditNodeAttributes } from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import type {
  SpatialSkeletonStableNodeHandle,
  SpatialSkeletonStableSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import {
  getSkeletonNodeConfidence,
  getSkeletonNodeRadius,
  isSkeletonNodeTrueEnd,
} from "#src/skeleton/node_attributes.js";

export interface CatmaidCapturedSegment {
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly physicalId: bigint;
  readonly snapshot: CompleteSkeleton;
  readonly cacheRevision: number;
}

/** A logical node together with the physical ID captured for its recipe. */
export interface CatmaidRetainedNode extends SpatialSkeletonStableNodeHandle {
  readonly capturedNodeId: bigint;
  readonly handle: SpatialSkeletonStableNodeHandle;
}

export interface CatmaidSemanticBase {
  readonly capturedSegments: readonly CatmaidCapturedSegment[];
  readonly retainedNodes: ReadonlyMap<bigint, CatmaidRetainedNode>;
}

export interface CatmaidCreatedNodeSemantic extends CatmaidSemanticBase {
  readonly kind: "add-node";
  readonly node: SpatialSkeletonStableNodeHandle;
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly parent: CatmaidRetainedNode | undefined;
  readonly position: SkeletonVector;
  readonly attributes: SpatialSkeletonEditNodeAttributes;
  readonly createsSegment: boolean;
  readonly children?: readonly CatmaidRetainedNode[];
}

export interface CatmaidDeleteNodeSemantic extends CatmaidSemanticBase {
  readonly kind: "delete-node";
  readonly node: CatmaidRetainedNode;
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly parent: CatmaidRetainedNode | undefined;
  readonly children: readonly CatmaidRetainedNode[];
  readonly deletedSnapshot: SkeletonNode;
  readonly wasSoleRoot: boolean;
}

export interface CatmaidMoveNodeSemantic extends CatmaidSemanticBase {
  readonly kind: "move-node";
  readonly node: CatmaidRetainedNode;
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly before: SkeletonVector;
  readonly after: SkeletonVector;
}

export interface CatmaidAttributeSemantic extends CatmaidSemanticBase {
  readonly kind: "description" | "true-end" | "radius" | "confidence";
  readonly node: CatmaidRetainedNode;
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly nodeSnapshot: SkeletonNode;
  readonly before: string | boolean | number | undefined;
  readonly after: string | boolean | number | undefined;
}

export interface CatmaidRerootSemantic extends CatmaidSemanticBase {
  readonly kind: "reroot";
  readonly node: CatmaidRetainedNode;
  readonly originalRoot: CatmaidRetainedNode;
  readonly originalRootConfidence: number | undefined;
  readonly segment: SpatialSkeletonStableSegmentHandle;
}

export interface CatmaidSplitSemantic extends CatmaidSemanticBase {
  readonly kind: "split";
  readonly sourceSegment: SpatialSkeletonStableSegmentHandle;
  readonly downstreamSegment: SpatialSkeletonStableSegmentHandle;
  readonly node: CatmaidRetainedNode;
  readonly formerParent: CatmaidRetainedNode;
}

export interface CatmaidMergeSemantic extends CatmaidSemanticBase {
  readonly kind: "merge";
  readonly firstSegment: SpatialSkeletonStableSegmentHandle;
  readonly secondSegment: SpatialSkeletonStableSegmentHandle;
  /**
   * The merged workspace output is a distinct logical resource. In
   * particular, Undo must be able to use this as the merged input while
   * restoring both original segment handles as outputs.
   */
  readonly mergedSegment: SpatialSkeletonStableSegmentHandle;
  readonly firstNode: CatmaidRetainedNode;
  readonly secondNode: CatmaidRetainedNode;
  readonly originalRoot: CatmaidRetainedNode;
  readonly originalRootConfidence: number | undefined;
  readonly inverseOrientation: "second-from-first" | "first-from-second";
}

export type CatmaidCapturedEdit =
  | CatmaidCreatedNodeSemantic
  | CatmaidDeleteNodeSemantic
  | CatmaidMoveNodeSemantic
  | CatmaidAttributeSemantic
  | CatmaidRerootSemantic
  | CatmaidSplitSemantic
  | CatmaidMergeSemantic;

export type CatmaidEditPlanStep =
  | {
      readonly kind: "restore-confidence";
      readonly node: SpatialSkeletonStableNodeHandle;
      readonly confidence: number;
    }
  | {
      readonly kind: "add-node";
      readonly semantic: CatmaidCreatedNodeSemantic | CatmaidDeleteNodeSemantic;
    }
  | {
      readonly kind: "insert-node";
      readonly semantic: CatmaidCreatedNodeSemantic | CatmaidDeleteNodeSemantic;
    }
  | { readonly kind: "move-node"; readonly semantic: CatmaidMoveNodeSemantic }
  | {
      readonly kind: "delete-node";
      readonly semantic: CatmaidCreatedNodeSemantic | CatmaidDeleteNodeSemantic;
    }
  | {
      readonly kind: "reroot";
      readonly semantic: CatmaidRerootSemantic | CatmaidMergeSemantic;
    }
  | {
      readonly kind: "description";
      readonly semantic: CatmaidAttributeSemantic | CatmaidDeleteNodeSemantic;
    }
  | {
      readonly kind: "true-end";
      readonly semantic: CatmaidAttributeSemantic | CatmaidDeleteNodeSemantic;
    }
  | {
      readonly kind: "radius";
      readonly semantic: CatmaidAttributeSemantic | CatmaidDeleteNodeSemantic;
    }
  | {
      readonly kind: "confidence";
      readonly semantic: CatmaidAttributeSemantic | CatmaidDeleteNodeSemantic;
    }
  | {
      readonly kind: "split";
      readonly semantic: CatmaidSplitSemantic | CatmaidMergeSemantic;
    }
  | {
      readonly kind: "merge";
      readonly semantic: CatmaidSplitSemantic | CatmaidMergeSemantic;
    };

/**
 * Immutable CATMAID recipe retained by the generic engine. Physical attempts,
 * results, cursors, leases, and lifecycle are all canonical engine state.
 */
type CatmaidEditPlanFor<TSemantic extends CatmaidCapturedEdit> =
  TSemantic extends CatmaidCapturedEdit
    ? Readonly<{
        kind: TSemantic["kind"];
        direction: "forward" | "inverse";
        semantic: TSemantic;
      }>
    : never;

/** Discriminated immutable CATMAID plan recipe. */
export type CatmaidEditPlan = CatmaidEditPlanFor<CatmaidCapturedEdit>;

export function requirePositiveId(value: bigint | undefined, label: string) {
  if (value === undefined || value === 0n) {
    throw new Error(`CATMAID ${label} has no authoritative numeric id.`);
  }
  return value;
}

function getRestoreSteps(semantic: CatmaidDeleteNodeSemantic) {
  const result: CatmaidEditPlanStep[] = [
    {
      kind: semantic.children.length === 0 ? "add-node" : "insert-node",
      semantic,
    },
  ];
  if (semantic.deletedSnapshot.description !== undefined) {
    result.push({ kind: "description", semantic });
  }
  if (
    semantic.deletedSnapshot.description === undefined &&
    isSkeletonNodeTrueEnd(semantic.deletedSnapshot)
  ) {
    result.push({ kind: "true-end", semantic });
  }
  if (getSkeletonNodeRadius(semantic.deletedSnapshot) !== undefined) {
    result.push({ kind: "radius", semantic });
  }
  if (getSkeletonNodeConfidence(semantic.deletedSnapshot) !== undefined) {
    result.push({ kind: "confidence", semantic });
  }
  return Object.freeze(result);
}

/** CATMAID resets a newly rerooted root to full confidence. */
function getRerootSteps(
  semantic: CatmaidRerootSemantic | CatmaidMergeSemantic,
  direction: "forward" | "inverse",
): readonly CatmaidEditPlanStep[] {
  const steps: CatmaidEditPlanStep[] = [{ kind: "reroot", semantic }];
  if (direction === "inverse") {
    const root = semantic.originalRoot;
    const confidence = semantic.originalRootConfidence;
    if (confidence !== undefined && confidence !== 100) {
      steps.push({ kind: "restore-confidence", node: root, confidence });
    }
  }
  return Object.freeze(steps);
}

export function makeSteps(
  semantic: CatmaidCapturedEdit,
  direction: "forward" | "inverse",
): readonly CatmaidEditPlanStep[] {
  switch (semantic.kind) {
    case "add-node":
      return Object.freeze([
        direction === "forward"
          ? {
              kind: semantic.children?.length ? "insert-node" : "add-node",
              semantic,
            }
          : { kind: "delete-node", semantic },
      ]);
    case "delete-node":
      return direction === "forward"
        ? Object.freeze([{ kind: "delete-node", semantic }])
        : getRestoreSteps(semantic);
    case "move-node":
      return Object.freeze([{ kind: "move-node", semantic }]);
    case "description":
    case "true-end":
    case "radius":
    case "confidence":
      return Object.freeze([{ kind: semantic.kind, semantic }]);
    case "reroot":
      return getRerootSteps(semantic, direction);
    case "split":
      return Object.freeze([
        direction === "forward"
          ? { kind: "split", semantic }
          : { kind: "merge", semantic },
      ]);
    case "merge":
      return direction === "forward"
        ? Object.freeze([{ kind: "merge", semantic }])
        : Object.freeze([
            { kind: "split", semantic },
            ...(semantic.originalRoot.stableId ===
            (semantic.inverseOrientation === "second-from-first"
              ? semantic.secondNode.stableId
              : semantic.firstNode.stableId)
              ? []
              : getRerootSteps(semantic, direction)),
          ]);
  }
}
