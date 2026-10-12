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

import type { SpatialSkeletonVector } from "#src/skeleton/api.js";
import type {
  SpatialSkeletonLogicalHandleMappings,
  SpatialSkeletonLogicalNodeHandle,
  SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";

export type SpatialSkeletonProjectionSelectionPin =
  | "preserve"
  | "pin"
  | "unpin";

/**
 * Datasource-neutral, non-authoritative presentation wishes attached to one
 * exact intent. Logical handles deliberately keep provisional and remapped
 * authority out of datasource UI code.
 */
export interface SpatialSkeletonProjectionUiHints {
  readonly segmentMembershipRemaps?: readonly {
    readonly from: SpatialSkeletonLogicalSegmentHandle;
    readonly to: SpatialSkeletonLogicalSegmentHandle;
  }[];
  readonly segmentVisibility?: readonly {
    readonly segment: SpatialSkeletonLogicalSegmentHandle;
    readonly visible: boolean;
    readonly deselect?: boolean;
    readonly select?: SpatialSkeletonProjectionSelectionPin;
  }[];
  readonly selectedNode?:
    | {
        readonly kind: "select";
        readonly node: SpatialSkeletonLogicalNodeHandle;
        readonly segment?: SpatialSkeletonLogicalSegmentHandle;
        readonly position?: SpatialSkeletonVector;
        readonly pin?: SpatialSkeletonProjectionSelectionPin;
        readonly moveView?: boolean;
      }
    | {
        /** Refreshes its segment/position only if this node is still selected. */
        readonly kind: "refresh-if-selected";
        readonly node: SpatialSkeletonLogicalNodeHandle;
        readonly segment?: SpatialSkeletonLogicalSegmentHandle;
        readonly position?: SpatialSkeletonVector;
      }
    | { readonly kind: "clear" };
  /** Keeps edited complete snapshots available independently of visibility. */
  readonly retainSegments?: readonly SpatialSkeletonLogicalSegmentHandle[];
}

/** Fully-resolved single call made after the skeleton model was adopted. */
export interface SpatialSkeletonResolvedProjectionUiHints {
  readonly nodeIdRemappings: ReadonlyMap<number, number>;
  readonly segmentIdRemappings: ReadonlyMap<number, number>;
  readonly segmentVisibility: readonly {
    readonly segmentId: number;
    readonly visible: boolean;
    readonly deselect: boolean;
    readonly select?: SpatialSkeletonProjectionSelectionPin;
  }[];
  readonly selectedNode?:
    | {
        readonly kind: "select" | "refresh-if-selected";
        readonly nodeId: number;
        readonly segmentId?: number;
        readonly position?: SpatialSkeletonVector;
        readonly pin: SpatialSkeletonProjectionSelectionPin;
        readonly moveView: boolean;
      }
    | { readonly kind: "clear" };
  readonly retainSegmentIds: readonly number[];
}

/** Layer-owned adapter for best-effort selection and visibility effects. */
export interface SpatialSkeletonProjectionUiHintPort {
  apply(hints: SpatialSkeletonResolvedProjectionUiHints): void;
}

export function cloneSpatialSkeletonProjectionUiHints(
  hints: SpatialSkeletonProjectionUiHints | undefined,
): SpatialSkeletonProjectionUiHints | undefined {
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

export function mergeSpatialSkeletonProjectionUiHints(
  hints: readonly (SpatialSkeletonProjectionUiHints | undefined)[],
): SpatialSkeletonProjectionUiHints | undefined {
  const present = hints.filter(
    (value): value is SpatialSkeletonProjectionUiHints => value !== undefined,
  );
  if (present.length === 0) return undefined;
  return cloneSpatialSkeletonProjectionUiHints({
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

interface SpatialSkeletonProjectionUiHintApplicationOptions {
  readonly port: SpatialSkeletonProjectionUiHintPort | undefined;
  readonly hints: SpatialSkeletonProjectionUiHints | undefined;
  readonly mappings: SpatialSkeletonLogicalHandleMappings<number, number>;
  readonly fallbackMappings?: SpatialSkeletonLogicalHandleMappings<
    number,
    number
  >;
  readonly nodeIdRemappings?: ReadonlyMap<number, number>;
  readonly segmentIdRemappings?: ReadonlyMap<number, number>;
  readonly createResolutionError: (
    resource: "node" | "segment",
    stableId: string,
  ) => Error;
  readonly reportError: (error: unknown) => void;
}

function resolveSpatialSkeletonProjectionUiHints(
  options: SpatialSkeletonProjectionUiHintApplicationOptions,
): SpatialSkeletonResolvedProjectionUiHints {
  const { hints, mappings, fallbackMappings } = options;
  const resolveNode = (handle: SpatialSkeletonLogicalNodeHandle) => {
    const nodeId =
      mappings.resolveNode(handle) ?? fallbackMappings?.resolveNode(handle);
    if (nodeId === undefined) {
      throw options.createResolutionError("node", handle.stableId);
    }
    return nodeId;
  };
  const resolveSegment = (handle: SpatialSkeletonLogicalSegmentHandle) => {
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
export function applySpatialSkeletonProjectionUiHintsAfterAdoption(
  options: SpatialSkeletonProjectionUiHintApplicationOptions,
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
    options.port.apply(resolveSpatialSkeletonProjectionUiHints(options));
  } catch (error) {
    options.reportError(error);
  }
}
