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

export class SpatialSkeletonEditConflictError extends Error {
  constructor(detail?: string) {
    super(
      detail ??
        "The skeleton edit could not be applied because the source state is out of date.",
    );
    this.name = "SpatialSkeletonEditConflictError";
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isSpatialSkeletonOutdatedStateError(error: unknown) {
  return error instanceof SpatialSkeletonEditConflictError;
}

export function getSpatialSkeletonActionErrorMessage(
  action: string,
  error: unknown,
) {
  if (isSpatialSkeletonOutdatedStateError(error)) {
    return {
      message: `Failed to ${action} due to outdated state. Refresh the page to sync.`,
      requiresDismissal: true,
    };
  }
  return {
    message: `Failed to ${action}: ${formatError(error)}`,
    requiresDismissal: false,
  };
}
