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

import type { SpatialSkeletonIntentKind } from "#src/skeleton/edit_queue/edit_intent_journal.js";
import type {
  SpatialSkeletonAuthorityLabels,
  SpatialSkeletonEditActivityEntry,
  SpatialSkeletonEditQueueEntry,
  SpatialSkeletonIntentLifecycle,
} from "#src/skeleton/edit_queue/types.js";
import { formatErrorMessage } from "#src/util/error.js";
import { HttpError } from "#src/util/http_request.js";

const ACTIVITY_REASON_LIMIT = 240;

export function formatSpatialSkeletonEditFailureReason(error: unknown) {
  let reason: string;
  if (error instanceof HttpError) {
    reason = `Request failed with HTTP ${error.status}${error.statusText === "" ? "" : ` (${error.statusText})`}.`;
    const httpMessage = new HttpError(error.url, error.status, error.statusText)
      .message;
    // Keep the provider's explanation without retaining request URLs in activity.
    if (error.message.startsWith(httpMessage)) {
      const providerMessage = error.message.slice(httpMessage.length).trim();
      if (providerMessage.length !== 0) reason += ` ${providerMessage}`;
    }
  } else {
    reason = formatErrorMessage(error);
  }
  reason = reason.replace(/\s+/g, " ").trim();
  if (reason.length <= ACTIVITY_REASON_LIMIT) return reason;
  return `${reason.slice(0, ACTIVITY_REASON_LIMIT - 1)}…`;
}

/** Fields needed to derive the public queue read models from canonical state. */
export interface SpatialSkeletonEditQueueRow {
  readonly sequence: number;
  readonly kind: SpatialSkeletonIntentKind;
  readonly lifecycle: SpatialSkeletonIntentLifecycle;
  readonly terminal: boolean;
  readonly rejectionReason: unknown;
  readonly canceledLaterIntentCount?: number;
  readonly metadata: {
    readonly kind: string;
    readonly commandLabel?: string;
    readonly authorityLabels?: SpatialSkeletonAuthorityLabels;
  };
}

function getRejectedActivityReason(entry: SpatialSkeletonEditQueueRow) {
  if (entry.rejectionReason === undefined) return undefined;
  const reason = formatSpatialSkeletonEditFailureReason(entry.rejectionReason);
  return entry.canceledLaterIntentCount !== undefined &&
    entry.lifecycle.authorityReason === "not-started"
    ? `The edit could not be submitted: ${reason}`
    : reason;
}

export function buildSpatialSkeletonEditQueueRows(
  entries: readonly SpatialSkeletonEditQueueRow[],
  queueInstanceId: number,
): readonly SpatialSkeletonEditQueueEntry[] {
  return entries.map((entry) => {
    const reason = getRejectedActivityReason(entry);
    return {
      queueInstanceId,
      operationId: entry.sequence,
      kind: entry.metadata.kind,
      lifecycle: entry.lifecycle,
      intent: entry.kind,
      commandLabel: entry.metadata.commandLabel,
      authorityLabels: entry.metadata.authorityLabels,
      ...(reason === undefined ? {} : { reason }),
      ...(entry.canceledLaterIntentCount === undefined
        ? {}
        : { error: entry.rejectionReason }),
      ...(entry.canceledLaterIntentCount === undefined
        ? {}
        : { canceledLaterIntentCount: entry.canceledLaterIntentCount }),
    };
  });
}

export function buildSpatialSkeletonEditRecentActivity(
  entries: readonly SpatialSkeletonEditQueueRow[],
  capacity: number,
): readonly SpatialSkeletonEditActivityEntry[] {
  return entries
    .filter((entry) => entry.terminal)
    .sort((first, second) => second.sequence - first.sequence)
    .slice(0, capacity)
    .map((entry) => {
      const { authority, authorityReason } = entry.lifecycle;
      const status =
        authority === "committed"
          ? "saved"
          : authorityReason === "no-op"
            ? "reverted"
            : "not-saved";
      const reason =
        status === "not-saved" ? getRejectedActivityReason(entry) : undefined;
      return {
        operationId: entry.sequence,
        kind: entry.metadata.kind,
        status,
        intent: entry.kind,
        commandLabel: entry.metadata.commandLabel,
        authorityReason,
        ...(reason === undefined || reason.length === 0 ? {} : { reason }),
        ...(entry.canceledLaterIntentCount === undefined
          ? {}
          : { canceledLaterIntentCount: entry.canceledLaterIntentCount }),
      };
    });
}
