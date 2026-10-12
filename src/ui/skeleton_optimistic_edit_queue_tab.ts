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

import "#src/ui/skeleton_tab.css";

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { formatSpatialSkeletonOptimisticEditFailureReason } from "#src/skeleton/optimistic_edit/engine_read_model.js";
import { SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON } from "#src/skeleton/optimistic_edit/fatal.js";
import type { SpatialSkeletonOptimisticIntentLifecycle } from "#src/skeleton/optimistic_edit/lifecycle.js";
import type {
  SpatialSkeletonOptimisticEditActivityEntry,
  SpatialSkeletonOptimisticEditQueueEntry,
} from "#src/skeleton/optimistic_edit/types.js";
import { StatusMessage } from "#src/status.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { HttpError } from "#src/util/http_request.js";
import { Tab } from "#src/widget/tab_view.js";

function getOptimisticEditQueueEntries(layer: SegmentationUserLayer) {
  return layer.spatialSkeletonState.getOptimisticEditQueueSnapshot();
}

function getOptimisticEditQueueRecentActivity(layer: SegmentationUserLayer) {
  return layer.spatialSkeletonState.getOptimisticEditQueueRecentActivity();
}

const NOT_SUBMITTED_ACTIVITY_PREFIX = "The edit could not be submitted: ";

function getAuthorityFailureCause(
  entry: Pick<
    SpatialSkeletonOptimisticEditQueueEntry,
    "lifecycle" | "reason" | "error"
  >,
) {
  const reason =
    entry.error instanceof HttpError
      ? formatSpatialSkeletonOptimisticEditFailureReason(entry.error)
      : entry.reason?.trim();
  if (reason === undefined || reason.length === 0) {
    return "The edit was not saved.";
  }
  return entry.lifecycle.authorityReason === "not-started" &&
    reason.startsWith(NOT_SUBMITTED_ACTIVITY_PREFIX)
    ? reason.slice(NOT_SUBMITTED_ACTIVITY_PREFIX.length)
    : reason;
}

function getAuthorityFailureMessage(
  entry: SpatialSkeletonOptimisticEditQueueEntry,
) {
  const presentation = entry.authorityPresentation;
  const authorityReason = entry.lifecycle.authorityReason;
  if (
    presentation === undefined ||
    (authorityReason !== "not-started" && authorityReason !== "rejected")
  ) {
    return undefined;
  }
  const cause = getAuthorityFailureCause(entry);
  const failure =
    authorityReason === "not-started"
      ? `Unable to submit ${presentation.operationNoun}; no ${presentation.authorityLabel} mutation request was started. The invalid preview was removed. ${cause}`
      : `${presentation.authorityLabel} rejected ${presentation.operationNoun}. The optimistic preview was removed. ${cause}`;
  const canceled = entry.canceledLaterIntentCount ?? 0;
  return canceled === 0
    ? failure
    : `${failure} ${canceled} later queued ${canceled === 1 ? "edit was" : "edits were"} also canceled.`;
}

/**
 * Generic notification projection for authority lifecycle changes.
 *
 * Datasources provide immutable wording on the intent. This controller owns
 * timers and notification handles and derives their lifetime entirely from
 * generic queue snapshots, so no datasource queue/lifecycle state is needed.
 */
export class SpatialSkeletonOptimisticAuthorityNotificationController {
  private readonly stalledTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly stalledNotifications = new Map<string, StatusMessage>();
  private readonly reportedFailures = new Set<string>();
  private disposed = false;

  constructor(private readonly layer: SegmentationUserLayer) {
    this.update();
  }

