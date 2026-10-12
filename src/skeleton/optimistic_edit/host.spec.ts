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

import type { EditableSpatiallyIndexedSkeletonSource } from "#src/skeleton/api.js";
import { SpatialSkeletonActions } from "#src/skeleton/command_protocol.js";
import {
  SpatialSkeletonOptimisticDatasourceContractError,
  type SpatialSkeletonOptimisticDriverRegistration,
  type SpatialSkeletonOptimisticEditingProvider,
} from "#src/skeleton/optimistic_edit/api.js";
import {
  ensureSpatialSkeletonOptimisticEditQueue,
  getSpatialSkeletonOptimisticEditingProvider,
} from "#src/skeleton/optimistic_edit/host.js";
import {
  SpatialSkeletonState,
  type SpatialSkeletonLayerContext,
} from "#src/skeleton/spatial_skeleton_manager.js";

function makeSource(
  optimisticEditing?: unknown,
): EditableSpatiallyIndexedSkeletonSource {
  return {
    readonly: false,
    optimisticEditing,
  } as unknown as EditableSpatiallyIndexedSkeletonSource;
}

function makeRegistration(
  cleanup = vi.fn(),
): SpatialSkeletonOptimisticDriverRegistration {
  return {
    driver: {
      describeIntent: () => ({ kind: "test", commandLabel: "Test" }),
      createLogicalIntent: (_command, context) => ({
        kind: "test",
        commandLabel: "Test",
        logicalResources: [],
        workflow: { intentId: context.intentId },
        projection: undefined as never,
      }),
      nextAttempt: () => undefined,
      createReconciliation: () => ({}),
    },
    mutationAdapter: {
      mutationScope: {},
      commit: async () => ({}),
      classifyFailure: () => "indeterminate",
    },
    cleanup,
  };
}

function fixture(provider: SpatialSkeletonOptimisticEditingProvider) {
  const state = new SpatialSkeletonState();
  const source = makeSource(provider);
  const layer = {
    spatialSkeletonState: state,
    getSpatiallyIndexedSkeletonLayer: () => undefined,
  } as SpatialSkeletonLayerContext;
  return { state, source, layer };
}

interface ControlledMutation {
  readonly operation: "edit";
}

interface ControlledCommit {
  readonly mutation: ControlledMutation;
  resolve(result: { readonly ok: true }): void;
  reject(error: unknown): void;
}

function controlledProvider(cleanup = vi.fn()) {
  const commits: ControlledCommit[] = [];
  const provider: SpatialSkeletonOptimisticEditingProvider = {
    createDriver: ({ identities }) => {
      const segment = identities.getOrCreateSegmentHandle(11);
      const node = identities.getOrCreateNodeHandle(21);
      return {
        driver: {
          describeIntent: () => ({ kind: "test", commandLabel: "Test" }),
          createLogicalIntent: () => ({
            kind: "test",
            commandLabel: "Controlled edit",
            logicalResources: [
              { handle: segment, access: "write" },
              { handle: node, access: "write" },
            ],
            workflow: Object.freeze({}),
            projection: {
              delta: {
                kind: "add",
                segment,
                node,
                position: [1, 2, 3],
              },
            },
          }),
          nextAttempt: (_workflow, context) => {
            if (context.committedAttempts.length !== 0) return undefined;
            const mutation = { operation: "edit" } as const;
            return {
              materializeMutation: () => mutation,
            };
          },
          createReconciliation: () => ({}),
        },
        mutationAdapter: {
          mutationScope: {},
          commit: (mutation) =>
            new Promise<{ readonly ok: true }>((resolve, reject) => {
              commits.push({ mutation, resolve, reject });
            }),
          classifyFailure: (error) =>
            (
              error as Error & {
                disposition?: "not-started" | "rejected" | "indeterminate";
              }
            ).disposition ?? "indeterminate",
        },
        cleanup,
      };
    },
  };
  return { provider, commits, cleanup };
}

function controlledCommand() {
  return Object.freeze({
    action: SpatialSkeletonActions.addNodes,
    label: "Controlled edit",
    payload: Object.freeze({}),
    getQueueInputRequirements: () => ({ required: [] }),
  });
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; ++index) await Promise.resolve();
}

