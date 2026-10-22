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

import type { SkeletonVector } from "#src/skeleton/api.js";
import type {
  SpatialSkeletonStableIdHandles,
  SpatialSkeletonStableNodeHandle,
  SpatialSkeletonStableSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";

export type SpatialSkeletonPreviewSelectionPin = "preserve" | "pin" | "unpin";

/**
 * Datasource-neutral, non-authoritative presentation wishes attached to one
 * exact intent. Logical handles deliberately keep provisional and remapped
 * authority out of datasource UI code.
 */
export interface SpatialSkeletonPreviewUiHints {
  readonly segmentMembershipRemaps?: readonly {
    readonly from: SpatialSkeletonStableSegmentHandle;
    readonly to: SpatialSkeletonStableSegmentHandle;
  }[];
  readonly segmentVisibility?: readonly {
    readonly segment: SpatialSkeletonStableSegmentHandle;
    readonly visible: boolean;
    readonly deselect?: boolean;
    readonly select?: SpatialSkeletonPreviewSelectionPin;
  }[];
  readonly selectedNode?:
    | {
        readonly kind: "select";
        readonly node: SpatialSkeletonStableNodeHandle;
        readonly segment?: SpatialSkeletonStableSegmentHandle;
        readonly position?: SkeletonVector;
        readonly pin?: SpatialSkeletonPreviewSelectionPin;
        readonly moveView?: boolean;
      }
    | {
        /** Refreshes its segment/position only if this node is still selected. */
        readonly kind: "refresh-if-selected";
        readonly node: SpatialSkeletonStableNodeHandle;
        readonly segment?: SpatialSkeletonStableSegmentHandle;
        readonly position?: SkeletonVector;
      }
    | { readonly kind: "clear" };
  /** Keeps edited complete snapshots available independently of visibility. */
  readonly retainSegments?: readonly SpatialSkeletonStableSegmentHandle[];
}

/** Fully-resolved single call made after the skeleton model was adopted. */
export interface SpatialSkeletonResolvedPreviewUiHints {
  readonly nodeIdRemappings: ReadonlyMap<bigint, bigint>;
  readonly segmentIdRemappings: ReadonlyMap<bigint, bigint>;
  readonly segmentVisibility: readonly {
    readonly segmentId: bigint;
    readonly visible: boolean;
    readonly deselect: boolean;
    readonly select?: SpatialSkeletonPreviewSelectionPin;
  }[];
  readonly selectedNode?:
    | {
        readonly kind: "select" | "refresh-if-selected";
        readonly nodeId: bigint;
        readonly segmentId?: bigint;
        readonly position?: SkeletonVector;
        readonly pin: SpatialSkeletonPreviewSelectionPin;
        readonly moveView: boolean;
      }
    | { readonly kind: "clear" };
  readonly retainSegmentIds: readonly bigint[];
}

/** Layer-owned adapter for best-effort selection and visibility effects. */
export interface SpatialSkeletonPreviewUiHintPort {
  apply(hints: SpatialSkeletonResolvedPreviewUiHints): void;
}

export function cloneSpatialSkeletonPreviewUiHints(
  hints: SpatialSkeletonPreviewUiHints | undefined,
): SpatialSkeletonPreviewUiHints | undefined {
  if (hints === undefined) return undefined;
  const segmentMembershipRemaps = hints.segmentMembershipRemaps?.map(
    ({ from, to }) =>
      Object.freeze({
        from: Object.freeze({ ...from }),
        to: Object.freeze({ ...to }),
      }),
  );
  const segmentVisibility = hints.segmentVisibility?.map((hint) =>
    Object.freeze({
      ...hint,
      segment: Object.freeze({ ...hint.segment }),
    }),
  );
  const selectedNode =
    hints.selectedNode === undefined
      ? undefined
      : hints.selectedNode.kind === "clear"
        ? Object.freeze({ kind: "clear" as const })
        : Object.freeze({
            ...hints.selectedNode,
            node: Object.freeze({ ...hints.selectedNode.node }),
            ...(hints.selectedNode.segment === undefined
              ? {}
              : {
                  segment: Object.freeze({
                    ...hints.selectedNode.segment,
                  }),
                }),
            ...(hints.selectedNode.position === undefined
              ? {}
              : {
                  position: Object.freeze(
                    Array.from(hints.selectedNode.position, Number),
                  ),
                }),
          });
  const retainSegments = hints.retainSegments?.map((segment) =>
    Object.freeze({ ...segment }),
  );
  return Object.freeze({
    ...(segmentMembershipRemaps === undefined
      ? {}
      : {
          segmentMembershipRemaps: Object.freeze(segmentMembershipRemaps),
        }),
    ...(segmentVisibility === undefined
      ? {}
      : { segmentVisibility: Object.freeze(segmentVisibility) }),
    ...(selectedNode === undefined ? {} : { selectedNode }),
    ...(retainSegments === undefined
      ? {}
      : { retainSegments: Object.freeze(retainSegments) }),
  });
}

export function mergeSpatialSkeletonPreviewUiHints(
  hints: readonly (SpatialSkeletonPreviewUiHints | undefined)[],
): SpatialSkeletonPreviewUiHints | undefined {
  const present = hints.filter(
    (value): value is SpatialSkeletonPreviewUiHints => value !== undefined,
  );
  if (present.length === 0) return undefined;
  return cloneSpatialSkeletonPreviewUiHints({
    segmentMembershipRemaps: present.flatMap(
      (value) => value.segmentMembershipRemaps ?? [],
    ),
    segmentVisibility: present.flatMap(
      (value) => value.segmentVisibility ?? [],
    ),
    selectedNode: [...present]
      .reverse()
      .find((value) => value.selectedNode !== undefined)?.selectedNode,
    retainSegments: present.flatMap((value) => value.retainSegments ?? []),
  });
}

interface SpatialSkeletonPreviewUiHintApplicationOptions {
  readonly port: SpatialSkeletonPreviewUiHintPort | undefined;
  readonly hints: SpatialSkeletonPreviewUiHints | undefined;
  readonly mappings: SpatialSkeletonStableIdHandles<bigint, bigint>;
  readonly fallbackMappings?: SpatialSkeletonStableIdHandles<bigint, bigint>;
  readonly nodeIdRemappings?: ReadonlyMap<bigint, bigint>;
  readonly segmentIdRemappings?: ReadonlyMap<bigint, bigint>;
  readonly createResolutionError: (
    resource: "node" | "segment",
    stableId: string,
  ) => Error;
  readonly reportError: (error: unknown) => void;
}

function resolveSpatialSkeletonPreviewUiHints(
  options: SpatialSkeletonPreviewUiHintApplicationOptions,
): SpatialSkeletonResolvedPreviewUiHints {
  const { hints, mappings, fallbackMappings } = options;
  const resolveNode = (handle: SpatialSkeletonStableNodeHandle) => {
    const nodeId =
      mappings.resolveNode(handle) ?? fallbackMappings?.resolveNode(handle);
    if (nodeId === undefined) {
      throw options.createResolutionError("node", handle.stableId);
    }
    return nodeId;
  };
  const resolveSegment = (handle: SpatialSkeletonStableSegmentHandle) => {
    const segmentId =
      mappings.resolveSegment(handle) ??
      fallbackMappings?.resolveSegment(handle);
    if (segmentId === undefined) {
      throw options.createResolutionError("segment", handle.stableId);
    }
    return segmentId;
  };

  const resolvedSegmentRemappings = new Map(options.segmentIdRemappings ?? []);
  for (const { from, to } of hints?.segmentMembershipRemaps ?? []) {
    const fromId = resolveSegment(from);
    const toId = resolveSegment(to);
    if (fromId !== toId) resolvedSegmentRemappings.set(fromId, toId);
  }

  const segmentVisibility = (hints?.segmentVisibility ?? []).map((hint) =>
    Object.freeze({
      segmentId: resolveSegment(hint.segment),
      visible: hint.visible,
      deselect: hint.deselect ?? !hint.visible,
      ...(hint.select === undefined ? {} : { select: hint.select }),
    }),
  );
  const selectedNode =
    hints?.selectedNode === undefined
      ? undefined
      : hints.selectedNode.kind === "clear"
        ? Object.freeze({ kind: "clear" as const })
        : Object.freeze({
            kind: hints.selectedNode.kind,
            nodeId: resolveNode(hints.selectedNode.node),
            ...(hints.selectedNode.segment === undefined
              ? {}
              : {
                  segmentId: resolveSegment(hints.selectedNode.segment),
                }),
            ...(hints.selectedNode.position === undefined
              ? {}
              : {
                  position: Object.freeze(
                    Array.from(hints.selectedNode.position, Number),
                  ),
                }),
            pin:
              hints.selectedNode.kind === "select"
                ? (hints.selectedNode.pin ?? "preserve")
                : "preserve",
            moveView:
              hints.selectedNode.kind === "select"
                ? (hints.selectedNode.moveView ?? false)
                : false,
          });
  const retainSegmentIds = Object.freeze([
    ...new Set((hints?.retainSegments ?? []).map(resolveSegment)),
  ]);
  return Object.freeze({
    nodeIdRemappings: new Map(options.nodeIdRemappings ?? []),
    segmentIdRemappings: resolvedSegmentRemappings,
    segmentVisibility: Object.freeze(segmentVisibility),
    ...(selectedNode === undefined ? {} : { selectedNode }),
    retainSegmentIds,
  });
}

/** Resolves and applies non-authoritative UI wishes after core adoption. */
export function applySpatialSkeletonPreviewUiHintsAfterAdoption(
  options: SpatialSkeletonPreviewUiHintApplicationOptions,
) {
  if (
    options.port === undefined ||
    (options.hints === undefined &&
      (options.nodeIdRemappings?.size ?? 0) === 0 &&
      (options.segmentIdRemappings?.size ?? 0) === 0)
  ) {
    return;
  }
  try {
    options.port.apply(resolveSpatialSkeletonPreviewUiHints(options));
  } catch (error) {
    options.reportError(error);
  }
}
