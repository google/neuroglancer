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

import { describe, expect, it, vi } from "vitest";

import type {
  SpatialSkeletonEditCommand,
  SpatialSkeletonQueueInputRequirement,
} from "#src/skeleton/command_protocol.js";
import { SpatialSkeletonActions } from "#src/skeleton/command_protocol.js";
import { SpatialSkeletonInspectionRequiredError } from "#src/skeleton/edit_errors.js";
import {
  SpatialSkeletonOptimisticReloadRequiredError,
  type SpatialSkeletonOptimisticFatalState,
} from "#src/skeleton/optimistic_edit/fatal.js";
import type { SpatialSkeletonOptimisticEditSettlement } from "#src/skeleton/optimistic_edit/lifecycle.js";
import type { SpatialSkeletonOptimisticEditExecution } from "#src/skeleton/optimistic_edit/types.js";
import {
  createSpatialSkeletonQueueInputPreparation,
  prepareAndSubmitSpatialSkeletonEdit,
} from "#src/skeleton/queue_admission.js";
import { createDeferred } from "#src/util/promise.js";

function optimisticExecution<T>(
  execution: Promise<T>,
  settled: Promise<SpatialSkeletonOptimisticEditSettlement> = Promise.resolve({
    outcome: "committed",
  }),
): SpatialSkeletonOptimisticEditExecution<T> {
  Object.defineProperties(execution, {
    acceptedByQueue: { configurable: true, value: Promise.resolve() },
    settled: { configurable: true, value: settled },
  });
  return execution as SpatialSkeletonOptimisticEditExecution<T>;
}

function makeHarness(initialSegments: readonly number[] = []) {
  const cachedSegments = new Set(initialSegments);
  const revisions = new Map(initialSegments.map((segmentId) => [segmentId, 1]));
  const snapshotHandles = new Map(
    initialSegments.map((segmentId) => [segmentId, { segmentId }]),
  );
  const releases: number[] = [];
  const getFullSegmentNodes = vi.fn(async (_layer, segmentId: number) => {
    cachedSegments.add(segmentId);
    return [];
  });
  let fatalState: SpatialSkeletonOptimisticFatalState | undefined;
  const state = {
    getOptimisticEditingIdentityService: () => ({}),
    tryAcquireInputReference(
      requirement: SpatialSkeletonQueueInputRequirement,
    ) {
      if (!cachedSegments.has(requirement.segmentId)) return undefined;
      const revision = revisions.get(requirement.segmentId) ?? 0;
      let handle = snapshotHandles.get(requirement.segmentId);
      if (handle === undefined) {
        handle = { segmentId: requirement.segmentId };
        snapshotHandles.set(requirement.segmentId, handle);
      }
      let released = false;
      return {
        segmentId: requirement.segmentId,
        snapshot: { handle, cacheRevision: revision },
        isCurrent: () =>
          !released &&
          cachedSegments.has(requirement.segmentId) &&
          (revisions.get(requirement.segmentId) ?? 0) === revision,
        release: () => {
          if (released) return;
          released = true;
          releases.push(requirement.segmentId);
        },
      };
    },
    acquireInputReference(requirement: SpatialSkeletonQueueInputRequirement) {
      const inputReference = this.tryAcquireInputReference(requirement);
      if (inputReference !== undefined) return inputReference;
      throw new SpatialSkeletonInspectionRequiredError(requirement);
    },
    getFullSegmentNodes,
    getCachedNode: vi.fn(),
    releaseFullSegmentNodeFetchOwner: vi.fn(),
    assertOptimisticEditingAllowed() {
      if (fatalState !== undefined) {
        throw new SpatialSkeletonOptimisticReloadRequiredError(fatalState);
      }
    },
  };
  const layer = {
    spatialSkeletonState: state,
    getSpatiallyIndexedSkeletonLayer: () => ({}),
  };
  const replaceCachedSegment = (segmentId: number) => {
    cachedSegments.add(segmentId);
    revisions.set(segmentId, (revisions.get(segmentId) ?? 0) + 1);
    snapshotHandles.set(segmentId, { segmentId });
  };
  return {
    cachedSegments,
    layer: layer as any,
    releases,
    replaceCachedSegment,
    setFatalState(value: SpatialSkeletonOptimisticFatalState) {
      fatalState = value;
    },
    state,
  };
}

function makeCommand(
  required: readonly SpatialSkeletonQueueInputRequirement[],
  loadable: readonly SpatialSkeletonQueueInputRequirement[] = [],
): SpatialSkeletonEditCommand {
  return {
    action: SpatialSkeletonActions.moveNodes,
    label: "Test edit",
    payload: Object.freeze({}),
    getQueueInputRequirements: () => ({ required, loadable }),
  };
}

