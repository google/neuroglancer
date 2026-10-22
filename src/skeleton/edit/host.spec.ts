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

import type { EditableSkeletonSource } from "#src/skeleton/api.js";
import type { SpatialSkeletonLayerContext } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  ensureSpatialSkeletonEditQueue,
  getSpatialSkeletonEditPlannerProvider,
  SpatialSkeletonEditSession,
} from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import { SpatialSkeletonActions } from "#src/skeleton/edit_commands.js";
import type {
  SpatialSkeletonEditPlannerRegistration,
  SpatialSkeletonEditPlannerProvider,
} from "#src/skeleton/edit_queue/api.js";
import {
  SpatialSkeletonDatasourceContractError,
  isSpatialSkeletonEditPlannerProvider,
} from "#src/skeleton/edit_queue/api.js";

function makeSource(editPlannerProvider?: unknown): EditableSkeletonSource {
  return {
    readonly: false,
    editPlannerProvider,
  } as unknown as EditableSkeletonSource;
}

function makeRegistration(
  cleanup = vi.fn(),
): SpatialSkeletonEditPlannerRegistration {
  return {
    planner: {
      describeIntent: () => ({ kind: "test", commandLabel: "Test" }),
      planIntent: (_command, context) => ({
        kind: "test",
        commandLabel: "Test",
        stableResources: [],
        plan: { intentId: context.intentId },
        preview: undefined as never,
      }),
      nextAttempt: () => undefined,
      createReconciliation: () => ({}),
    },
    editRequestAdapter: {
      editRequestScope: {},
      commit: async () => ({}),
      classifyFailure: () => "indeterminate",
    },
    cleanup,
  };
}

function fixture(provider: SpatialSkeletonEditPlannerProvider) {
  const state = new SpatialSkeletonEditSession();
  const source = makeSource(provider);
  const layer = {
    spatialSkeletonEditSession: state,
    getSpatiallyIndexedSkeletonLayer: () => undefined,
  } as SpatialSkeletonLayerContext;
  return { state, source, layer };
}

interface ControlledEditRequest {
  readonly operation: "edit";
}

interface ControlledCommit {
  readonly editRequest: ControlledEditRequest;
  resolve(result: { readonly ok: true }): void;
  reject(error: unknown): void;
}