describe("spatial skeleton optimistic edit host", () => {
  it("constructs and reuses one state-owned engine per source", () => {
    const createDriver = vi.fn<
      SpatialSkeletonOptimisticEditingProvider["createDriver"]
    >(() => makeRegistration());
    const { state, layer, source } = fixture({ createDriver });

    const first = ensureSpatialSkeletonOptimisticEditQueue(layer, source);
    const second = ensureSpatialSkeletonOptimisticEditQueue(layer, source);

    expect(second).toBe(first);
    expect(createDriver).toHaveBeenCalledOnce();
    expect(createDriver.mock.calls[0]![0]).toMatchObject({ source });
    expect(createDriver.mock.calls[0]![0]).not.toHaveProperty("layer");
    expect(createDriver.mock.calls[0]![0].identities).toBeDefined();
    expect(createDriver.mock.calls[0]![0].provisionalIds).toBeDefined();
    state.dispose();
  });

  it("keeps the current queue when replacement setup fails", () => {
    const cleanup = vi.fn();
    const currentProvider = { createDriver: () => makeRegistration(cleanup) };
    const { state, layer, source } = fixture(currentProvider);
    const current = ensureSpatialSkeletonOptimisticEditQueue(layer, source);
    const replacementError = new Error("provider setup failed");
    const replacement = makeSource({
      createDriver: () => {
        throw replacementError;
      },
    });

    expect(() =>
      ensureSpatialSkeletonOptimisticEditQueue(layer, replacement),
    ).toThrow(replacementError);
    expect(ensureSpatialSkeletonOptimisticEditQueue(layer, source)).toBe(
      current,
    );
    expect(cleanup).not.toHaveBeenCalled();
    state.dispose();
  });

  it("runs datasource cleanup when state-owned runtime is released", async () => {
    const cleanup = vi.fn();
    const { state, layer, source } = fixture({
      createDriver: () => makeRegistration(cleanup),
    });
    ensureSpatialSkeletonOptimisticEditQueue(layer, source);

    expect(state.releaseOptimisticEditingEngine()).toBe(true);
    expect(state.releaseOptimisticEditingEngine()).toBe(false);
    await flushMicrotasks();
    expect(cleanup).toHaveBeenCalledOnce();
    state.dispose();
  });

  it("defers datasource cleanup until a late committed transport is classified", async () => {
    const { provider, commits, cleanup } = controlledProvider();
    const { state, layer, source } = fixture(provider);
    const queue = ensureSpatialSkeletonOptimisticEditQueue(layer, source);
    const execution = state.executeOptimisticEdit(controlledCommand(), {
      segments: [],
    });
    await execution;
    await flushMicrotasks();
    expect(commits).toHaveLength(1);

    expect(state.releaseOptimisticEditingEngine()).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    commits[0]!.resolve({ ok: true });
    await queue.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(commits.map(({ mutation }) => mutation.operation)).toEqual(["edit"]);
    expect(state.getOptimisticEditFatalState()).toMatchObject({
      reason: "committed-local-publication-failed",
    });
    let editSettled = false;
    void execution.settled.then(() => (editSettled = true));
    await flushMicrotasks();
    expect(editSettled).toBe(false);
    state.dispose();
  });

  it("installs a replacement engine while the old datasource cleanup is deferred", async () => {
    const { provider, commits, cleanup } = controlledProvider();
    const { state, layer, source } = fixture(provider);
    const oldQueue = ensureSpatialSkeletonOptimisticEditQueue(layer, source);
    const execution = state.executeOptimisticEdit(controlledCommand(), {
      segments: [],
    });
    await execution;
    await flushMicrotasks();
    expect(commits).toHaveLength(1);

    const replacementCleanup = vi.fn();
    const replacementSource = makeSource({
      createDriver: () => makeRegistration(replacementCleanup),
    });
    const replacementQueue = ensureSpatialSkeletonOptimisticEditQueue(
      layer,
      replacementSource,
    );
    expect(replacementQueue).not.toBe(oldQueue);
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      ensureSpatialSkeletonOptimisticEditQueue(layer, replacementSource),
    ).toBe(replacementQueue);

    commits[0]!.resolve({ ok: true });
    await oldQueue.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(
      ensureSpatialSkeletonOptimisticEditQueue(layer, replacementSource),
    ).toBe(replacementQueue);
    state.dispose();
    await flushMicrotasks();
    expect(replacementCleanup).toHaveBeenCalledOnce();
  });

  it("cleans up after indeterminate classification while fatal settlement stays pending", async () => {
    const { provider, commits, cleanup } = controlledProvider();
    const { state, layer, source } = fixture(provider);
    const queue = ensureSpatialSkeletonOptimisticEditQueue(layer, source);
    const execution = state.executeOptimisticEdit(controlledCommand(), {
      segments: [],
    });
    await execution;
    await flushMicrotasks();
    expect(commits).toHaveLength(1);

    state.releaseOptimisticEditingEngine();
    let editSettled = false;
    void execution.settled.then(() => (editSettled = true));
    commits[0]!.reject(new Error("connection lost"));
    await queue.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(editSettled).toBe(false);
    expect(state.getOptimisticEditFatalState()).toMatchObject({
      reason: "authority-indeterminate",
    });
    state.dispose();
  });

  it("cleans up after definitive classification of a disposed transport", async () => {
    const { provider, commits, cleanup } = controlledProvider();
    const { state, layer, source } = fixture(provider);
    const queue = ensureSpatialSkeletonOptimisticEditQueue(layer, source);
    const execution = state.executeOptimisticEdit(controlledCommand(), {
      segments: [],
    });
    await execution;
    await flushMicrotasks();
    expect(commits).toHaveLength(1);

    state.releaseOptimisticEditingEngine();
    commits[0]!.reject(
      Object.assign(new Error("not saved"), {
        disposition: "rejected" as const,
      }),
    );
    await queue.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
    await expect(execution.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "rejected",
    });
    expect(state.getOptimisticEditFatalState()).toBeUndefined();
    state.dispose();
  });

  it("rejects a writable source without the mandatory driver contract", () => {
    const state = new SpatialSkeletonState();
    const layer = {
      spatialSkeletonState: state,
      getSpatiallyIndexedSkeletonLayer: () => undefined,
    } as SpatialSkeletonLayerContext;
    expect(() =>
      ensureSpatialSkeletonOptimisticEditQueue(layer, makeSource()),
    ).toThrow(SpatialSkeletonOptimisticDatasourceContractError);
    state.dispose();
  });

  it("rejects provider-owned queue state in a driver registration", () => {
    const registration = makeRegistration();
    const { state, layer, source } = fixture({
      createDriver: () => ({ ...registration, queue: {} }) as any,
    });
    expect(() =>
      ensureSpatialSkeletonOptimisticEditQueue(layer, source),
    ).toThrow(/engine-owned field "queue"/);
    state.dispose();
  });

  it("rejects an invalid datasource mutation scope before installing edits", () => {
    for (const mutationScope of [undefined, null, 17]) {
      const registration = makeRegistration();
      const { state, layer, source } = fixture({
        createDriver: () => ({
          ...registration,
          mutationAdapter: {
            ...registration.mutationAdapter,
            mutationScope: mutationScope as unknown as object,
          },
        }),
      });
      expect(() =>
        ensureSpatialSkeletonOptimisticEditQueue(layer, source),
      ).toThrow(/stable object mutationScope/);
      state.dispose();
    }
  });

  it("reports a throwing mutation-scope getter as a datasource contract error", () => {
    const registration = makeRegistration();
    const { state, layer, source } = fixture({
      createDriver: () => ({
        ...registration,
        mutationAdapter: {
          get mutationScope(): object {
            throw new Error("scope setup failed");
          },
          commit: registration.mutationAdapter.commit,
          classifyFailure: registration.mutationAdapter.classifyFailure,
        },
      }),
    });
    expect(() =>
      ensureSpatialSkeletonOptimisticEditQueue(layer, source),
    ).toThrow(SpatialSkeletonOptimisticDatasourceContractError);
    state.dispose();
  });

  it("ignores malformed source capability values", () => {
    expect(
      getSpatialSkeletonOptimisticEditingProvider(
        makeSource({ supportsAction: () => true }),
      ),
    ).toBeUndefined();
  });
});
