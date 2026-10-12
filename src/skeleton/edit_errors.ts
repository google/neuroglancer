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

import {
  getSpatialSkeletonActionSupportLabel,
  type SpatialSkeletonAction,
  type SpatialSkeletonQueueInputRequirement,
} from "#src/skeleton/command_protocol.js";
import { formatErrorMessage } from "#src/util/error.js";

export type SpatialSkeletonInspectionRequiredReason =
  | "snapshot-unavailable"
  | "node-unavailable"
  | "snapshot-changed"
  | "requirements-changed";

/**
 * An edit admission preflight could not find its required node in a current,
 * complete projected skeleton snapshot.
 */
export class SpatialSkeletonInspectionRequiredError extends Error {
  readonly requirement: SpatialSkeletonQueueInputRequirement;
  readonly segmentId: number;
  readonly nodeId: number | undefined;

  constructor(
    requirement: SpatialSkeletonQueueInputRequirement,
    readonly action?: SpatialSkeletonAction,
    readonly reason: SpatialSkeletonInspectionRequiredReason = "snapshot-unavailable",
  ) {
    const actionDescription =
      action === undefined
        ? "editing it"
        : getSpatialSkeletonActionSupportLabel(action);
    let detail: string;
    if (reason === "node-unavailable" && requirement.nodeId !== undefined) {
      detail = `Node ${requirement.nodeId} is not present in inspected skeleton ${requirement.segmentId}. Re-inspect skeleton ${requirement.segmentId} before ${actionDescription}.`;
    } else if (reason === "snapshot-changed") {
      detail = `Inspected skeleton ${requirement.segmentId} changed before ${actionDescription}. Re-inspect it and try again.`;
    } else if (reason === "requirements-changed") {
      detail = `The skeleton edit endpoints changed before ${actionDescription}. Re-inspect the affected skeletons and try again.`;
    } else {
      detail = `Inspect skeleton ${requirement.segmentId} before ${actionDescription}.`;
    }
    super(detail);
    this.name = "SpatialSkeletonInspectionRequiredError";
    this.requirement = Object.freeze({ ...requirement });
    this.segmentId = requirement.segmentId;
    this.nodeId = requirement.nodeId;
  }
}

/** The edit committed, but local state needs recovery before further edits. */
export class SpatialSkeletonEditRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpatialSkeletonEditRecoveryError";
  }
}

export class SpatialSkeletonEditConflictError extends Error {
  constructor(detail?: string) {
    super(
      detail ??
        "The skeleton edit could not be applied because the source state is out of date.",
    );
    this.name = "SpatialSkeletonEditConflictError";
  }
}

export class SpatialSkeletonOptimisticQueueCapacityError extends Error {
  constructor(limit: number) {
    super(
      `Optimistic edit queue has reached its ${limit}-edit safety limit. Wait for the skeleton source to confirm some edits.`,
    );
    this.name = "SpatialSkeletonOptimisticQueueCapacityError";
  }
}

export function isSpatialSkeletonOutdatedStateError(error: unknown) {
  return error instanceof SpatialSkeletonEditConflictError;
}

export function isSpatialSkeletonOptimisticQueueCapacityError(error: unknown) {
  return error instanceof SpatialSkeletonOptimisticQueueCapacityError;
}

export function isSpatialSkeletonInspectionRequiredError(error: unknown) {
  return error instanceof SpatialSkeletonInspectionRequiredError;
}

export function isSpatialSkeletonRecoveryError(error: unknown) {
  return (
    isSpatialSkeletonOutdatedStateError(error) ||
    error instanceof SpatialSkeletonEditRecoveryError
  );
}

export function getSpatialSkeletonActionErrorMessage(
  action: string,
  error: unknown,
) {
  if (error instanceof SpatialSkeletonEditRecoveryError) {
    return {
      message: formatErrorMessage(error),
      requiresDismissal: true,
    };
  }
  if (isSpatialSkeletonOutdatedStateError(error)) {
    return {
      message: `Failed to ${action} due to outdated state. Refresh the page to sync.`,
      requiresDismissal: true,
    };
  }
  if (isSpatialSkeletonOptimisticQueueCapacityError(error)) {
    return {
      message: error.message,
      requiresDismissal: false,
    };
  }
  if (isSpatialSkeletonInspectionRequiredError(error)) {
    return {
      message: error.message,
      requiresDismissal: false,
    };
  }
  return {
    message: `Failed to ${action}: ${formatErrorMessage(error)}`,
    requiresDismissal: false,
  };
}