  update() {
    if (this.disposed) return;
    const entries = getOptimisticEditQueueEntries(this.layer);
    const runningKeys = new Set<string>();
    for (const entry of entries) {
      const operationId = entry.operationId;
      const warning = entry.authorityPresentation?.stalledWarning;
      if (
        operationId === undefined ||
        entry.lifecycle.authority !== "running" ||
        warning === undefined ||
        !Number.isFinite(warning.delayMs) ||
        warning.delayMs < 0
      ) {
        continue;
      }
      const key = this.getEntryKey(entry.queueInstanceId, operationId);
      runningKeys.add(key);
      if (this.stalledTimers.has(key) || this.stalledNotifications.has(key)) {
        continue;
      }
      const timeout = setTimeout(() => {
        this.stalledTimers.delete(key);
        if (this.disposed) return;
        const current = getOptimisticEditQueueEntries(this.layer).find(
          (candidate) =>
            this.getEntryKey(
              candidate.queueInstanceId,
              candidate.operationId,
            ) === key,
        );
        if (current?.lifecycle.authority !== "running") return;
        const message = current.authorityPresentation?.stalledWarning?.message;
        if (message === undefined) return;
        this.stalledNotifications.set(
          key,
          StatusMessage.showErrorMessage(message),
        );
      }, warning.delayMs);
      this.stalledTimers.set(key, timeout);
    }

    for (const [key, timeout] of this.stalledTimers) {
      if (runningKeys.has(key)) continue;
      clearTimeout(timeout);
      this.stalledTimers.delete(key);
    }
    for (const [key, notification] of this.stalledNotifications) {
      if (runningKeys.has(key)) continue;
      notification.dispose();
      this.stalledNotifications.delete(key);
    }

    // Scan the retained canonical queue projection rather than the bounded
    // Recent activity list. A large rejected closure can otherwise push its
    // root outside the capacity-bounded activity window before this observer runs.
    for (const entry of entries) {
      const operationId = entry.operationId;
      // The root rejection always records the closure size, including zero.
      // Dependants have no count and must not emit duplicate notifications.
      if (
        operationId === undefined ||
        entry.canceledLaterIntentCount === undefined
      ) {
        continue;
      }
      const key = this.getEntryKey(entry.queueInstanceId, operationId);
      if (this.reportedFailures.has(key)) continue;
      const message = getAuthorityFailureMessage(entry);
      if (message === undefined) continue;
      this.reportedFailures.add(key);
      if (!this.disposed) StatusMessage.showErrorMessage(message);
    }
  }

  private getEntryKey(
    queueInstanceId: number | undefined,
    operationId: number | undefined,
  ) {
    return `${queueInstanceId ?? 0}:${operationId ?? ""}`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const timeout of this.stalledTimers.values()) clearTimeout(timeout);
    this.stalledTimers.clear();
    for (const notification of this.stalledNotifications.values()) {
      notification.dispose();
    }
    this.stalledNotifications.clear();
  }
}

const actionLabels: Readonly<Record<string, string>> = {
  addNode: "Add node",
  moveNode: "Move node",
  deleteNode: "Delete node",
  rerootSkeleton: "Reroot skeleton",
  editDescription: "Edit node description",
  editTrueEnd: "Edit node end state",
  editRadius: "Edit node radius",
  editConfidence: "Edit node confidence",
  splitSkeleton: "Split skeleton",
  mergeSkeletons: "Merge skeletons",
};

type PrimaryLifecyclePresentation =
  | "reload-required"
  | "preparing"
  | "saving"
  | "reconciling"
  | "queued"
  | "saved"
  | "not-saved"
  | "reverted"
  | "processing";

const lifecyclePresentation: Readonly<
  Record<PrimaryLifecyclePresentation, { label: string; description: string }>
> = {
  "reload-required": {
    label: "Reload required",
    description: SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON,
  },
  preparing: {
    label: "Preparing",
    description: "Preparing the local preview",
  },
  saving: {
    label: "Saving",
    description: "Being saved to the skeleton source",
  },
  reconciling: {
    label: "Reconciling",
    description: "Applying the authoritative result locally",
  },
  queued: {
    label: "Queued",
    description: "Waiting to be saved",
  },
  saved: {
    label: "Saved",
    description: "Saved to the skeleton source",
  },
  "not-saved": {
    label: "Not saved",
    description: "This edit was not saved",
  },
  reverted: {
    label: "Reverted",
    description: "The local preview was reverted",
  },
  processing: {
    label: "Processing",
    description: "This edit is being processed",
  },
};

