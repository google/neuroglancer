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
  SpatialSkeletonEditRequestContext,
  SpatialSkeletonEditRequestFailureDisposition,
  SpatialSkeletonEditRequestAdapter,
} from "#src/skeleton/edit_queue/api.js";
import type { SpatialSkeletonEditRequestLease } from "#src/skeleton/edit_queue/request_scheduler.js";
import {
  SpatialSkeletonEditRequestLock,
  SpatialSkeletonRequestScheduler,
  SpatialSkeletonRequestSchedulerDisposedError,
} from "#src/skeleton/edit_queue/request_scheduler.js";

interface EditRequest {
  readonly name: string;
}

interface Result {
  readonly authority: string;
}

interface CommitCall {
  readonly editRequest: EditRequest;
  readonly context: SpatialSkeletonEditRequestContext;
  resolve(result: Result): void;
  reject(error: unknown): void;
}

interface ClassifiedError extends Error {
  disposition: SpatialSkeletonEditRequestFailureDisposition;
}

function classifiedError(
  disposition: SpatialSkeletonEditRequestFailureDisposition,
) {
  return Object.assign(new Error(disposition), {
    disposition,
  }) as ClassifiedError;
}

function makeAdapter(editRequestScope: object = {}) {
  const commits: CommitCall[] = [];
  const getEditRequestScope = vi.fn(() => editRequestScope);
  const adapter: SpatialSkeletonEditRequestAdapter<EditRequest, Result> = {
    get editRequestScope() {
      return getEditRequestScope();
    },
    commit: vi.fn(
      (editRequest: EditRequest, context: SpatialSkeletonEditRequestContext) =>
        new Promise<Result>((resolve, reject) => {
          commits.push({ editRequest, context, resolve, reject });
        }),
    ),
    classifyFailure: (error) =>
      (error as ClassifiedError).disposition ?? "indeterminate",
  };
  return { adapter, commits, getEditRequestScope };
}

