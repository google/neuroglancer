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
import { OPTIMISTIC_EDIT_QUEUE_DEBUG } from "#src/skeleton/optimistic_edit_queue_config.js";
import type { SpatialSkeletonOptimisticEditDebugEntry } from "#src/skeleton/spatial_skeleton_manager.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { Tab } from "#src/widget/tab_view.js";

export { OPTIMISTIC_EDIT_QUEUE_DEBUG } from "#src/skeleton/optimistic_edit_queue_config.js";

function getOptimisticEditQueueEntries(layer: SegmentationUserLayer) {
  return layer.spatialSkeletonState.getOptimisticEditQueueDebugSnapshot();
}

function getSettledEntryCount(
  entries: readonly SpatialSkeletonOptimisticEditDebugEntry[],
) {
  return entries.filter(
    (entry) =>
      entry.status === "committed" ||
      entry.status === "failed" ||
      entry.status === "rolledBack",
  ).length;
}

export class SpatialSkeletonOptimisticEditQueueTab extends Tab {
  private readonly queueDebugSummary = document.createElement("div");
  private readonly queueDebugClearSettledButton =
    document.createElement("button");
  private readonly queueDebugFlow = document.createElement("div");
  private readonly queueDebugList = document.createElement("div");

  constructor(public layer: SegmentationUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-skeleton-queue-tab");

    const queueDebugPanel = document.createElement("section");
    queueDebugPanel.className = "neuroglancer-skeleton-queue-debug";
    const queueDebugHeader = document.createElement("div");
    queueDebugHeader.className = "neuroglancer-skeleton-queue-debug-header";
    const queueDebugTitle = document.createElement("div");
    queueDebugTitle.className = "neuroglancer-skeleton-queue-debug-title";
    queueDebugTitle.textContent = "Optimistic edit queue";
    this.queueDebugSummary.className =
      "neuroglancer-skeleton-queue-debug-summary";
    this.queueDebugClearSettledButton.className =
      "neuroglancer-skeleton-queue-debug-clear";
    this.queueDebugClearSettledButton.type = "button";
    this.queueDebugClearSettledButton.textContent = "Clear settled";
    this.queueDebugClearSettledButton.title =
      "Remove committed, failed, and rolled-back optimistic queue entries.";
    this.queueDebugClearSettledButton.addEventListener("click", () => {
      layer.spatialSkeletonState.clearSettledOptimisticEdits();
      this.updateQueueDebugPanel();
    });
    const queueDebugHeaderActions = document.createElement("div");
    queueDebugHeaderActions.className =
      "neuroglancer-skeleton-queue-debug-header-actions";
    queueDebugHeaderActions.appendChild(this.queueDebugSummary);
    queueDebugHeaderActions.appendChild(this.queueDebugClearSettledButton);
    queueDebugHeader.appendChild(queueDebugTitle);
    queueDebugHeader.appendChild(queueDebugHeaderActions);
    queueDebugPanel.appendChild(queueDebugHeader);
    this.queueDebugFlow.className = "neuroglancer-skeleton-queue-debug-flow";
    queueDebugPanel.appendChild(this.queueDebugFlow);
    this.queueDebugList.className = "neuroglancer-skeleton-queue-debug-list";
    queueDebugPanel.appendChild(this.queueDebugList);
    element.appendChild(queueDebugPanel);

    this.registerDisposer(
      layer.spatialSkeletonState.optimisticEditQueueVersion.changed.add(() => {
        this.updateQueueDebugPanel();
      }),
    );
    this.updateQueueDebugPanel();
  }

  private makeFlowLane(
    entries: readonly SpatialSkeletonOptimisticEditDebugEntry[],
    label: string,
    statuses: readonly string[],
    emptyLabel: string,
  ) {
    const lane = document.createElement("div");
    lane.className = "neuroglancer-skeleton-queue-debug-lane";
    const laneLabel = document.createElement("div");
    laneLabel.className = "neuroglancer-skeleton-queue-debug-lane-label";
    laneLabel.textContent = label;
    const laneItems = document.createElement("div");
    laneItems.className = "neuroglancer-skeleton-queue-debug-lane-items";
    const laneEntries = entries.filter((entry) =>
      statuses.includes(entry.status),
    );
    if (laneEntries.length === 0) {
      const empty = document.createElement("span");
      empty.className = "neuroglancer-skeleton-queue-debug-empty";
      empty.textContent = emptyLabel;
      laneItems.appendChild(empty);
    } else {
      for (const entry of laneEntries) {
        const item = document.createElement("span");
        item.className = "neuroglancer-skeleton-queue-debug-chip";
        item.dataset.status = entry.status;
        item.textContent = `#${entry.operationId ?? "-"}`;
        item.title = `${entry.kind} ${entry.status}`;
        laneItems.appendChild(item);
      }
    }
    lane.appendChild(laneLabel);
    lane.appendChild(laneItems);
    return lane;
  }