function controlledProvider(cleanup = vi.fn()) {
  const commits: ControlledCommit[] = [];
  const provider: SpatialSkeletonEditPlannerProvider = {
    createPlanner: ({ identities }) => {
      const segment = identities.getOrCreateSegmentHandle(11n);
      const node = identities.getOrCreateNodeHandle(21n);
      return {
        planner: {
          describeIntent: () => ({ kind: "test", commandLabel: "Test" }),
          planIntent: () => ({
            kind: "test",
            commandLabel: "Controlled edit",
            stableResources: [
              { handle: segment, access: "write" },
              { handle: node, access: "write" },
            ],
            plan: Object.freeze({}),
            preview: {
              delta: {
                kind: "add",
                segment,
                node,
                position: [1, 2, 3],
              },
            },
          }),
          nextAttempt: (_plan, context) => {
            if (context.committedAttempts.length !== 0) return undefined;
            const editRequest = { operation: "edit" } as const;
            return {
              materializeEditRequest: () => editRequest,
            };
          },
          createReconciliation: () => ({}),
        },
        editRequestAdapter: {
          editRequestScope: {},
          commit: (editRequest) =>
            new Promise<{ readonly ok: true }>((resolve, reject) => {
              commits.push({ editRequest, resolve, reject });
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
  it("constructs and reuses one session-owned edit queue per source", () => {
    const createPlanner = vi.fn<
      SpatialSkeletonEditPlannerProvider["createPlanner"]
    >(() => makeRegistration());
    const { state, layer, source } = fixture({ createPlanner });

    const first = ensureSpatialSkeletonEditQueue(layer, source);
    const second = ensureSpatialSkeletonEditQueue(layer, source);

    expect(second).toBe(first);
    expect(createPlanner).toHaveBeenCalledOnce();
    expect(createPlanner.mock.calls[0]![0]).toMatchObject({ source });
    expect(createPlanner.mock.calls[0]![0]).not.toHaveProperty("layer");
    expect(createPlanner.mock.calls[0]![0].identities).toBeDefined();
    expect(createPlanner.mock.calls[0]![0].provisionalIds).toBeDefined();
    state.dispose();
  });

  it("keeps the current queue when replacement setup fails", () => {
    const cleanup = vi.fn();
    const currentProvider = { createPlanner: () => makeRegistration(cleanup) };
    const { state, layer, source } = fixture(currentProvider);
    const current = ensureSpatialSkeletonEditQueue(layer, source);
    const replacementError = new Error("provider setup failed");
    const replacement = makeSource({
      createPlanner: () => {
        throw replacementError;
      },
    });

    expect(() => ensureSpatialSkeletonEditQueue(layer, replacement)).toThrow(
      replacementError,
    );
    expect(ensureSpatialSkeletonEditQueue(layer, source)).toBe(current);
    expect(cleanup).not.toHaveBeenCalled();
    state.dispose();
  });

  it("runs datasource cleanup when the session-owned queue is released", async () => {
    const cleanup = vi.fn();
    const { state, layer, source } = fixture({
      createPlanner: () => makeRegistration(cleanup),
    });
    ensureSpatialSkeletonEditQueue(layer, source);

    expect(state.releaseEditQueue()).toBe(true);
    expect(state.releaseEditQueue()).toBe(false);
    await flushMicrotasks();
    expect(cleanup).toHaveBeenCalledOnce();
    state.dispose();
  });

  it("defers datasource cleanup until a late committed transport is classified", async () => {
    const { provider, commits, cleanup } = controlledProvider();
    const { state, layer, source } = fixture(provider);
    const queue = ensureSpatialSkeletonEditQueue(layer, source);
    const execution = state.executeEdit(controlledCommand(), {
      segments: [],
    });
    await execution;
    await flushMicrotasks();
    expect(commits).toHaveLength(1);

    expect(state.releaseEditQueue()).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    commits[0]!.resolve({ ok: true });
    await queue.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(commits.map(({ editRequest }) => editRequest.operation)).toEqual([
      "edit",
    ]);
    expect(state.getReloadRequired()).toMatchObject({
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
    const oldQueue = ensureSpatialSkeletonEditQueue(layer, source);
    const execution = state.executeEdit(controlledCommand(), {
      segments: [],
    });
    await execution;
    await flushMicrotasks();
    expect(commits).toHaveLength(1);

    const replacementCleanup = vi.fn();
    const replacementSource = makeSource({
      createPlanner: () => makeRegistration(replacementCleanup),
    });
    const replacementQueue = ensureSpatialSkeletonEditQueue(
      layer,
      replacementSource,
    );
    expect(replacementQueue).not.toBe(oldQueue);
    expect(cleanup).not.toHaveBeenCalled();
    expect(ensureSpatialSkeletonEditQueue(layer, replacementSource)).toBe(
      replacementQueue,
    );

    commits[0]!.resolve({ ok: true });
    await oldQueue.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(ensureSpatialSkeletonEditQueue(layer, replacementSource)).toBe(
      replacementQueue,
    );
    state.dispose();
    await flushMicrotasks();
    expect(replacementCleanup).toHaveBeenCalledOnce();
  });

  it("cleans up after indeterminate classification while Reload-required settlement stays pending", async () => {
    const { provider, commits, cleanup } = controlledProvider();
    const { state, layer, source } = fixture(provider);
    const queue = ensureSpatialSkeletonEditQueue(layer, source);
    const execution = state.executeEdit(controlledCommand(), {
      segments: [],
    });
    await execution;
    await flushMicrotasks();
    expect(commits).toHaveLength(1);

    state.releaseEditQueue();
    let editSettled = false;
    void execution.settled.then(() => (editSettled = true));
    commits[0]!.reject(new Error("connection lost"));
    await queue.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(editSettled).toBe(false);
    expect(state.getReloadRequired()).toMatchObject({
      reason: "authority-indeterminate",
    });
    state.dispose();
  });

  it("cleans up after definitive classification of a disposed transport", async () => {
    const { provider, commits, cleanup } = controlledProvider();
    const { state, layer, source } = fixture(provider);
    const queue = ensureSpatialSkeletonEditQueue(layer, source);
    const execution = state.executeEdit(controlledCommand(), {
      segments: [],
    });
    await execution;
    await flushMicrotasks();
    expect(commits).toHaveLength(1);

    state.releaseEditQueue();
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
    expect(state.getReloadRequired()).toBeUndefined();
    state.dispose();
  });

  it("rejects a writable source without the mandatory planner contract", () => {
    const state = new SpatialSkeletonEditSession();
    const layer = {
      spatialSkeletonEditSession: state,
      getSpatiallyIndexedSkeletonLayer: () => undefined,
    } as SpatialSkeletonLayerContext;
    expect(() => ensureSpatialSkeletonEditQueue(layer, makeSource())).toThrow(
      SpatialSkeletonDatasourceContractError,
    );
    state.dispose();
  });

  it("rejects provider-owned queue state in a planner registration", () => {
    const registration = makeRegistration();
    const { state, layer, source } = fixture({
      createPlanner: () => ({ ...registration, queue: {} }) as any,
    });
    expect(() => ensureSpatialSkeletonEditQueue(layer, source)).toThrow(
      /engine-owned field "queue"/,
    );
    state.dispose();
  });

  it("rejects an invalid datasource edit request scope before installing edits", () => {
    for (const editRequestScope of [undefined, null, 17]) {
      const registration = makeRegistration();
      const { state, layer, source } = fixture({
        createPlanner: () => ({
          ...registration,
          editRequestAdapter: {
            ...registration.editRequestAdapter,
            editRequestScope: editRequestScope as unknown as object,
          },
        }),
      });
      expect(() => ensureSpatialSkeletonEditQueue(layer, source)).toThrow(
        /stable object editRequestScope/,
      );
      state.dispose();
    }
  });

  it("reports a throwing edit request-scope getter as a datasource contract error", () => {
    const registration = makeRegistration();
    const { state, layer, source } = fixture({
      createPlanner: () => ({
        ...registration,
        editRequestAdapter: {
          get editRequestScope(): object {
            throw new Error("scope setup failed");
          },
          commit: registration.editRequestAdapter.commit,
          classifyFailure: registration.editRequestAdapter.classifyFailure,
        },
      }),
    });
    expect(() => ensureSpatialSkeletonEditQueue(layer, source)).toThrow(
      SpatialSkeletonDatasourceContractError,
    );
    state.dispose();
  });

  it("ignores malformed source capability values", () => {
    expect(
      getSpatialSkeletonEditPlannerProvider(
        makeSource({ supportsAction: () => true }),
      ),
    ).toBeUndefined();
  });
});

describe("isSpatialSkeletonEditPlannerProvider", () => {
  it("accepts only values exposing the planner provider operation", () => {
    const provider = {
      createPlanner: () => ({}),
    };

    expect(isSpatialSkeletonEditPlannerProvider(provider)).toBe(true);
    expect(
      isSpatialSkeletonEditPlannerProvider({
        getOrCreateQueue: () => ({}),
      }),
    ).toBe(false);
    expect(isSpatialSkeletonEditPlannerProvider(null)).toBe(false);
  });
});