function attemptRequest(editRequest: EditRequest) {
  return {
    materializeEditRequest: () => editRequest,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("SpatialSkeletonRequestScheduler", () => {
  it("dispatches under one active lease and leaves settlement to the engine", async () => {
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    const attempt = scheduler.schedule(
      "redo",
      attemptRequest({ name: "move" }),
    );
    await flush();

    expect(attempt.phase).toBe("committing");
    expect(attempt.cancelBeforeCommit("too late")).toBe(false);
    expect(commits[0]!.context).toEqual(
      expect.objectContaining({
        operationId: attempt.operationId,
        intent: "redo",
      }),
    );
    commits[0]!.resolve({ authority: "accepted" });

    const settlement = await attempt.settled;
    expect(settlement.outcome).toEqual({
      status: "committed",
      result: { authority: "accepted" },
    });
    expect(settlement.lease?.state).toBe("active");
    expect(attempt.phase).toBe("settled");
    settlement.lease?.release();
  });

  it("serializes all work in the same edit request scope across schedulers", async () => {
    const editRequestScope = {};
    const coordinator = new SpatialSkeletonEditRequestLock();
    const { adapter, commits } = makeAdapter(editRequestScope);
    const firstScheduler = new SpatialSkeletonRequestScheduler({
      adapter,
      coordinator,
    });
    const secondScheduler = new SpatialSkeletonRequestScheduler({
      adapter,
      coordinator,
    });
    const first = firstScheduler.schedule(
      "execute",
      attemptRequest({ name: "first" }),
    );
    const second = secondScheduler.schedule(
      "execute",
      attemptRequest({ name: "second" }),
    );
    await flush();

    expect(commits.map(({ editRequest }) => editRequest.name)).toEqual([
      "first",
    ]);
    commits[0]!.resolve({ authority: "first" });
    const firstSettlement = await first.settled;
    await flush();
    expect(commits).toHaveLength(1);

    firstSettlement.lease?.release();
    await flush();
    expect(commits.map(({ editRequest }) => editRequest.name)).toEqual([
      "first",
      "second",
    ]);
    commits[1]!.resolve({ authority: "second" });
    (await second.settled).lease?.release();
  });

  it("allows different edit request scopes to commit concurrently", async () => {
    const coordinator = new SpatialSkeletonEditRequestLock();
    const firstAdapter = makeAdapter();
    const secondAdapter = makeAdapter();
    const firstScheduler = new SpatialSkeletonRequestScheduler({
      adapter: firstAdapter.adapter,
      coordinator,
    });
    const secondScheduler = new SpatialSkeletonRequestScheduler({
      adapter: secondAdapter.adapter,
      coordinator,
    });

    const first = firstScheduler.schedule(
      "execute",
      attemptRequest({ name: "first" }),
    );
    const second = secondScheduler.schedule(
      "execute",
      attemptRequest({ name: "second" }),
    );
    await flush();
    expect(firstAdapter.commits).toHaveLength(1);
    expect(secondAdapter.commits).toHaveLength(1);

    firstAdapter.commits[0]!.resolve({ authority: "first" });
    secondAdapter.commits[0]!.resolve({ authority: "second" });
    (await first.settled).lease?.release();
    (await second.settled).lease?.release();
  });

  it("returns an active indeterminate fence for the engine to retain", async () => {
    const coordinator = new SpatialSkeletonEditRequestLock();
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({
      adapter,
      coordinator,
    });
    const unknown = scheduler.schedule(
      "execute",
      attemptRequest({ name: "unknown" }),
    );
    await flush();
    commits[0]!.reject(classifiedError("indeterminate"));
    const settlement = await unknown.settled;

    expect(settlement.lease?.state).toBe("active");
    expect(settlement.lease?.retain()).toBe(true);
    const blocked = scheduler.schedule(
      "execute",
      attemptRequest({ name: "blocked" }),
    );
    await flush();
    expect(commits).toHaveLength(1);

    settlement.lease?.release();
    await flush();
    expect(commits[1]!.editRequest.name).toBe("blocked");
    commits[1]!.resolve({ authority: "saved" });
    (await blocked.settled).lease?.release();
  });

  it("reuses one lease for compound steps without letting a queued intent pass", async () => {
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    const first = scheduler.schedule(
      "execute",
      attemptRequest({ name: "split" }),
    );
    await flush();
    commits[0]!.resolve({ authority: "split" });
    const firstSettlement = await first.settled;

    const queuedIntent = scheduler.schedule(
      "execute",
      attemptRequest({ name: "later-intent" }),
    );
    const compound = scheduler.runWithLease(
      firstSettlement.lease!,
      "execute",
      attemptRequest({ name: "reroot" }),
    );
    await flush();
    expect(commits.map(({ editRequest }) => editRequest.name)).toEqual([
      "split",
      "reroot",
    ]);

    commits[1]!.resolve({ authority: "reroot" });
    const compoundSettlement = await compound.settled;
    expect(compoundSettlement.lease).toBe(firstSettlement.lease);
    compoundSettlement.lease?.release();
    await flush();
    expect(commits[2]!.editRequest.name).toBe("later-intent");
    commits[2]!.resolve({ authority: "later" });
    (await queuedIntent.settled).lease?.release();
  });

  it("cancels a FIFO waiter without materializing or invoking its adapter", async () => {
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    const running = scheduler.schedule(
      "execute",
      attemptRequest({ name: "running" }),
    );
    const materializeQueued = vi.fn(() => ({ name: "queued" }));
    const queued = scheduler.schedule("execute", {
      materializeEditRequest: materializeQueued,
    });
    await flush();

    expect(queued.phase).toBe("waiting-for-lease");
    expect(queued.cancelBeforeCommit("reload required")).toBe(true);
    expect(queued.cancelBeforeCommit("already cancelled")).toBe(false);
    await expect(queued.settled).resolves.toEqual(
      expect.objectContaining({
        outcome: expect.objectContaining({ status: "not-started" }),
      }),
    );
    expect(materializeQueued).not.toHaveBeenCalled();
    expect(commits.map(({ editRequest }) => editRequest.name)).toEqual([
      "running",
    ]);
    commits[0]!.resolve({ authority: "running" });
    (await running.settled).lease?.release();
  });

  it("closes the lease-grant/commit race when cancellation wins", async () => {
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    const running = scheduler.schedule(
      "execute",
      attemptRequest({ name: "running" }),
    );
    const queued = scheduler.schedule(
      "execute",
      attemptRequest({ name: "queued" }),
    );
    await flush();
    commits[0]!.resolve({ authority: "running" });
    const runningSettlement = await running.settled;

    runningSettlement.lease?.release();
    expect(queued.cancelBeforeCommit("Reload-required latch")).toBe(true);
    await expect(queued.settled).resolves.toEqual(
      expect.objectContaining({
        outcome: expect.objectContaining({ status: "not-started" }),
      }),
    );
    expect(commits.map(({ editRequest }) => editRequest.name)).toEqual([
      "running",
    ]);
  });

  it("materializes authoritative identities only after acquiring the lane", async () => {
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    const running = scheduler.schedule(
      "execute",
      attemptRequest({ name: "running" }),
    );
    let authoritativeId = 11;
    const materializeEditRequest = vi.fn(() => ({
      name: `waiting:${authoritativeId}`,
    }));
    const waiting = scheduler.schedule("execute", { materializeEditRequest });
    await flush();
    expect(materializeEditRequest).not.toHaveBeenCalled();

    authoritativeId = 29;
    commits[0]!.resolve({ authority: "running" });
    (await running.settled).lease?.release();
    await flush();
    expect(materializeEditRequest).toHaveBeenCalledTimes(1);
    expect(commits[1]!.editRequest.name).toBe("waiting:29");
    commits[1]!.resolve({ authority: "waiting" });
    (await waiting.settled).lease?.release();
  });

  it("never releases a lease after ownership transfers to the engine", async () => {
    const editRequestScope = {};
    const { adapter, commits } = makeAdapter(editRequestScope);
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    const error = new Error("identity is no longer resolvable");
    let acquiredLease: SpatialSkeletonEditRequestLease | undefined;
    const attempt = scheduler.schedule("execute", {
      onLeaseAcquired: (lease) => {
        acquiredLease = lease;
      },
      materializeEditRequest: () => {
        throw error;
      },
    });

    const settlement = await attempt.settled;
    expect(settlement.outcome.status).toBe("not-started");
    expect(settlement.lease).toBe(acquiredLease);
    expect(acquiredLease?.state).toBe("active");
    expect(commits).toEqual([]);

    const blocked = scheduler.schedule(
      "execute",
      attemptRequest({ name: "blocked" }),
    );
    await flush();
    expect(commits).toEqual([]);
    acquiredLease?.release();
    await flush();
    commits[0]!.resolve({ authority: "saved" });
    (await blocked.settled).lease?.release();
  });

  it("honors re-entrant cancellation without releasing engine-owned authority", async () => {
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    let acquiredLease: SpatialSkeletonEditRequestLease | undefined;
    const attempt = scheduler.schedule("execute", {
      onLeaseAcquired: (lease) => {
        acquiredLease = lease;
      },
      materializeEditRequest: () => ({ name: "re-entrant" }),
      onCommitStarting: () => {
        expect(attempt.phase).toBe("waiting-for-lease");
        expect(attempt.cancelBeforeCommit("Reload-required observer")).toBe(
          true,
        );
      },
    });

    const settlement = await attempt.settled;
    expect(settlement.outcome.status).toBe("not-started");
    expect(settlement.lease).toBe(acquiredLease);
    expect(acquiredLease?.state).toBe("active");
    expect(commits).toEqual([]);
    acquiredLease?.release();
  });

  it("disposal aborts pre-commit work but does not alter transferred leases", async () => {
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    let acquiredLease: SpatialSkeletonEditRequestLease | undefined;
    let resolveMaterialization!: (editRequest: EditRequest) => void;
    const materialization = new Promise<EditRequest>((resolve) => {
      resolveMaterialization = resolve;
    });
    const attempt = scheduler.schedule("execute", {
      onLeaseAcquired: (lease) => {
        acquiredLease = lease;
      },
      materializeEditRequest: () => materialization,
    });
    await flush();

    expect(scheduler.dispose()).toBe(true);
    expect(scheduler.dispose()).toBe(false);
    resolveMaterialization({ name: "too-late" });
    const settlement = await attempt.settled;
    expect(settlement.outcome.status).toBe("not-started");
    expect(settlement.lease).toBe(acquiredLease);
    expect(acquiredLease?.state).toBe("active");
    expect(commits).toEqual([]);
    expect(() =>
      scheduler.schedule("execute", attemptRequest({ name: "late" })),
    ).toThrow(SpatialSkeletonRequestSchedulerDisposedError);
    expect(() =>
      scheduler.runWithLease(
        acquiredLease!,
        "execute",
        attemptRequest({ name: "late-compound" }),
      ),
    ).toThrow(SpatialSkeletonRequestSchedulerDisposedError);
    acquiredLease?.release();
  });

  it("does not abort transport that already started when disposed", async () => {
    const { adapter, commits } = makeAdapter();
    const scheduler = new SpatialSkeletonRequestScheduler({ adapter });
    const running = scheduler.schedule(
      "execute",
      attemptRequest({ name: "running" }),
    );
    await flush();
    expect(running.phase).toBe("committing");

    scheduler.dispose();
    commits[0]!.resolve({ authority: "late" });
    const settlement = await running.settled;
    expect(settlement.outcome.status).toBe("committed");
    expect(settlement.lease?.state).toBe("active");
    settlement.lease?.release();
  });

  it("snapshots edit request scope once and rejects foreign or inactive leases", async () => {
    const coordinator = new SpatialSkeletonEditRequestLock();
    const editRequestScope = {};
    const { adapter, commits, getEditRequestScope } =
      makeAdapter(editRequestScope);
    const scheduler = new SpatialSkeletonRequestScheduler({
      adapter,
      coordinator,
    });
    expect(getEditRequestScope).toHaveBeenCalledTimes(1);

    const foreignLease = await coordinator.acquire({ editRequestScope: {} });
    expect(() =>
      scheduler.runWithLease(
        foreignLease,
        "execute",
        attemptRequest({ name: "foreign" }),
      ),
    ).toThrow("another edit request scope");
    foreignLease.release();

    const first = scheduler.schedule(
      "execute",
      attemptRequest({ name: "first" }),
    );
    await flush();
    commits[0]!.resolve({ authority: "first" });
    const lease = (await first.settled).lease!;
    lease.retain();
    expect(() =>
      scheduler.runWithLease(
        lease,
        "execute",
        attemptRequest({ name: "retained" }),
      ),
    ).toThrow("active plan lease");
    lease.release();
    expect(getEditRequestScope).toHaveBeenCalledTimes(1);
  });
});
