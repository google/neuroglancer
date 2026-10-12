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

import type { CatmaidSpatialSkeletonEditOperations } from "#src/datasource/catmaid/spatial_skeleton_edit/edit_operations.js";
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
import { SpatialSkeletonEditConflictError } from "#src/skeleton/edit_errors.js";
import {
  type SpatialSkeletonMutationContext,
  type SpatialSkeletonOptimisticMutationAdapter,
} from "#src/skeleton/optimistic_edit/api.js";
import { HttpError } from "#src/util/http_request.js";

/**
 * CATMAID mutations as seen by datasource-neutral optimistic machinery.
 *
 * Transport controls such as CATMAID's `nocheck` flag deliberately do not
 * cross this boundary. The CATMAID client applies its fixed transport policy.
 */
export interface CatmaidOptimisticMutationMap {
  "add-node": {
    request: CatmaidSpatialSkeletonAddNodeRequest;
    result: CatmaidSpatialSkeletonAddNodeResult;
  };
  "insert-node": {
    request: CatmaidSpatialSkeletonInsertNodeRequest;
    result: CatmaidSpatialSkeletonInsertNodeResult;
  };
  "move-node": {
    request: CatmaidSpatialSkeletonMoveNodeRequest;
    result: void;
  };
  "delete-node": {
    request: CatmaidSpatialSkeletonDeleteNodeRequest;
    result: void;
  };
  reroot: {
    request: CatmaidSpatialSkeletonRerootRequest;
    result: void;
  };
  description: {
    request: CatmaidSpatialSkeletonDescriptionUpdateRequest;
    result: CatmaidSpatialSkeletonDescriptionUpdateResult;
  };
  "true-end": {
    request: CatmaidSpatialSkeletonTrueEndUpdateRequest;
    result: void;
  };
  radius: {
    request: CatmaidSpatialSkeletonRadiusUpdateRequest;
    result: void;
  };
  confidence: {
    request: CatmaidSpatialSkeletonConfidenceUpdateRequest;
    result: void;
  };
  merge: {
    request: CatmaidSpatialSkeletonMergeRequest;
    result: CatmaidSpatialSkeletonMergeResult;
  };
  split: {
    request: CatmaidSpatialSkeletonSplitRequest;
    result: CatmaidSpatialSkeletonSplitResult;
  };
}

export type CatmaidOptimisticMutationKind = keyof CatmaidOptimisticMutationMap;

export type CatmaidOptimisticMutation<
  TKind extends CatmaidOptimisticMutationKind = CatmaidOptimisticMutationKind,
> = {
  [K in TKind]: {
    readonly kind: K;
    readonly request: CatmaidOptimisticMutationMap[K]["request"];
  } & (K extends "merge"
    ? { readonly inputSegmentIds: readonly [number, number] }
    : object);
}[TKind];

export type CatmaidOptimisticMutationResult<
  TKind extends CatmaidOptimisticMutationKind = CatmaidOptimisticMutationKind,
> = CatmaidOptimisticMutationMap[TKind]["result"];

/** A generic cancellation was observed before any CATMAID operation began. */
export class CatmaidOptimisticMutationNotStartedError extends Error {
  constructor(readonly reason: unknown) {
    super("The CATMAID mutation was cancelled before its request started.");
    this.name = "CatmaidOptimisticMutationNotStartedError";
  }
}

/** Whether an error proves that CATMAID did not commit the mutation. */
export function isDefinitiveCatmaidMutationRejection(error: unknown) {
  return (
    error instanceof SpatialSkeletonEditConflictError ||
    (error instanceof HttpError && error.status >= 400 && error.status < 500) ||
    (error instanceof Error && error.name === "CatmaidNotFoundError")
  );
}

export class CatmaidSpatialSkeletonOptimisticMutationAdapter
  implements
    SpatialSkeletonOptimisticMutationAdapter<
      CatmaidOptimisticMutation,
      CatmaidOptimisticMutationResult
    >
{
  constructor(
    private readonly editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  get mutationScope() {
    return this.editOperations.mutationScope;
  }

  commit<TKind extends CatmaidOptimisticMutationKind>(
    mutation: CatmaidOptimisticMutation<TKind>,
    context: SpatialSkeletonMutationContext,
  ): Promise<CatmaidOptimisticMutationResult<TKind>>;
  commit(
    mutation: CatmaidOptimisticMutation,
    context: SpatialSkeletonMutationContext,
  ): Promise<CatmaidOptimisticMutationResult> {
    if (context.signal?.aborted) {
      return Promise.reject(
        new CatmaidOptimisticMutationNotStartedError(context.signal.reason),
      );
    }
    switch (mutation.kind) {
      case "add-node":
        return this.editOperations.commitAddNode(mutation.request);
      case "insert-node":
        return this.editOperations.commitInsertNode(mutation.request);
      case "move-node":
        return this.editOperations.commitMoveNode(mutation.request);
      case "delete-node":
        return this.editOperations.commitDeleteNode(mutation.request);
      case "reroot":
        return this.editOperations.commitReroot(mutation.request);
      case "description":
        return this.editOperations.commitDescription(mutation.request);
      case "true-end":
        return this.editOperations.commitTrueEnd(mutation.request);
      case "radius":
        return this.editOperations.commitRadius(mutation.request);
      case "confidence":
        return this.editOperations.commitConfidence(mutation.request);
      case "merge":
        return this.editOperations.commitMerge(mutation.request);
      case "split":
        return this.editOperations.commitSplit(mutation.request);
    }
  }

  classifyFailure(error: unknown) {
    if (error instanceof CatmaidOptimisticMutationNotStartedError) {
      return "not-started" as const;
    }
    return isDefinitiveCatmaidMutationRejection(error)
      ? ("rejected" as const)
      : ("indeterminate" as const);
  }
}
