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

import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";

export interface CatmaidSpatialSkeletonAddNodeCommandOptions {
  skeletonId: number;
  parentNodeId: number | undefined;
  positionInModelSpace: SpatialSkeletonVector;
  childNodeIds?: readonly number[];
}

export interface CatmaidSpatialSkeletonMoveNodeCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextPositionInModelSpace: SpatialSkeletonVector;
}

export interface CatmaidSpatialSkeletonNodeDescriptionCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextDescription?: string;
}

export interface CatmaidSpatialSkeletonNodeTrueEndCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextIsTrueEnd: boolean;
}

export interface CatmaidSpatialSkeletonNodeRadiusCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextRadius: number;
}

export interface CatmaidSpatialSkeletonNodeConfidenceCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextConfidence: number;
}

export interface CatmaidSpatialSkeletonMergeEndpoint {
  nodeId: number;
  segmentId: number;
  position?: SpatialSkeletonVector;
}

export interface CatmaidSpatialSkeletonMergeCommandPayload {
  firstNode: CatmaidSpatialSkeletonMergeEndpoint;
  secondNode: CatmaidSpatialSkeletonMergeEndpoint;
}

/** Payloads accepted by CATMAID skeleton command factories and workflows. */
export type CatmaidSpatialSkeletonCommandPayload =
  | {
      readonly kind: "add-node";
      readonly options: CatmaidSpatialSkeletonAddNodeCommandOptions;
    }
  | {
      readonly kind: "move-node";
      readonly options: CatmaidSpatialSkeletonMoveNodeCommandOptions;
    }
  | {
      readonly kind: "delete-node";
      readonly node: SpatiallyIndexedSkeletonNode;
    }
  | {
      readonly kind: "reroot";
      readonly node: Pick<
        SpatiallyIndexedSkeletonNode,
        "nodeId" | "segmentId" | "parentNodeId"
      > &
        Partial<Pick<SpatiallyIndexedSkeletonNode, "position">>;
    }
  | {
      readonly kind: "description";
      readonly options: CatmaidSpatialSkeletonNodeDescriptionCommandOptions;
    }
  | {
      readonly kind: "true-end";
      readonly options: CatmaidSpatialSkeletonNodeTrueEndCommandOptions;
    }
  | {
      readonly kind: "radius";
      readonly options: CatmaidSpatialSkeletonNodeRadiusCommandOptions;
    }
  | {
      readonly kind: "confidence";
      readonly options: CatmaidSpatialSkeletonNodeConfidenceCommandOptions;
    }
  | {
      readonly kind: "split";
      readonly node: Pick<
        SpatiallyIndexedSkeletonNode,
        "nodeId" | "segmentId"
      > &
        Partial<
          Pick<SpatiallyIndexedSkeletonNode, "parentNodeId" | "position">
        >;
    }
  | {
      readonly kind: "merge";
      readonly options: CatmaidSpatialSkeletonMergeCommandPayload;
    };

function isFiniteNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: number | undefined) {
  return value === undefined || isFiniteNumber(value);
}

function isSpatialSkeletonVector(
  value: object | undefined,
): value is SpatialSkeletonVector {
  // Coordinate contents are consumed by the generic reducer or CATMAID
  // transport. Admission only requires the user-facing value to be present.
  return value !== undefined;
}

function isSpatiallyIndexedSkeletonNodePayload(
  value: object | undefined,
): value is SpatiallyIndexedSkeletonNode {
  if (value === undefined) return false;
  const candidate = value as {
    nodeId?: number;
    segmentId?: number;
    position?: object;
    parentNodeId?: number;
    radius?: number;
    confidence?: number;
    description?: string;
    isTrueEnd?: boolean;
  };
  return (
    isFiniteNumber(candidate.nodeId) &&
    isFiniteNumber(candidate.segmentId) &&
    isSpatialSkeletonVector(candidate.position) &&
    isOptionalFiniteNumber(candidate.parentNodeId) &&
    isOptionalFiniteNumber(candidate.radius) &&
    isOptionalFiniteNumber(candidate.confidence) &&
    (candidate.description === undefined ||
      typeof candidate.description === "string") &&
    (candidate.isTrueEnd === undefined ||
      typeof candidate.isTrueEnd === "boolean")
  );
}

function isCatmaidMergeEndpoint(
  value: object | undefined,
): value is CatmaidSpatialSkeletonMergeEndpoint {
  if (value === undefined) return false;
  const candidate = value as {
    nodeId?: number;
    segmentId?: number;
    position?: object;
  };
  return (
    isFiniteNumber(candidate.nodeId) &&
    isFiniteNumber(candidate.segmentId) &&
    (candidate.position === undefined ||
      isSpatialSkeletonVector(candidate.position))
  );
}

