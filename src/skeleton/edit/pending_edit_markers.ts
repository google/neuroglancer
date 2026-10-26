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

import type { SpatialSkeletonPendingEdit } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import type {
  SkeletonNodeRing,
  SkeletonPendingEditConnector,
  SkeletonPendingEditMarker,
} from "#src/skeleton/spatial/node_overlay.js";

export type PendingEditMarker =
  | {
      readonly type: "marker";
      readonly intentId: number;
      readonly cueKind: SpatialSkeletonPendingEdit["kind"];
      readonly lifecycle: SpatialSkeletonPendingEdit["lifecycle"];
      readonly nodeId: bigint;
      readonly position: Float32Array;
    }
  | {
      readonly type: "connector";
      readonly intentId: number;
      readonly cueKind: SpatialSkeletonPendingEdit["kind"];
      readonly lifecycle: SpatialSkeletonPendingEdit["lifecycle"];
      readonly fromNodeId: bigint;
      readonly toNodeId: bigint;
      readonly from: Float32Array;
      readonly to: Float32Array;
    };

/**
 * Converts semantic cues into model-space primitives using only explicitly
 * supplied relationships and positions.  Missing endpoints are omitted rather
 * than guessed, which keeps a cold preview truthful.
 */
export function buildPendingEditMarkers(
  pendingEdits: readonly SpatialSkeletonPendingEdit[],
  getLivePosition: (nodeId: bigint) => ArrayLike<number> | undefined,
): PendingEditMarker[] {
  const cues: PendingEditMarker[] = [];
  for (const cue of pendingEdits) {
    const capturedPositions = new Map(
      cue.lastKnownPositions?.map(({ nodeId, position }) => [
        nodeId,
        position,
      ]) ?? [],
    );
    const resolvedPositions = new Map<bigint, Float32Array>();
    const resolve = (nodeId: bigint) => {
      const existing = resolvedPositions.get(nodeId);
      if (existing !== undefined) return existing;
      const candidate =
        getLivePosition(nodeId) ?? capturedPositions.get(nodeId);
      if (candidate === undefined) return undefined;
      const position = new Float32Array([
        Number(candidate[0]),
        Number(candidate[1]),
        Number(candidate[2]),
      ]);
      if (!position.every(Number.isFinite)) return undefined;
      resolvedPositions.set(nodeId, position);
      return position;
    };
    const markedNodeIds = new Set<bigint>();
    const addMarker = (nodeId: bigint | undefined) => {
      if (nodeId === undefined || markedNodeIds.has(nodeId)) return;
      const position = resolve(nodeId);
      if (position === undefined) return;
      markedNodeIds.add(nodeId);
      cues.push({
        type: "marker",
        intentId: cue.intentId,
        cueKind: cue.kind,
        lifecycle: cue.lifecycle,
        nodeId,
        position,
      });
    };
    const connectedPairs = new Set<string>();
    const addConnector = (
      fromNodeId: bigint | undefined,
      toNodeId: bigint | undefined,
    ) => {
      if (
        fromNodeId === undefined ||
        toNodeId === undefined ||
        fromNodeId === toNodeId
      ) {
        return;
      }
      const key = `${fromNodeId}:${toNodeId}`;
      if (connectedPairs.has(key)) return;
      const from = resolve(fromNodeId);
      const to = resolve(toNodeId);
      if (from === undefined || to === undefined) return;
      connectedPairs.add(key);
      cues.push({
        type: "connector",
        intentId: cue.intentId,
        cueKind: cue.kind,
        lifecycle: cue.lifecycle,
        fromNodeId,
        toNodeId,
        from,
        to,
      });
    };
    const addKnownPath = (nodeIds: readonly bigint[] | undefined) => {
      if (nodeIds === undefined) return;
      for (const nodeId of nodeIds) addMarker(nodeId);
      for (let i = 1; i < nodeIds.length; ++i) {
        addConnector(nodeIds[i - 1], nodeIds[i]);
      }
    };

    switch (cue.kind) {
      case "merge": {
        const endpoints = cue.endpointNodeIds ?? [];
        addMarker(endpoints[0]);
        addMarker(endpoints[1]);
        addConnector(endpoints[0], endpoints[1]);
        break;
      }
      case "split":
        addMarker(cue.cutNodeId);
        addMarker(cue.cutParentNodeId);
        addConnector(cue.cutParentNodeId, cue.cutNodeId);
        addKnownPath(cue.pathNodeIds);
        break;
      case "delete":
      case "restore":
        addMarker(cue.nodeId);
        break;
      case "reroot":
        addMarker(cue.rootNodeId);
        addKnownPath(cue.pathNodeIds);
        break;
    }
  }
  return cues;
}

const CUE_LABELS: Record<PendingEditMarker["cueKind"], string> = {
  delete: "×",
  restore: "+",
  reroot: "R",
  split: "S",
  merge: "M",
};

export function getPendingEditMarkerPrimitives(
  cues: readonly PendingEditMarker[],
  ring: SkeletonNodeRing,
  toGlobalPosition: (
    modelPosition: ArrayLike<number>,
  ) => Float32Array | undefined,
): (SkeletonPendingEditMarker | SkeletonPendingEditConnector)[] {
  // The cue ring sits outside the selection ring of the same node.
  const cueRing = {
    diameter: ring.diameter + 6,
    borderWidth: Math.max(2, ring.borderWidth * 0.75),
  };
  const primitives: (
    | SkeletonPendingEditMarker
    | SkeletonPendingEditConnector
  )[] = [];
  for (const cue of cues) {
    if (cue.type === "marker") {
      const position = toGlobalPosition(cue.position);
      if (position === undefined) continue;
      primitives.push({
        kind: "preparationMarker",
        position,
        label: CUE_LABELS[cue.cueKind],
        ring: cueRing,
      });
    } else {
      const from = toGlobalPosition(cue.from);
      const to = toGlobalPosition(cue.to);
      if (from === undefined || to === undefined) continue;
      primitives.push({
        kind: "preparationConnector",
        from,
        to,
        width: Math.max(2, ring.borderWidth * 0.65),
      });
    }
  }
  return primitives;
}
