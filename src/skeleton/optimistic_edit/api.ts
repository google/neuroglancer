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

import type { EditableSpatiallyIndexedSkeletonSource } from "#src/skeleton/api.js";
import type { SpatialSkeletonEditCommand } from "#src/skeleton/command_protocol.js";
import type {
  SpatialSkeletonLogicalHandleMappingResolution,
  SpatialSkeletonLogicalNodeHandle,
  SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import type { SpatialSkeletonIntentDriver } from "#src/skeleton/optimistic_edit/ports.js";
import type {
  SpatialSkeletonAuthoritativeReconciliation,
  SpatialSkeletonProjectionIntentDelta,
} from "#src/skeleton/optimistic_edit/projection_runtime.js";
import type { SpatialSkeletonProjectionInverseDelta } from "#src/skeleton/spatial_skeleton_projection_reducer.js";

/** Why the generic queue is asking a datasource adapter to mutate authority. */
export type SpatialSkeletonMutationIntent = "execute" | "undo" | "redo";

/**
 * Context common to every datasource mutation submitted by an optimistic
 * spatial-skeleton queue.
 *
 * This deliberately does not expose transport flags or a validation bypass.
 * A datasource may choose its own consistency mechanism for queue-serialized
 * work and map this semantic context to request details inside its adapter.
 */
export interface SpatialSkeletonMutationContext {
  readonly intent: SpatialSkeletonMutationIntent;
  readonly operationId: number;
  readonly signal?: AbortSignal;
}

/** Conservative authority classification after a failed mutation request. */
export type SpatialSkeletonMutationFailureDisposition =
  | "not-started"
  | "rejected"
  | "indeterminate";

/**
 * Transport-neutral result observed by optimistic queue orchestration.
 *
 * A rejected mutation is known not to have changed authority. An
 * indeterminate mutation may have changed authority and therefore requires a
 * reload before touching work can continue.
 */
export type SpatialSkeletonMutationOutcome<TResult> =
  | {
      readonly status: "committed";
      readonly result: TResult;
    }
  | {
      readonly status: SpatialSkeletonMutationFailureDisposition;
      readonly error: unknown;
      /** Present when the adapter itself failed to classify the mutation. */
      readonly classificationError?: unknown;
    };

/**
 * Datasource boundary used by generic optimistic queue machinery.
 *
 * Mutation and result payloads are intentionally type parameters. Projection
 * deltas, logical dependencies, history, replay, and presentation are generic
 * skeleton concerns; wire payloads and result normalization belong here.
 */
export interface SpatialSkeletonOptimisticMutationAdapter<TMutation, TResult> {
  /** Stable identity of the physical mutation target across queue recreation. */
  readonly mutationScope: object;

  /** Called only with the attempt materialized under its active authority lease. */
  commit(
    mutation: TMutation,
    context: SpatialSkeletonMutationContext,
  ): Promise<TResult>;

  classifyFailure(
    error: unknown,
    mutation: TMutation,
    context: SpatialSkeletonMutationContext,
  ): SpatialSkeletonMutationFailureDisposition;
}

/**
 * Invokes an adapter and turns every provider/transport outcome into the
 * finite state space understood by datasource-neutral queue orchestration.
 *
 * Classification failures are conservatively indeterminate: once commit has
 * been invoked, generic code must never infer that authority is unchanged.
 */
export async function commitSpatialSkeletonMutation<TMutation, TResult>(
  adapter: SpatialSkeletonOptimisticMutationAdapter<TMutation, TResult>,
  mutation: TMutation,
  context: SpatialSkeletonMutationContext,
): Promise<SpatialSkeletonMutationOutcome<TResult>> {
  try {
    return {
      status: "committed",
      result: await adapter.commit(mutation, context),
    };
  } catch (error) {
    try {
      return {
        status: adapter.classifyFailure(error, mutation, context),
        error,
      };
    } catch (classificationError) {
      return {
        status: "indeterminate",
        error,
        classificationError,
      };
    }
  }
}

export interface SpatialSkeletonOptimisticEditingContext {
  readonly source: EditableSpatiallyIndexedSkeletonSource;
  /** State-owned logical identity service shared with projection reduction. */
  readonly identities: SpatialSkeletonOptimisticIdentityService;
  /** State-owned allocator facade configured from the returned registration. */
  readonly provisionalIds: SpatialSkeletonProvisionalNumericIdService;
}

/**
 * Stable, datasource-neutral logical identities.  Drivers retain handles in
 * workflow recipes and resolve their current numeric authority only at the
 * transport boundary.
 */
export interface SpatialSkeletonOptimisticIdentityService {
  getOrCreateNodeHandle(nodeId: number): SpatialSkeletonLogicalNodeHandle;
  getOrCreateNodeHandles(
    nodeIds: readonly number[],
  ): ReadonlyMap<number, SpatialSkeletonLogicalNodeHandle>;
  getOrCreateSegmentHandle(
    segmentId: number,
  ): SpatialSkeletonLogicalSegmentHandle;
  resolveNode(handle: SpatialSkeletonLogicalNodeHandle): number | undefined;
  resolveSegment(
    handle: SpatialSkeletonLogicalSegmentHandle,
  ): number | undefined;
  resolveAuthoritativeNode(
    handle: SpatialSkeletonLogicalNodeHandle,
  ): number | undefined;
  resolveAuthoritativeSegment(
    handle: SpatialSkeletonLogicalSegmentHandle,
  ): number | undefined;
  resolveNodeTarget(
    handle: SpatialSkeletonLogicalNodeHandle,
  ): SpatialSkeletonLogicalHandleMappingResolution<number>;
  resolveSegmentTarget(
    handle: SpatialSkeletonLogicalSegmentHandle,
  ): SpatialSkeletonLogicalHandleMappingResolution<number>;
}

/** Optional datasource policy for locally-presented positive numeric ids. */
export interface SpatialSkeletonProvisionalNumericIdPolicy {
  allocateNodeId(intentId: number): number;
  allocateSegmentId(intentId: number): number;
}

/** Facade captured by a driver and configured by its registration. */
export interface SpatialSkeletonProvisionalNumericIdService {
  allocateNodeId(intentId: number): number;
  allocateSegmentId(intentId: number): number;
}

/**
 * The only datasource-owned pieces of optimistic editing.  Queue lifecycle,
 * history, identities, projection state, scheduling, and fatal state are
 * deliberately absent and are always constructed by SpatialSkeletonState.
 */
export interface SpatialSkeletonOptimisticDriverRegistration {
  readonly driver: SpatialSkeletonIntentDriver<
    SpatialSkeletonEditCommand,
    any,
    SpatialSkeletonProjectionIntentDelta,
    any,
    any,
    SpatialSkeletonAuthoritativeReconciliation,
    SpatialSkeletonProjectionInverseDelta
  >;
  readonly mutationAdapter: SpatialSkeletonOptimisticMutationAdapter<any, any>;
  readonly provisionalNumericIdPolicy?: SpatialSkeletonProvisionalNumericIdPolicy;
  readonly cleanup?: () => void;
}

/** Required capability exposed by every editable spatial-skeleton source. */
export interface SpatialSkeletonOptimisticEditingProvider {
  createDriver(
    context: SpatialSkeletonOptimisticEditingContext,
  ): SpatialSkeletonOptimisticDriverRegistration;
}

export class SpatialSkeletonOptimisticDatasourceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialSkeletonOptimisticDatasourceContractError";
  }
}