describe("spatial skeleton queue input preparation", () => {
  it("submits the input policy immediately, without starting a target read", async () => {
    const { layer, state } = makeHarness([11]);
    const submitted = optimisticExecution(Promise.resolve());
    const submit = vi.fn(() => submitted);
    const execution = prepareAndSubmitSpatialSkeletonEdit(
      layer,
      makeCommand([{ segmentId: 11 }], [{ segmentId: 21 }]),
      submit,
    );
    expect(execution).toBe(submitted);
    expect(submit).toHaveBeenCalledOnce();
    expect(state.getFullSegmentNodes).not.toHaveBeenCalled();
    expect(submit.mock.calls[0]).toHaveLength(1);
  });

  it("keeps input bundles frozen, deduplicated, and pinned until released", async () => {
    const { layer, releases } = makeHarness([11, 21]);
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand(
        [{ segmentId: 11 }, { segmentId: 11, nodeId: 12 }],
        [{ segmentId: 21 }],
      ),
    );
    const releaseAdmission = policy.validate("execute");
    const prepared = await policy.acquire(
      new AbortController().signal,
      "execute",
    );
    expect(prepared.input.segments.map(({ segmentId }) => segmentId)).toEqual([
      11, 21,
    ]);
    expect(Object.isFrozen(prepared.input)).toBe(true);
    expect(Object.isFrozen(prepared.input.segments)).toBe(true);
    expect(prepared.input.segments.every(Object.isFrozen)).toBe(true);
    expect(releases).toEqual([]);
    prepared.assertCurrent();
    prepared.release();
    prepared.release();
    releaseAdmission();
    releaseAdmission();
    expect(releases).toEqual([11, 11, 21, 11, 11]);
  });

  it("rejects missing required inspection without fetching", () => {
    const { layer, state } = makeHarness();
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand([{ segmentId: 11 }], [{ segmentId: 21 }]),
    );
    expect(() => policy.validate("execute")).toThrow(
      SpatialSkeletonInspectionRequiredError,
    );
    expect(state.getFullSegmentNodes).not.toHaveBeenCalled();
  });

  it("accepts root-like inputs without a source or download", async () => {
    const { layer, state } = makeHarness();
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand([]),
    );
    const release = policy.validate("execute");
    const prepared = await policy.acquire(
      new AbortController().signal,
      "execute",
    );
    expect(prepared.input).toEqual({ segments: [] });
    expect(state.getFullSegmentNodes).not.toHaveBeenCalled();
    prepared.release();
    release();
  });

  it("acquires the current source version when its ordered turn arrives", async () => {
    const { layer, replaceCachedSegment, releases } = makeHarness([11]);
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand([{ segmentId: 11 }]),
    );
    const release = policy.validate("execute");
    replaceCachedSegment(11);
    const prepared = await policy.acquire(
      new AbortController().signal,
      "execute",
    );
    expect(prepared.input.segments[0].cacheRevision).toBe(2);
    prepared.assertCurrent();
    prepared.release();
    release();
    expect(releases).toEqual([11, 11]);
  });

  it("uses current node ownership after an earlier queued merge", async () => {
    const { layer, state } = makeHarness([11, 21]);
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand([{ segmentId: 11, nodeId: 12 }]),
    );
    const release = policy.validate("execute");
    expect(policy.getProtectedSegmentIds()).toEqual([11]);
    state.getCachedNode.mockReturnValue({ nodeId: 12, segmentId: 21 } as any);
    expect(policy.getProtectedSegmentIds()).toEqual([21]);
    const prepared = await policy.acquire(
      new AbortController().signal,
      "execute",
    );
    expect(prepared.input.segments[0].segmentId).toBe(21);
    prepared.release();
    release();
  });

  it("rejects an unexpected source replacement during a target download", async () => {
    const { layer, state, cachedSegments, replaceCachedSegment, releases } =
      makeHarness([11]);
    const read = createDeferred<void>();
    state.getFullSegmentNodes.mockImplementationOnce(async (_layer, id) => {
      await read.promise;
      cachedSegments.add(id);
      return [];
    });
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand([{ segmentId: 11 }], [{ segmentId: 21 }]),
    );
    const acquiring = policy.acquire(new AbortController().signal, "execute");
    replaceCachedSegment(11);
    read.resolve();
    await expect(acquiring).rejects.toMatchObject({
      reason: "snapshot-changed",
    });
    expect(releases).toEqual([11]);
  });

  it("rechecks endpoint requirements after a download", async () => {
    const { layer, state, cachedSegments } = makeHarness([11]);
    const read = createDeferred<void>();
    state.getFullSegmentNodes.mockImplementationOnce(async (_layer, id) => {
      await read.promise;
      cachedSegments.add(id);
      return [];
    });
    let target = 21;
    const command = {
      ...makeCommand([]),
      getQueueInputRequirements: () => ({
        required: [{ segmentId: 11 }],
        loadable: [{ segmentId: target }],
      }),
    };
    const acquiring = createSpatialSkeletonQueueInputPreparation(
      layer,
      command,
    ).acquire(new AbortController().signal, "execute");
    target = 31;
    read.resolve();
    await expect(acquiring).rejects.toMatchObject({
      reason: "requirements-changed",
    });
  });

  it("releases a canceled read owner promptly and ignores a late response", async () => {
    const { layer, state, cachedSegments, releases } = makeHarness([11]);
    const read = createDeferred<void>();
    state.getFullSegmentNodes.mockImplementationOnce(async (_layer, id) => {
      await read.promise;
      cachedSegments.add(id);
      return [];
    });
    const controller = new AbortController();
    const acquiring = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand([{ segmentId: 11 }], [{ segmentId: 21 }]),
    ).acquire(controller.signal, "execute");
    const reason = new DOMException("Canceled", "AbortError");
    controller.abort(reason);
    await expect(acquiring).rejects.toBe(reason);
    expect(state.releaseFullSegmentNodeFetchOwner).toHaveBeenCalled();
    expect(releases).toEqual([11]);
    read.resolve();
    await Promise.resolve();
    expect(releases).toEqual([11]);
  });

  it("supports loadable inputs for any action and preserves their order", async () => {
    const { layer, state } = makeHarness([11]);
    const command = {
      ...makeCommand(
        [{ segmentId: 11 }],
        [{ segmentId: 31 }, { segmentId: 21 }],
      ),
      action: SpatialSkeletonActions.editNodeRadius,
    };
    const prepared = await createSpatialSkeletonQueueInputPreparation(
      layer,
      command,
    ).acquire(new AbortController().signal, "execute");
    expect(state.getFullSegmentNodes.mock.calls.map((call) => call[1])).toEqual(
      [31, 21],
    );
    expect(prepared.input.segments.map(({ segmentId }) => segmentId)).toEqual([
      11, 31, 21,
    ]);
    prepared.release();
  });

  it("releases all pinned inputs on a failed download", async () => {
    const { layer, state, releases } = makeHarness([11]);
    const error = new Error("Unavailable");
    state.getFullSegmentNodes.mockRejectedValueOnce(error);
    await expect(
      createSpatialSkeletonQueueInputPreparation(
        layer,
        makeCommand([{ segmentId: 11 }], [{ segmentId: 21 }]),
      ).acquire(new AbortController().signal, "execute"),
    ).rejects.toBe(error);
    expect(releases).toEqual([11]);
  });

  it("checks the fatal gate before validation and after loading", async () => {
    const { layer, state, cachedSegments, setFatalState } = makeHarness([11]);
    const read = createDeferred<void>();
    state.getFullSegmentNodes.mockImplementationOnce(async (_layer, id) => {
      await read.promise;
      cachedSegments.add(id);
      return [];
    });
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand([{ segmentId: 11 }], [{ segmentId: 21 }]),
    );
    const acquiring = policy.acquire(new AbortController().signal, "execute");
    setFatalState({
      reason: "authority-indeterminate",
      authority: "indeterminate",
      intentId: 1,
    } as any);
    read.resolve();
    await expect(acquiring).rejects.toBeInstanceOf(
      SpatialSkeletonOptimisticReloadRequiredError,
    );
    expect(() => policy.validate("execute")).toThrow(
      SpatialSkeletonOptimisticReloadRequiredError,
    );
  });
  it("reacquires an evicted source for Redo of an accepted unprepared intent", async () => {
    const { layer, state, cachedSegments } = makeHarness([11]);
    const policy = createSpatialSkeletonQueueInputPreparation(
      layer,
      makeCommand([{ segmentId: 11 }], [{ segmentId: 21 }]),
    );
    policy.validate("execute")();
    cachedSegments.delete(11);
    const release = policy.validate("redo");
    const prepared = await policy.acquire(new AbortController().signal, "redo");
    expect(state.getFullSegmentNodes.mock.calls.map((call) => call[1])).toEqual(
      [11, 21],
    );
    expect(prepared.input.segments.map(({ segmentId }) => segmentId)).toEqual([
      11, 21,
    ]);
    prepared.release();
    release();
  });
});