  private makeQueueDebugRow(
    entry: SpatialSkeletonOptimisticEditDebugEntry,
    index: number,
  ) {
    const row = document.createElement("div");
    row.className = "neuroglancer-skeleton-queue-debug-row";
    row.dataset.status = entry.status;
    const tempNode =
      entry.tempNodeId === undefined ? "-" : entry.tempNodeId.toString();
    const segment =
      entry.segmentId === undefined ? "-" : entry.segmentId.toString();
    const parent =
      entry.parentNodeId === undefined
        ? (entry.parentTempNodeId?.toString() ?? "-")
        : entry.parentNodeId.toString();
    const server =
      entry.nodeId === undefined
        ? "-"
        : `${entry.nodeId}:${entry.segmentId ?? "-"}`;
    const dependencies = entry.dependencies?.length
      ? entry.dependencies.map((operationId) => `#${operationId}`).join(",")
      : "-";
    const topology =
      entry.tempSegmentId === undefined &&
      entry.secondSegmentId === undefined &&
      entry.resultSegmentId === undefined
        ? ""
        : `  tempSegment ${entry.tempSegmentId ?? "-"}  second ${entry.secondNodeId ?? "-"}:${entry.secondSegmentId ?? "-"}  result ${entry.resultSegmentId ?? "-"}  deleted ${entry.deletedSegmentId ?? "-"}`;
    const order = document.createElement("span");
    order.className = "neuroglancer-skeleton-queue-debug-order";
    order.textContent = `${index + 1}`;
    const status = document.createElement("span");
    status.className = "neuroglancer-skeleton-queue-debug-status";
    status.textContent = entry.status;
    const action = document.createElement("span");
    action.className = "neuroglancer-skeleton-queue-debug-action";
    action.textContent = `#${entry.operationId ?? "-"} ${entry.kind}`;
    const details = document.createElement("span");
    details.className = "neuroglancer-skeleton-queue-debug-details";
    details.textContent = `temp ${tempNode}  segment ${segment}  parent ${parent}  server ${server}  deps ${dependencies}${topology}`;
    row.appendChild(order);
    row.appendChild(status);
    row.appendChild(action);
    row.appendChild(details);
    return row;
  }

  updateQueueDebugPanel() {
    const entries = getOptimisticEditQueueEntries(this.layer);
    const statusCounts = new Map<string, number>();
    for (const entry of entries) {
      statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + 1);
    }
    this.queueDebugClearSettledButton.disabled =
      getSettledEntryCount(entries) === 0;
    this.queueDebugSummary.textContent =
      entries.length === 0
        ? "empty"
        : Array.from(statusCounts, ([status, count]) => `${status}: ${count}`)
            .sort()
            .join(" / ");
    this.queueDebugFlow.replaceChildren(
      this.makeFlowLane(entries, "pending", ["pending"], "none"),
      this.makeFlowLane(
        entries,
        "in flight",
        ["inFlight", "cancelRequested"],
        "idle",
      ),
      this.makeFlowLane(
        entries,
        "settled",
        ["committed", "failed", "rolledBack"],
        "none",
      ),
    );
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "neuroglancer-skeleton-queue-debug-empty-state";
      empty.textContent = "No queued optimistic edits.";
      this.queueDebugList.replaceChildren(empty);
      return;
    }
    this.queueDebugList.replaceChildren(
      ...entries.map((entry, index) => this.makeQueueDebugRow(entry, index)),
    );
  }
}

export function maybeRegisterSpatialSkeletonOptimisticEditQueueTab(
  layer: SegmentationUserLayer,
  hidden: WatchableValueInterface<boolean>,
  enabled = OPTIMISTIC_EDIT_QUEUE_DEBUG,
) {
  if (!enabled) {
    return false;
  }
  layer.tabs.add("skeletonQueue", {
    label: "Queue",
    order: -44,
    getter: () => new SpatialSkeletonOptimisticEditQueueTab(layer),
    hidden,
  });
  return true;
}