export function isSpatialSkeletonOptimisticEditingProvider(
  value: unknown,
): value is SpatialSkeletonOptimisticEditingProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createDriver?: unknown }).createDriver === "function"
  );
}

export function assertSpatialSkeletonOptimisticDriverRegistration(
  value: unknown,
): asserts value is SpatialSkeletonOptimisticDriverRegistration {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { driver?: unknown }).driver !== "object" ||
    (value as { driver?: unknown }).driver === null ||
    typeof (value as { mutationAdapter?: unknown }).mutationAdapter !==
      "object" ||
    (value as { mutationAdapter?: unknown }).mutationAdapter === null
  ) {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Editable spatial skeleton datasource createDriver() must return a workflow driver and mutation adapter.",
    );
  }
  const allowedRegistrationKeys = new Set([
    "driver",
    "mutationAdapter",
    "provisionalNumericIdPolicy",
    "cleanup",
  ]);
  for (const key of Object.keys(value)) {
    if (allowedRegistrationKeys.has(key)) continue;
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      `Editable spatial skeleton datasource driver registration contains engine-owned field "${key}".`,
    );
  }
  const driver = (value as { driver: Record<string, unknown> }).driver;
  for (const method of [
    "describeIntent",
    "createLogicalIntent",
    "nextAttempt",
    "createReconciliation",
  ]) {
    if (typeof driver[method] !== "function") {
      throw new SpatialSkeletonOptimisticDatasourceContractError(
        `Editable spatial skeleton datasource driver is missing ${method}().`,
      );
    }
  }
  const adapter = (value as { mutationAdapter: Record<string, unknown> })
    .mutationAdapter;
  for (const method of ["commit", "classifyFailure"]) {
    if (typeof adapter[method] !== "function") {
      throw new SpatialSkeletonOptimisticDatasourceContractError(
        `Editable spatial skeleton datasource mutation adapter is missing ${method}().`,
      );
    }
  }
  let mutationScope: unknown;
  try {
    mutationScope = adapter.mutationScope;
  } catch {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Editable spatial skeleton datasource mutation adapter mutationScope could not be resolved.",
    );
  }
  if (
    mutationScope === null ||
    (typeof mutationScope !== "object" && typeof mutationScope !== "function")
  ) {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Editable spatial skeleton datasource mutation adapter must expose a stable object mutationScope.",
    );
  }
  const policy = (
    value as { provisionalNumericIdPolicy?: Record<string, unknown> }
  ).provisionalNumericIdPolicy;
  if (
    policy !== undefined &&
    (typeof policy !== "object" ||
      policy === null ||
      typeof policy.allocateNodeId !== "function" ||
      typeof policy.allocateSegmentId !== "function")
  ) {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "A provisional numeric-ID policy must implement allocateNodeId() and allocateSegmentId().",
    );
  }
  const cleanup = (value as { cleanup?: unknown }).cleanup;
  if (cleanup !== undefined && typeof cleanup !== "function") {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Editable spatial skeleton datasource cleanup must be a function.",
    );
  }
}