function lowercaseFirst(value: string) {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

function getOptimisticEditQueueEntryLabel(
  entry: Pick<
    SpatialSkeletonOptimisticEditQueueEntry,
    "kind" | "intent" | "commandLabel"
  >,
) {
  const commandLabel =
    entry.commandLabel?.trim() || actionLabels[entry.kind] || "Update skeleton";
  if (entry.intent === "undo") {
    return `Undo ${lowercaseFirst(commandLabel)}`;
  }
  if (entry.intent === "redo") {
    return `Redo ${lowercaseFirst(commandLabel)}`;
  }
  return commandLabel;
}

function getPrimaryLifecyclePresentation(
  lifecycle: SpatialSkeletonOptimisticIntentLifecycle,
): PrimaryLifecyclePresentation {
  const { authority, authorityReason, history, preview, reconciliation } =
    lifecycle;
  if (authority === "indeterminate" || reconciliation === "blocked") {
    return "reload-required";
  }
  if (preview === "reserved" || preview === "preparing") return "preparing";
  if (authority === "running") return "saving";
  if (
    authority === "committed" &&
    (reconciliation === "waiting" ||
      reconciliation === "pending" ||
      reconciliation === "applying")
  ) {
    return "reconciling";
  }
  if (authority === "queued" || authority === "waiting") return "queued";
  if (
    authority === "committed" &&
    (reconciliation === "complete" || reconciliation === "not-required")
  ) {
    return "saved";
  }
  if (
    (authority === "unchanged" && authorityReason === "rejected") ||
    history === "rejected"
  ) {
    return "not-saved";
  }
  if (
    authority === "unchanged" &&
    (authorityReason === "not-started" || authorityReason === "no-op")
  ) {
    return "reverted";
  }
  return "processing";
}

function isPendingEntry(entry: SpatialSkeletonOptimisticEditQueueEntry) {
  const primary = getPrimaryLifecyclePresentation(entry.lifecycle);
  return (
    primary === "reload-required" ||
    primary === "preparing" ||
    primary === "saving" ||
    primary === "reconciling" ||
    primary === "queued" ||
    primary === "processing"
  );
}

export class SpatialSkeletonOptimisticEditQueueTab extends Tab {
  private readonly queueSummary = document.createElement("div");
  private readonly queueList = document.createElement("div");
  private readonly activityList = document.createElement("div");
  private readonly queuePanel: HTMLElement;
  private readonly explanation: HTMLElement;
  private fatalBanner: HTMLElement | undefined;

  constructor(public layer: SegmentationUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-skeleton-queue-tab");

    const queuePanel = document.createElement("section");
    this.queuePanel = queuePanel;
    queuePanel.className = "neuroglancer-skeleton-queue";
    const queueHeader = document.createElement("div");
    queueHeader.className = "neuroglancer-skeleton-queue-header";
    const queueTitle = document.createElement("div");
    queueTitle.className = "neuroglancer-skeleton-queue-title";
    queueTitle.textContent = "Skeleton edit queue";
    this.queueSummary.className = "neuroglancer-skeleton-queue-summary";
    queueHeader.appendChild(queueTitle);
    queueHeader.appendChild(this.queueSummary);
    queuePanel.appendChild(queueHeader);
    const explanation = document.createElement("div");
    this.explanation = explanation;
    explanation.className = "neuroglancer-skeleton-queue-explanation";
    explanation.textContent =
      "Edits appear immediately and are saved in a safe order.";
    queuePanel.appendChild(explanation);
    const queueListTitle = document.createElement("div");
    queueListTitle.className = "neuroglancer-skeleton-queue-section-title";
    queueListTitle.textContent = "Pending edits";
    queuePanel.appendChild(queueListTitle);
    this.queueList.className = "neuroglancer-skeleton-queue-list";
    queuePanel.appendChild(this.queueList);
    const activityTitle = document.createElement("div");
    activityTitle.className = "neuroglancer-skeleton-queue-section-title";
    activityTitle.textContent = "Recent activity";
    queuePanel.appendChild(activityTitle);
    const activityExplanation = document.createElement("div");
    activityExplanation.className =
      "neuroglancer-skeleton-queue-activity-explanation";
    activityExplanation.textContent = "Most recent completed actions.";
    queuePanel.appendChild(activityExplanation);
    this.activityList.className =
      "neuroglancer-skeleton-queue-list neuroglancer-skeleton-queue-activity-list";
    queuePanel.appendChild(this.activityList);
    element.appendChild(queuePanel);

    this.registerDisposer(
      layer.spatialSkeletonState.optimisticEditQueueVersion.changed.add(() => {
        this.updateQueuePanel();
      }),
    );
    this.updateQueuePanel();
  }

  private updateFatalBanner() {
    const fatalState =
      this.layer.spatialSkeletonState.getOptimisticEditFatalState();
    if (fatalState === undefined) {
      this.fatalBanner?.remove();
      this.fatalBanner = undefined;
      return false;
    }
    if (this.fatalBanner !== undefined) return true;

    const banner = document.createElement("div");
    banner.className = "neuroglancer-skeleton-queue-reload-required";
    banner.setAttribute("role", "alert");
    const title = document.createElement("div");
    title.className = "neuroglancer-skeleton-queue-reload-required-title";
    title.textContent = "Reload required";
    const reason = document.createElement("div");
    reason.textContent = SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON;
    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.textContent = "Reload page";
    reloadButton.addEventListener("click", () => window.location.reload());
    banner.appendChild(title);
    banner.appendChild(reason);
    banner.appendChild(reloadButton);
    this.queuePanel.insertBefore(banner, this.explanation);
    this.fatalBanner = banner;
    return true;
  }

  private makeQueueRow(entry: SpatialSkeletonOptimisticEditQueueEntry) {
    const row = document.createElement("div");
    row.className = "neuroglancer-skeleton-queue-row";
    const primary = getPrimaryLifecyclePresentation(entry.lifecycle);
    row.dataset.primaryStatus = primary;
    const action = document.createElement("span");
    action.className = "neuroglancer-skeleton-queue-action";
    action.textContent = getOptimisticEditQueueEntryLabel(entry);
    const status = document.createElement("span");
    status.className = "neuroglancer-skeleton-queue-status";
    const presentation = lifecyclePresentation[primary];
    status.textContent = presentation.label;
    status.title = presentation.description;
    row.appendChild(action);
    row.appendChild(status);
    return row;
  }

  private makeActivityRow(entry: SpatialSkeletonOptimisticEditActivityEntry) {
    const row = document.createElement("div");
    row.className =
      "neuroglancer-skeleton-queue-row neuroglancer-skeleton-queue-activity-row";
    row.dataset.primaryStatus = entry.status;
    const actionContainer = document.createElement("div");
    actionContainer.className =
      "neuroglancer-skeleton-queue-activity-action-container";
    const action = document.createElement("span");
    action.className = "neuroglancer-skeleton-queue-action";
    action.textContent = getOptimisticEditQueueEntryLabel(entry);
    actionContainer.appendChild(action);
    const details = [
      entry.reason,
      entry.canceledLaterIntentCount === undefined
        ? undefined
        : `${entry.canceledLaterIntentCount} later queued ${entry.canceledLaterIntentCount === 1 ? "edit was" : "edits were"} also canceled.`,
    ].filter((value): value is string => value !== undefined && value !== "");
    if (details.length !== 0) {
      const reason = document.createElement("div");
      reason.className = "neuroglancer-skeleton-queue-activity-reason";
      reason.textContent = details.join(" ");
      reason.title = reason.textContent;
      actionContainer.appendChild(reason);
    }
    const status = document.createElement("span");
    status.className = "neuroglancer-skeleton-queue-status";
    const presentation = lifecyclePresentation[entry.status];
    status.textContent = presentation.label;
    status.title = presentation.description;
    row.appendChild(actionContainer);
    row.appendChild(status);
    return row;
  }

  updateQueuePanel() {
    const reloadRequired = this.updateFatalBanner();
    const entries = getOptimisticEditQueueEntries(this.layer);
    const pendingEntries = entries.filter(isPendingEntry);
    const pendingEntryCount = pendingEntries.length;
    this.queueSummary.textContent = reloadRequired
      ? "Reload required"
      : pendingEntryCount !== 0
        ? `${pendingEntryCount} ${pendingEntryCount === 1 ? "edit" : "edits"} pending`
        : "Up to date";
    if (pendingEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "neuroglancer-skeleton-queue-empty-state";
      empty.textContent = "There are no pending skeleton edits.";
      this.queueList.replaceChildren(empty);
    } else {
      this.queueList.replaceChildren(
        ...pendingEntries.map((entry) => this.makeQueueRow(entry)),
      );
    }
    const activity = getOptimisticEditQueueRecentActivity(this.layer);
    if (activity.length === 0) {
      const empty = document.createElement("div");
      empty.className = "neuroglancer-skeleton-queue-empty-state";
      empty.textContent = "There are no completed skeleton edits yet.";
      this.activityList.replaceChildren(empty);
    } else {
      this.activityList.replaceChildren(
        ...activity.map((entry) => this.makeActivityRow(entry)),
      );
    }
  }
}

export function registerSpatialSkeletonOptimisticEditQueueTab(
  layer: SegmentationUserLayer,
  hidden: WatchableValueInterface<boolean>,
) {
  layer.tabs.add("skeletonQueue", {
    label: "Queue",
    order: -44,
    getter: () => new SpatialSkeletonOptimisticEditQueueTab(layer),
    hidden,
  });

  // The persistent notification is installed with the Queue UI rather than
  // by any datasource. It is emitted exactly once for this layer's first-wins
  // fatal latch and remains until the layer or page is disposed.
  let fatalNotification: StatusMessage | undefined;
  let fatalNotificationReported = false;
  let notificationsDisposed = false;
  const authorityNotifications =
    new SpatialSkeletonOptimisticAuthorityNotificationController(layer);
  const updateFatalNotification = () => {
    const fatalState = layer.spatialSkeletonState.getOptimisticEditFatalState();
    if (fatalNotificationReported || fatalState === undefined) return;
    fatalNotificationReported = true;
    if (notificationsDisposed) return;
    fatalNotification = StatusMessage.showErrorMessage(
      SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON,
      { label: "Reload page", callback: () => window.location.reload() },
    );
  };
  layer.registerDisposer(
    layer.spatialSkeletonState.optimisticEditQueueVersion.changed.add(() => {
      authorityNotifications.update();
      updateFatalNotification();
    }),
  );
  layer.registerDisposer(() => {
    notificationsDisposed = true;
    authorityNotifications.dispose();
    const notification = fatalNotification;
    fatalNotification = undefined;
    notification?.dispose();
  });
  updateFatalNotification();
}
