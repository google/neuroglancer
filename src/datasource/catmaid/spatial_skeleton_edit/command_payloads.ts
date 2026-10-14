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

import type { SkeletonNode, SkeletonVector } from "#src/skeleton/api.js";

export interface CatmaidSpatialSkeletonAddNodeCommandOptions {
  skeletonId: bigint;
  parentNodeId: bigint | undefined;
  positionInModelSpace: SkeletonVector;
  childNodeIds?: readonly bigint[];
}

export interface CatmaidSpatialSkeletonMoveNodeCommandOptions {
  node: SkeletonNode;
  nextPositionInModelSpace: SkeletonVector;
}

export interface CatmaidSpatialSkeletonNodeDescriptionCommandOptions {
  node: SkeletonNode;
  nextDescription?: string;
}

export interface CatmaidSpatialSkeletonNodeTrueEndCommandOptions {
  node: SkeletonNode;
  nextIsTrueEnd: boolean;
}

export interface CatmaidSpatialSkeletonNodeRadiusCommandOptions {
  node: SkeletonNode;
  nextRadius: number;
}

export interface CatmaidSpatialSkeletonNodeConfidenceCommandOptions {
  node: SkeletonNode;
  nextConfidence: number;
}

export interface CatmaidSpatialSkeletonMergeEndpoint {
  nodeId: bigint;
  segmentId: bigint;
  position?: SkeletonVector;
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
      readonly node: SkeletonNode;
    }
  | {
      readonly kind: "reroot";
      readonly node: Pick<
        SkeletonNode,
        "nodeId" | "segmentId" | "parentNodeId"
      > &
        Partial<Pick<SkeletonNode, "position">>;
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
      readonly node: Pick<SkeletonNode, "nodeId" | "segmentId"> &
        Partial<Pick<SkeletonNode, "parentNodeId" | "position">>;
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

function isId(value: bigint | undefined) {
  return typeof value === "bigint";
}

function isOptionalId(value: bigint | undefined) {
  return value === undefined || isId(value);
}

function isSkeletonVector(value: object | undefined): value is SkeletonVector {
  // Coordinate contents are consumed by the generic reducer or CATMAID
  // transport. Admission only requires the user-facing value to be present.
  return value !== undefined;
}

function isSkeletonNodePayload(
  value: object | undefined,
): value is SkeletonNode {
  if (value === undefined) return false;
  const candidate = value as {
    nodeId?: bigint;
    segmentId?: bigint;
    position?: object;
    parentNodeId?: bigint;
    radius?: number;
    confidence?: number;
    description?: string;
    isTrueEnd?: boolean;
  };
  return (
    isId(candidate.nodeId) &&
    isId(candidate.segmentId) &&
    isSkeletonVector(candidate.position) &&
    isOptionalId(candidate.parentNodeId) &&
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
    nodeId?: bigint;
    segmentId?: bigint;
    position?: object;
  };
  return (
    isId(candidate.nodeId) &&
    isId(candidate.segmentId) &&
    (candidate.position === undefined || isSkeletonVector(candidate.position))
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
        skeletonId?: bigint;
        parentNodeId?: bigint;
        positionInModelSpace?: object;
      };
      return (
        isId(options.skeletonId) &&
        isOptionalId(options.parentNodeId) &&
        isSkeletonVector(options.positionInModelSpace)
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
    !options.childNodeIds.every(isId) ||
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
        isSkeletonNodePayload(options.node) &&
        isSkeletonVector(options.nextPositionInModelSpace)
      );
    },
  );
}

export function requireCatmaidDeleteNodeCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "delete-node",
    isSkeletonNodePayload,
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
        isSkeletonNodePayload(options.node) &&
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
        isSkeletonNodePayload(options.node) &&
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
        isSkeletonNodePayload(options.node) &&
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
        isSkeletonNodePayload(options.node) &&
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
      SkeletonNode,
      "nodeId" | "segmentId" | "parentNodeId"
    > &
      Partial<Pick<SkeletonNode, "position">> => {
      const node = candidate as {
        nodeId?: bigint;
        segmentId?: bigint;
        parentNodeId?: bigint;
        position?: object;
      };
      return (
        isId(node.nodeId) &&
        isId(node.segmentId) &&
        isOptionalId(node.parentNodeId) &&
        (node.position === undefined || isSkeletonVector(node.position))
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
    ): candidate is Pick<SkeletonNode, "nodeId" | "segmentId"> &
      Partial<Pick<SkeletonNode, "parentNodeId" | "position">> => {
      const node = candidate as {
        nodeId?: bigint;
        segmentId?: bigint;
        parentNodeId?: bigint;
        position?: object;
      };
      return (
        isId(node.nodeId) &&
        isId(node.segmentId) &&
        isOptionalId(node.parentNodeId) &&
        (node.position === undefined || isSkeletonVector(node.position))
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
