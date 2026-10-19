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

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { SpatialSkeletonOptimisticIntentLifecycle } from "#src/skeleton/optimistic_edit/lifecycle.js";
import type {
  SpatialSkeletonOptimisticEditActivityEntry,
  SpatialSkeletonOptimisticEditQueueEntry,
} from "#src/skeleton/optimistic_edit/types.js";
import { StatusMessage } from "#src/status.js";
import {
  registerSpatialSkeletonOptimisticEditQueueTab,
  SpatialSkeletonOptimisticAuthorityNotificationController,
  SpatialSkeletonOptimisticEditQueueTab,
} from "#src/ui/skeleton_optimistic_edit_queue_tab.js";

function makeSignal() {
  const listeners = new Set<() => void>();
  return {
    changed: {
      add(listener: () => void) {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
    },
    dispatch() {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function makeQueueTabLayer(
  getEntries: () => readonly SpatialSkeletonOptimisticEditQueueEntry[],
  getActivity: () => readonly SpatialSkeletonOptimisticEditActivityEntry[] = () => [],
  getFatalState: () => object | undefined = () => undefined,
) {
  const optimisticEditQueueVersion = makeSignal();
  const layer = {
    spatialSkeletonState: {
      optimisticEditQueueVersion,
      getOptimisticEditQueueSnapshot: getEntries,
      getOptimisticEditQueueRecentActivity: getActivity,
      getOptimisticEditFatalState: getFatalState,
    },
    tabs: {
      add: vi.fn(),
    },
    registerDisposer: vi.fn((disposer: unknown) => disposer),
  } as unknown as SegmentationUserLayer;
  return {
    layer,
    optimisticEditQueueVersion,
  };
}

function lifecycle(
  overrides: Partial<SpatialSkeletonOptimisticIntentLifecycle> = {},
): SpatialSkeletonOptimisticIntentLifecycle {
  return {
    preview: "exact",
    authority: "queued",
    reconciliation: "waiting",
    history: "staged",
    ...overrides,
  };
}

describe("SpatialSkeletonOptimisticEditQueueTab", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("always registers the user-facing Queue tab", () => {
    const { layer } = makeQueueTabLayer(() => []);
    const hidden = { value: false, changed: makeSignal().changed };

    registerSpatialSkeletonOptimisticEditQueueTab(layer, hidden as any);

    expect(layer.tabs.add).toHaveBeenCalledWith(
      "skeletonQueue",
      expect.objectContaining({
        label: "Queue",
        order: -44,
        hidden,
      }),
    );
  });

  it("renders an empty queue state", () => {
    const { layer } = makeQueueTabLayer(() => []);

    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    expect(tab.element.textContent).toContain("Skeleton edit queue");
    expect(tab.element.textContent).toContain("Up to date");
    expect(tab.element.textContent).toContain(
      "There are no pending skeleton edits.",
    );
    expect(tab.element.querySelector("button")).toBeNull();
    tab.dispose();
  });

  it("renders a persistent Reload required alert even with no queue rows", () => {
    const { layer } = makeQueueTabLayer(
      () => [],
      () => [],
      () => ({
        reason: "authority-indeterminate",
        authority: "indeterminate",
      }),
    );

    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    const alert = tab.element.querySelector<HTMLElement>('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Reload required");
    expect(alert!.textContent).toContain(
      "Reload the page before making more skeleton edits.",
    );
    expect(alert!.querySelector("button")?.textContent).toBe("Reload page");
    expect(tab.element.textContent).toContain(
      "There are no pending skeleton edits.",
    );
    expect(
      tab.element.querySelector(".neuroglancer-skeleton-queue-summary")
        ?.textContent,
    ).toBe("Reload required");
    tab.dispose();
  });

  it("owns one persistent Reload required notification", () => {
    const fatalState: { value: object | undefined } = { value: undefined };
    const { layer, optimisticEditQueueVersion } = makeQueueTabLayer(
      () => [],
      () => [],
      () => fatalState.value,
    );
    const dispose = vi.fn();
    const showErrorMessage = vi
      .spyOn(StatusMessage, "showErrorMessage")
      .mockReturnValue({ dispose } as unknown as StatusMessage);
    const hidden = { value: false, changed: makeSignal().changed };

    registerSpatialSkeletonOptimisticEditQueueTab(layer, hidden as any);
    expect(showErrorMessage).not.toHaveBeenCalled();

    fatalState.value = {
      reason: "committed-local-publication-failed",
      authority: "committed",
    };
    optimisticEditQueueVersion.dispatch();
    optimisticEditQueueVersion.dispatch();

    expect(showErrorMessage).toHaveBeenCalledOnce();
    expect(showErrorMessage).toHaveBeenCalledWith(
      "Reload the page before making more skeleton edits.",
      expect.objectContaining({ label: "Reload page" }),
    );
  });

  it("warns after the configured in-flight delay and clears the warning on settlement", () => {
    vi.useFakeTimers();
    let entries: readonly SpatialSkeletonOptimisticEditQueueEntry[] = [
      {
        queueInstanceId: 1,
        operationId: 7,
        kind: "addNode",
        lifecycle: lifecycle({ authority: "running" }),
        authorityPresentation: {
          authorityLabel: "CATMAID",
          operationNoun: "node creation",
          stalledWarning: {
            delayMs: 30_000,
            message:
              "CATMAID has not confirmed the optimistic skeleton edit yet.",
          },
        },
      },
    ];
    const { layer } = makeQueueTabLayer(() => entries);
    const dispose = vi.fn();
    const showErrorMessage = vi
      .spyOn(StatusMessage, "showErrorMessage")
      .mockReturnValue({ dispose } as unknown as StatusMessage);
    const controller =
      new SpatialSkeletonOptimisticAuthorityNotificationController(layer);

    vi.advanceTimersByTime(10_000);
    entries = [{ ...entries[0]!, queueInstanceId: 2 }];
    controller.update();
    // The replaced engine's old timer must not fire for a reused operation id.
    vi.advanceTimersByTime(20_000);
    expect(showErrorMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(showErrorMessage).toHaveBeenCalledOnce();
    expect(showErrorMessage).toHaveBeenCalledWith(
      "CATMAID has not confirmed the optimistic skeleton edit yet.",
    );

    entries = [
      {
        ...entries[0]!,
        lifecycle: lifecycle({
          preview: "promoted",
          authority: "committed",
          reconciliation: "complete",
          history: "advanced",
        }),
      },
    ];
    controller.update();
    expect(dispose).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("shows lease-waiting work as queued without starting the transport warning", () => {
    vi.useFakeTimers();
    const entries: readonly SpatialSkeletonOptimisticEditQueueEntry[] = [
      {
        operationId: 8,
        kind: "moveNode",
        lifecycle: lifecycle({ authority: "waiting" }),
        authorityPresentation: {
          authorityLabel: "CATMAID",
          operationNoun: "node movement",
          stalledWarning: {
            delayMs: 30_000,
            message: "CATMAID has not confirmed the move yet.",
          },
        },
      },
    ];
    const { layer } = makeQueueTabLayer(() => entries);
    const showErrorMessage = vi
      .spyOn(StatusMessage, "showErrorMessage")
      .mockReturnValue({ dispose: vi.fn() } as unknown as StatusMessage);
    const controller =
      new SpatialSkeletonOptimisticAuthorityNotificationController(layer);
    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    vi.advanceTimersByTime(60_000);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(tab.element.textContent).toContain("Queued");
    expect(tab.element.textContent).not.toContain("Saving");
    tab.dispose();
    controller.dispose();
  });

  it("reports unbounded root failures once across reused operation ids", () => {
    let entries: readonly SpatialSkeletonOptimisticEditQueueEntry[] = [];
    const { layer } = makeQueueTabLayer(
      () => entries,
      () => [],
    );
    const showErrorMessage = vi
      .spyOn(StatusMessage, "showErrorMessage")
      .mockReturnValue({ dispose: vi.fn() } as unknown as StatusMessage);
    const controller =
      new SpatialSkeletonOptimisticAuthorityNotificationController(layer);
    const presentation = {
      authorityLabel: "CATMAID",
      operationNoun: "node movement",
    } as const;

    entries = [
      {
        queueInstanceId: 1,
        operationId: 11,
        kind: "moveNode",
        lifecycle: lifecycle({
          preview: "rolled-back",
          authority: "unchanged",
          authorityReason: "rejected",
          reconciliation: "not-required",
          history: "rejected",
        }),
        authorityPresentation: presentation,
        reason: "Request failed with HTTP 409 (Conflict).",
        canceledLaterIntentCount: 11,
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        queueInstanceId: 1,
        operationId: 12 + index,
        kind: "deleteNode",
        lifecycle: lifecycle({
          preview: "rolled-back" as const,
          authority: "unchanged" as const,
          authorityReason: "rejected" as const,
          reconciliation: "not-required" as const,
          history: "rejected" as const,
        }),
        authorityPresentation: presentation,
        reason: "Reverted because an earlier edit was not saved.",
      })),
    ];
    controller.update();
    controller.update();
    expect(showErrorMessage).toHaveBeenCalledOnce();
    expect(showErrorMessage).toHaveBeenLastCalledWith(
      "CATMAID rejected node movement. The optimistic preview was removed. Request failed with HTTP 409 (Conflict). 11 later queued edits were also canceled.",
    );

    // A replacement engine may reuse operation 11; its instance id keeps the
    // notification identity distinct without needing an observed empty frame.
    entries = [
      {
        queueInstanceId: 2,
        operationId: 11,
        kind: "moveNode",
        lifecycle: lifecycle({
          preview: "rolled-back",
          authority: "unchanged",
          authorityReason: "not-started",
          reconciliation: "not-required",
          history: "rejected",
        }),
        authorityPresentation: presentation,
        reason:
          "The edit could not be submitted: The request could not be built.",
        canceledLaterIntentCount: 0,
      },
    ];
    controller.update();
    expect(showErrorMessage).toHaveBeenCalledTimes(2);
    expect(showErrorMessage).toHaveBeenLastCalledWith(
      "Unable to submit node movement; no CATMAID mutation request was started. The invalid preview was removed. The request could not be built.",
    );
    controller.dispose();
  });

  it("shows the reload-required message once", async () => {
    const fatalState: { value: object | undefined } = { value: undefined };
    const { layer, optimisticEditQueueVersion } = makeQueueTabLayer(
      () => [],
      () => [],
      () => fatalState.value,
    );
    const showErrorMessage = vi
      .spyOn(StatusMessage, "showErrorMessage")
      .mockReturnValue({ dispose: vi.fn() } as unknown as StatusMessage);
    registerSpatialSkeletonOptimisticEditQueueTab(layer, {
      value: false,
      changed: makeSignal().changed,
    } as any);
    fatalState.value = {
      reason: "committed-local-publication-failed",
      authority: "committed",
    };
    optimisticEditQueueVersion.dispatch();
    await Promise.resolve();
    await Promise.resolve();
    optimisticEditQueueVersion.dispatch();
    expect(showErrorMessage).toHaveBeenCalledOnce();
    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Reload the page"),
      expect.anything(),
    );
  });

  it("renders queue rows and updates on queue version changes", () => {
    let entries: readonly SpatialSkeletonOptimisticEditQueueEntry[] = [
      {
        kind: "addNode",
        lifecycle: lifecycle(),
      },
      {
        kind: "deleteNode",
        lifecycle: lifecycle({
          preview: "promoted",
          authority: "committed",
          reconciliation: "complete",
          history: "advanced",
        }),
      },
    ];
    const { layer, optimisticEditQueueVersion } = makeQueueTabLayer(
      () => entries,
    );
    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    expect(tab.element.textContent).toContain("1 edit pending");
    expect(tab.element.textContent).toContain("Add node");
    expect(tab.element.textContent).toContain("Queued");
    entries = [
      {
        kind: "moveNode",
        lifecycle: lifecycle({ authority: "running" }),
      },
    ];
    optimisticEditQueueVersion.dispatch();

    expect(tab.element.textContent).toContain("1 edit pending");
    expect(tab.element.textContent).toContain("Move node");
    expect(tab.element.textContent).toContain("Saving");
    expect(tab.element.textContent).not.toContain("Add node");
    tab.dispose();
  });

  it("retains a failed action and its rollback context in recent activity", () => {
    const { layer } = makeQueueTabLayer(
      () => [],
      () => [
        {
          kind: "splitSkeleton",
          status: "not-saved",
          commandLabel: "Split skeleton",
          reason: "The selected node is no longer part of this skeleton.",
          canceledLaterIntentCount: 2,
        },
      ],
    );

    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    expect(tab.element.textContent).toContain("Recent activity");
    expect(tab.element.textContent).toContain("Most recent completed actions.");
    expect(tab.element.textContent).toContain("Split skeleton");
    expect(tab.element.textContent).toContain("Not saved");
    expect(tab.element.textContent).toContain(
      "The selected node is no longer part of this skeleton.",
    );
    expect(tab.element.textContent).toContain(
      "2 later queued edits were also canceled.",
    );
    expect(tab.element.textContent).toContain("Up to date");
    tab.dispose();
  });

  it("shows an admitted edit while its exact preview is preparing", () => {
    const { layer } = makeQueueTabLayer(() => [
      {
        kind: "mergeSkeletons",
        lifecycle: lifecycle({ preview: "preparing" }),
        commandLabel: "Merge skeletons",
      },
    ]);

    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    expect(tab.element.textContent).toContain("1 edit pending");
    expect(tab.element.textContent).toContain("Merge skeletons");
    expect(tab.element.textContent).toContain("Preparing");
    tab.dispose();
  });

  it("renders Undo intent without internal operation details", () => {
    const entries: readonly SpatialSkeletonOptimisticEditQueueEntry[] = [
      {
        kind: "deleteNode",
        lifecycle: lifecycle(),
        intent: "undo",
        commandLabel: "Add node",
      },
      {
        kind: "restoreNode",
        lifecycle: lifecycle({ authority: "running" }),
        intent: "undo",
        commandLabel: "Delete node",
      },
    ];
    const { layer } = makeQueueTabLayer(() => entries);
    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    const actions = Array.from(
      tab.element.querySelectorAll<HTMLElement>(
        ".neuroglancer-skeleton-queue-action",
      ),
      (element) => element.textContent,
    );
    expect(actions).toEqual(["Undo add node", "Undo delete node"]);
    const statuses = Array.from(
      tab.element.querySelectorAll<HTMLElement>(
        ".neuroglancer-skeleton-queue-status",
      ),
      (element) => element.textContent,
    );
    expect(statuses).toEqual(["Queued", "Saving"]);
    tab.dispose();
  });

  it("renders datasource-neutral scheduler states", () => {
    const { layer } = makeQueueTabLayer(
      () => [
        {
          kind: "providerMutation",
          lifecycle: lifecycle({ authority: "running" }),
          commandLabel: "Update branch",
        },
        {
          kind: "providerMutation",
          lifecycle: lifecycle({
            authority: "indeterminate",
            reconciliation: "blocked",
          }),
          commandLabel: "Merge branches",
        },
      ],
      () => [
        {
          kind: "providerMutation",
          status: "not-saved",
          commandLabel: "Delete branch",
        },
      ],
    );

    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);
    expect(tab.element.textContent).toContain("2 edits pending");
    const statuses = Array.from(
      tab.element.querySelectorAll<HTMLElement>(
        ".neuroglancer-skeleton-queue-status",
      ),
    );
    expect(statuses.map((status) => status.textContent)).toEqual([
      "Saving",
      "Reload required",
      "Not saved",
    ]);
    expect(statuses[0]!.title).toBe("Being saved to the skeleton source");
    expect(statuses[1]!.title).toBe(
      "Reload the page before making more skeleton edits.",
    );
    expect(statuses[2]!.title).toBe("This edit was not saved");
    tab.dispose();
  });

  it("derives pending labels from lifecycle axes in precedence order", () => {
    const entries: readonly SpatialSkeletonOptimisticEditQueueEntry[] = [
      {
        kind: "unknown",
        lifecycle: lifecycle({
          preview: "preparing",
          authority: "indeterminate",
          reconciliation: "blocked",
        }),
      },
      {
        kind: "blocked",
        lifecycle: lifecycle({
          reconciliation: "blocked",
        }),
      },
      {
        kind: "preview",
        lifecycle: lifecycle({
          preview: "preparing",
          authority: "running",
        }),
      },
      {
        kind: "save",
        lifecycle: lifecycle({ authority: "running" }),
      },
      {
        kind: "reconcile",
        lifecycle: lifecycle({
          authority: "committed",
          reconciliation: "applying",
        }),
      },
      {
        kind: "queued",
        lifecycle: lifecycle(),
      },
    ];
    const { layer } = makeQueueTabLayer(() => entries);
    const tab = new SpatialSkeletonOptimisticEditQueueTab(layer);

    const rows = Array.from(
      tab.element.querySelectorAll<HTMLElement>(
        ".neuroglancer-skeleton-queue-row",
      ),
    );
    expect(
      rows.map(
        (row) =>
          row.querySelector<HTMLElement>(".neuroglancer-skeleton-queue-status")!
            .textContent,
      ),
    ).toEqual([
      "Reload required",
      "Reload required",
      "Preparing",
      "Saving",
      "Reconciling",
      "Queued",
    ]);
    expect(rows.map((row) => row.dataset.primaryStatus)).toEqual([
      "reload-required",
      "reload-required",
      "preparing",
      "saving",
      "reconciling",
      "queued",
    ]);
    tab.dispose();
  });
});
