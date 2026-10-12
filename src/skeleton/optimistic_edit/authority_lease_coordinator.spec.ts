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

import { describe, expect, it } from "vitest";

import { SpatialSkeletonMutationAuthorityLeaseCoordinator } from "#src/skeleton/optimistic_edit/authority_lease_coordinator.js";

async function isPending(promise: Promise<unknown>) {
  const marker = {};
  return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
}

describe("SpatialSkeletonMutationAuthorityLeaseCoordinator", () => {
  it("serializes every mutation in one scope in FIFO acquisition order", async () => {
    const coordinator = new SpatialSkeletonMutationAuthorityLeaseCoordinator();
    const mutationScope = {};
    const first = await coordinator.acquire({ mutationScope });
    const secondPromise = coordinator.acquire({ mutationScope });
    const thirdPromise = coordinator.acquire({ mutationScope });

    expect(await isPending(secondPromise)).toBe(true);
    expect(await isPending(thirdPromise)).toBe(true);
    first.release();

    const second = await secondPromise;
    expect(await isPending(thirdPromise)).toBe(true);
    second.release();

    const third = await thirdPromise;
    third.release();
  });

  it("allows different mutation scopes to make progress concurrently", async () => {
    const coordinator = new SpatialSkeletonMutationAuthorityLeaseCoordinator();
    const first = await coordinator.acquire({ mutationScope: {} });
    const second = await coordinator.acquire({ mutationScope: {} });

    expect(first.state).toBe("active");
    expect(second.state).toBe("active");
    first.release();
    second.release();
  });

  it("keeps a retained fatal fence ahead of every waiter in its scope", async () => {
    const coordinator = new SpatialSkeletonMutationAuthorityLeaseCoordinator();
    const mutationScope = {};
    const lease = await coordinator.acquire({ mutationScope });
    expect(lease.retain()).toBe(true);
    expect(lease.state).toBe("retained");

    const waiting = coordinator.acquire({ mutationScope });
    expect(await isPending(waiting)).toBe(true);
    expect(lease.retain()).toBe(false);

    expect(lease.release()).toBe(true);
    const next = await waiting;
    expect(next.state).toBe("active");
    expect(lease.release()).toBe(false);
    next.release();
  });

  it("removes an aborted waiter without disturbing FIFO order", async () => {
    const coordinator = new SpatialSkeletonMutationAuthorityLeaseCoordinator();
    const mutationScope = {};
    const first = await coordinator.acquire({ mutationScope });
    const controller = new AbortController();
    const aborted = coordinator.acquire({
      mutationScope,
      signal: controller.signal,
    });
    const third = coordinator.acquire({ mutationScope });

    controller.abort("not needed");
    await expect(aborted).rejects.toBe("not needed");
    first.release();
    const thirdLease = await third;
    thirdLease.release();
  });

  it("rejects invalid scopes and already-aborted acquisition", async () => {
    const coordinator = new SpatialSkeletonMutationAuthorityLeaseCoordinator();
    await expect(
      coordinator.acquire({ mutationScope: null as unknown as object }),
    ).rejects.toThrow("requires an object scope");

    const controller = new AbortController();
    controller.abort("stopped");
    await expect(
      coordinator.acquire({ mutationScope: {}, signal: controller.signal }),
    ).rejects.toBe("stopped");
  });
});
