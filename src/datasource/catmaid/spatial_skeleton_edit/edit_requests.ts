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

/**
 * @file Commits each CATMAID edit request through CATMAID's edit operations and
 * classifies its failure as not started, rejected or indeterminate. Its edit
 * request scope is one CATMAID server and project.
 */

import type { CatmaidClient } from "#src/datasource/catmaid/api.js";
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
  CatmaidSpatialSkeletonEditOperations,
} from "#src/datasource/catmaid/spatial_skeleton_edit/edit_operations.js";
import type {
  SpatialSkeletonEditRequestContext,
  SpatialSkeletonEditRequestAdapter,
} from "#src/skeleton/edit_queue/api.js";
import { SpatialSkeletonEditConflictError } from "#src/skeleton/edit_queue/edit_errors.js";
import { HttpError } from "#src/util/http_request.js";

const catmaidEditRequestScopes = new Map<string, object>();

export function getCatmaidEditRequestScope(client: CatmaidClient) {
  if (
    typeof client.baseUrl !== "string" ||
    !Number.isSafeInteger(client.projectId)
  ) {
    return client;
  }
  let normalizedBaseUrl: string;
  try {
    const url = new URL(client.baseUrl);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    normalizedBaseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    normalizedBaseUrl = client.baseUrl.trim().replace(/\/+$/, "");
  }
  const key = `${normalizedBaseUrl}/${client.projectId}`;
  let scope = catmaidEditRequestScopes.get(key);
  if (scope === undefined) {
    scope = Object.freeze({ key });
    catmaidEditRequestScopes.set(key, scope);
  }
  return scope;
}

/**
 * CATMAID edit requests as seen by datasource-neutral optimistic machinery.
 *
 * Transport controls such as CATMAID's `nocheck` flag deliberately do not
 * cross this boundary. The CATMAID client applies its fixed transport policy.
 */
export interface CatmaidEditRequestMap {
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

export type CatmaidEditRequestKind = keyof CatmaidEditRequestMap;

export type CatmaidEditRequest<
  TKind extends CatmaidEditRequestKind = CatmaidEditRequestKind,
> = {
  [K in TKind]: {
    readonly kind: K;
    readonly request: CatmaidEditRequestMap[K]["request"];
  } & (K extends "merge"
    ? { readonly inputSegmentIds: readonly [bigint, bigint] }
    : object);
}[TKind];

export type CatmaidEditRequestResult<
  TKind extends CatmaidEditRequestKind = CatmaidEditRequestKind,
> = CatmaidEditRequestMap[TKind]["result"];

/** A generic cancellation was observed before any CATMAID operation began. */
export class CatmaidEditRequestNotStartedError extends Error {
  constructor(readonly reason: unknown) {
    super("The CATMAID edit request was cancelled before its request started.");
    this.name = "CatmaidEditRequestNotStartedError";
  }
}

/** Whether an error proves that CATMAID did not commit the edit request. */
export function isDefinitiveCatmaidEditRequestRejection(error: unknown) {
  return (
    error instanceof SpatialSkeletonEditConflictError ||
    (error instanceof HttpError && error.status >= 400 && error.status < 500) ||
    (error instanceof Error && error.name === "CatmaidNotFoundError")
  );
}

export class CatmaidEditRequests
  implements
    SpatialSkeletonEditRequestAdapter<
      CatmaidEditRequest,
      CatmaidEditRequestResult
    >
{
  constructor(
    private readonly editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  get editRequestScope() {
    return this.editOperations.editRequestScope;
  }

  commit<TKind extends CatmaidEditRequestKind>(
    editRequest: CatmaidEditRequest<TKind>,
    context: SpatialSkeletonEditRequestContext,
  ): Promise<CatmaidEditRequestResult<TKind>>;
  commit(
    editRequest: CatmaidEditRequest,
    context: SpatialSkeletonEditRequestContext,
  ): Promise<CatmaidEditRequestResult> {
    if (context.signal?.aborted) {
      return Promise.reject(
        new CatmaidEditRequestNotStartedError(context.signal.reason),
      );
    }
    switch (editRequest.kind) {
      case "add-node":
        return this.editOperations.commitAddNode(editRequest.request);
      case "insert-node":
        return this.editOperations.commitInsertNode(editRequest.request);
      case "move-node":
        return this.editOperations.commitMoveNode(editRequest.request);
      case "delete-node":
        return this.editOperations.commitDeleteNode(editRequest.request);
      case "reroot":
        return this.editOperations.commitReroot(editRequest.request);
      case "description":
        return this.editOperations.commitDescription(editRequest.request);
      case "true-end":
        return this.editOperations.commitTrueEnd(editRequest.request);
      case "radius":
        return this.editOperations.commitRadius(editRequest.request);
      case "confidence":
        return this.editOperations.commitConfidence(editRequest.request);
      case "merge":
        return this.editOperations.commitMerge(editRequest.request);
      case "split":
        return this.editOperations.commitSplit(editRequest.request);
    }
  }

  classifyFailure(error: unknown) {
    if (error instanceof CatmaidEditRequestNotStartedError) {
      return "not-started" as const;
    }
    return isDefinitiveCatmaidEditRequestRejection(error)
      ? ("rejected" as const)
      : ("indeterminate" as const);
  }
}