function requireCatmaidCommandPayload<T extends object>(
  payload: object,
  label: string,
  isValid: (payload: object) => payload is T,
) {
  if (!isValid(payload)) {
    throw new Error(`CATMAID ${label} command received an invalid payload.`);
  }
  return payload;
}

export function requireCatmaidAddNodeCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "add-node",
    (candidate): candidate is CatmaidSpatialSkeletonAddNodeCommandOptions => {
      const options = candidate as {
        skeletonId?: number;
        parentNodeId?: number;
        positionInModelSpace?: object;
      };
      return (
        isFiniteNumber(options.skeletonId) &&
        isOptionalFiniteNumber(options.parentNodeId) &&
        isSpatialSkeletonVector(options.positionInModelSpace)
      );
    },
  );
}

export function requireCatmaidInsertNodeCommandOptions(payload: object) {
  const options = requireCatmaidAddNodeCommandOptions(payload);
  if (
    options.parentNodeId === undefined ||
    !Array.isArray(options.childNodeIds) ||
    options.childNodeIds.length === 0 ||
    !options.childNodeIds.every(isFiniteNumber) ||
    new Set(options.childNodeIds).size !== options.childNodeIds.length
  ) {
    throw new Error("CATMAID insert-node command received an invalid payload.");
  }
  return options;
}

export function requireCatmaidMoveNodeCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "move-node",
    (candidate): candidate is CatmaidSpatialSkeletonMoveNodeCommandOptions => {
      const options = candidate as {
        node?: object;
        nextPositionInModelSpace?: object;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        isSpatialSkeletonVector(options.nextPositionInModelSpace)
      );
    },
  );
}

export function requireCatmaidDeleteNodeCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "delete-node",
    isSpatiallyIndexedSkeletonNodePayload,
  );
}

export function requireCatmaidNodeDescriptionCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-description",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodeDescriptionCommandOptions => {
      const options = candidate as {
        node?: object;
        nextDescription?: string;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        (options.nextDescription === undefined ||
          typeof options.nextDescription === "string")
      );
    },
  );
}

export function requireCatmaidNodeTrueEndCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-true-end",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodeTrueEndCommandOptions => {
      const options = candidate as {
        node?: object;
        nextIsTrueEnd?: boolean;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        typeof options.nextIsTrueEnd === "boolean"
      );
    },
  );
}

export function requireCatmaidNodeRadiusCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-radius",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodeRadiusCommandOptions => {
      const options = candidate as {
        node?: object;
        nextRadius?: number;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        isFiniteNumber(options.nextRadius)
      );
    },
  );
}

export function requireCatmaidNodeConfidenceCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-confidence",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodeConfidenceCommandOptions => {
      const options = candidate as {
        node?: object;
        nextConfidence?: number;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        isFiniteNumber(options.nextConfidence)
      );
    },
  );
}

export function requireCatmaidRerootCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "reroot",
    (
      candidate,
    ): candidate is Pick<
      SpatiallyIndexedSkeletonNode,
      "nodeId" | "segmentId" | "parentNodeId"
    > &
      Partial<Pick<SpatiallyIndexedSkeletonNode, "position">> => {
      const node = candidate as {
        nodeId?: number;
        segmentId?: number;
        parentNodeId?: number;
        position?: object;
      };
      return (
        isFiniteNumber(node.nodeId) &&
        isFiniteNumber(node.segmentId) &&
        isOptionalFiniteNumber(node.parentNodeId) &&
        (node.position === undefined || isSpatialSkeletonVector(node.position))
      );
    },
  );
}

export function requireCatmaidSplitCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "split",
    (
      candidate,
    ): candidate is Pick<SpatiallyIndexedSkeletonNode, "nodeId" | "segmentId"> &
      Partial<
        Pick<SpatiallyIndexedSkeletonNode, "parentNodeId" | "position">
      > => {
      const node = candidate as {
        nodeId?: number;
        segmentId?: number;
        parentNodeId?: number;
        position?: object;
      };
      return (
        isFiniteNumber(node.nodeId) &&
        isFiniteNumber(node.segmentId) &&
        isOptionalFiniteNumber(node.parentNodeId) &&
        (node.position === undefined || isSpatialSkeletonVector(node.position))
      );
    },
  );
}

export function requireCatmaidMergeCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "merge",
    (candidate): candidate is CatmaidSpatialSkeletonMergeCommandPayload => {
      const options = candidate as {
        firstNode?: object;
        secondNode?: object;
      };
      return (
        isCatmaidMergeEndpoint(options.firstNode) &&
        isCatmaidMergeEndpoint(options.secondNode)
      );
    },
  );
}
