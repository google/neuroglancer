/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import type { CompleteSkeletonSnapshotHandle } from "#src/skeleton/complete_skeleton_snapshot.js";
import type {
  SpatialSkeletonLogicalNodeHandle,
  SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import type { SpatialSkeletonProjectionNodeAttributes } from "#src/skeleton/spatial_skeleton_projection_reducer.js";

export interface CatmaidCapturedSegment {
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly physicalId: number;
  readonly snapshot: CompleteSkeletonSnapshotHandle;
  readonly cacheRevision: number;
}

/** A logical node together with the physical ID captured for its recipe. */
export interface CatmaidRetainedNode extends SpatialSkeletonLogicalNodeHandle {
  readonly capturedNodeId: number;
  readonly handle: SpatialSkeletonLogicalNodeHandle;
}

export interface CatmaidSemanticBase {
  readonly capturedSegments: readonly CatmaidCapturedSegment[];
  readonly retainedNodes: ReadonlyMap<number, CatmaidRetainedNode>;
}

export interface CatmaidCreatedNodeSemantic extends CatmaidSemanticBase {
  readonly kind: "add-node";
  readonly node: SpatialSkeletonLogicalNodeHandle;
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly parent: CatmaidRetainedNode | undefined;
  readonly position: SpatialSkeletonVector;
  readonly attributes: SpatialSkeletonProjectionNodeAttributes;
  readonly createsSegment: boolean;
  readonly children?: readonly CatmaidRetainedNode[];
}

export interface CatmaidDeleteNodeSemantic extends CatmaidSemanticBase {
  readonly kind: "delete-node";
  readonly node: CatmaidRetainedNode;
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly parent: CatmaidRetainedNode | undefined;
  readonly children: readonly CatmaidRetainedNode[];
  readonly deletedSnapshot: SpatiallyIndexedSkeletonNode;
  readonly wasSoleRoot: boolean;
}

export interface CatmaidMoveNodeSemantic extends CatmaidSemanticBase {
  readonly kind: "move-node";
  readonly node: CatmaidRetainedNode;
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly before: SpatialSkeletonVector;
  readonly after: SpatialSkeletonVector;
}

export interface CatmaidAttributeSemantic extends CatmaidSemanticBase {
  readonly kind: "description" | "true-end" | "radius" | "confidence";
  readonly node: CatmaidRetainedNode;
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly nodeSnapshot: SpatiallyIndexedSkeletonNode;
  readonly before: string | boolean | number | undefined;
  readonly after: string | boolean | number | undefined;
}

export interface CatmaidRerootSemantic extends CatmaidSemanticBase {
  readonly kind: "reroot";
  readonly node: CatmaidRetainedNode;
  readonly originalRoot: CatmaidRetainedNode;
  readonly originalRootConfidence: number | undefined;
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
}

export interface CatmaidSplitSemantic extends CatmaidSemanticBase {
  readonly kind: "split";
  readonly sourceSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly downstreamSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly node: CatmaidRetainedNode;
  readonly formerParent: CatmaidRetainedNode;
}

export interface CatmaidMergeSemantic extends CatmaidSemanticBase {
  readonly kind: "merge";
  readonly firstSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly secondSegment: SpatialSkeletonLogicalSegmentHandle;
  /**
   * The merged workspace output is a distinct logical resource. In
   * particular, Undo must be able to use this as the merged input while
   * restoring both original segment handles as outputs.
   */
  readonly mergedSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly firstNode: CatmaidRetainedNode;
  readonly secondNode: CatmaidRetainedNode;
  readonly originalRoot: CatmaidRetainedNode;
  readonly originalRootConfidence: number | undefined;
  readonly inverseOrientation: "second-from-first" | "first-from-second";
}

export type CatmaidSemanticRecipe =
  | CatmaidCreatedNodeSemantic
  | CatmaidDeleteNodeSemantic
  | CatmaidMoveNodeSemantic
  | CatmaidAttributeSemantic
  | CatmaidRerootSemantic
  | CatmaidSplitSemantic
  | CatmaidMergeSemantic;

export type CatmaidWorkflowStep =
  | {
      readonly kind: "restore-confidence";
      readonly node: SpatialSkeletonLogicalNodeHandle;
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
type CatmaidWorkflowFor<TSemantic extends CatmaidSemanticRecipe> =
  TSemantic extends CatmaidSemanticRecipe
    ? Readonly<{
        kind: TSemantic["kind"];
        direction: "forward" | "inverse";
        semantic: TSemantic;
      }>
    : never;

/** Discriminated immutable CATMAID workflow recipe. */
export type CatmaidWorkflow = CatmaidWorkflowFor<CatmaidSemanticRecipe>;

export function requirePositiveId(value: number | undefined, label: string) {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`CATMAID ${label} has no authoritative numeric id.`);
  }
  return value;
}

function getRestoreSteps(semantic: CatmaidDeleteNodeSemantic) {
  const result: CatmaidWorkflowStep[] = [
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
    semantic.deletedSnapshot.isTrueEnd === true
  ) {
    result.push({ kind: "true-end", semantic });
  }
  if (semantic.deletedSnapshot.radius !== undefined) {
    result.push({ kind: "radius", semantic });
  }
  if (semantic.deletedSnapshot.confidence !== undefined) {
    result.push({ kind: "confidence", semantic });
  }
  return Object.freeze(result);
}

/** CATMAID resets a newly rerooted root to full confidence. */
function getRerootSteps(
  semantic: CatmaidRerootSemantic | CatmaidMergeSemantic,
  direction: "forward" | "inverse",
): readonly CatmaidWorkflowStep[] {
  const steps: CatmaidWorkflowStep[] = [{ kind: "reroot", semantic }];
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
  semantic: CatmaidSemanticRecipe,
  direction: "forward" | "inverse",
): readonly CatmaidWorkflowStep[] {
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
