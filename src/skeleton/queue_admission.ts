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

import type {
  SpatialSkeletonAction,
  SpatialSkeletonCommandContext,
  SpatialSkeletonEditCommand,
  SpatialSkeletonQueueInput,
  SpatialSkeletonQueueInputRequirement,
  SpatialSkeletonQueueInputRequirements,
  SpatialSkeletonQueueInputPreparation,
  SpatialSkeletonPreparedQueueInput,
} from "#src/skeleton/command_protocol.js";
import { SpatialSkeletonInspectionRequiredError } from "#src/skeleton/edit_errors.js";
import { unchangedSpatialSkeletonOptimisticEditSettlement } from "#src/skeleton/optimistic_edit/lifecycle.js";
import type {
  SpatialSkeletonInputReference,
  SpatialSkeletonLayerContext,
  SpatialSkeletonOptimisticEditExecution,
} from "#src/skeleton/spatial_skeleton_manager.js";
import { withPromiseProperties } from "#src/util/promise.js";

/** A queue input requirement paired with a reference to its complete snapshot. */
interface QueueInputBinding {
  /**
   * What the edit needs: e.g. { segmentId: 23, nodeId: 5 } requires a complete
   * snapshot of skeleton 23 containing node 5.
   */
  readonly requirement: SpatialSkeletonQueueInputRequirement;
  /**
   * The acquired reference: e.g. skeleton 23's snapshot at cache revision 10.
   * reference.snapshot.handle.getNode(5) reads node 5 from that version.
   * reference.release() removes this preparation step's cache registration.
   */
  readonly reference: SpatialSkeletonInputReference;
}

/** Release this preparation step's references to complete cached snapshots. */
function releaseInputReferences(bindings: readonly QueueInputBinding[]) {
  for (const { reference } of bindings) reference.release();
}

function captureQueueInputRequirements(
  command: SpatialSkeletonEditCommand,
  context: SpatialSkeletonCommandContext,
  layer: SpatialSkeletonLayerContext,
) {
  const { required, loadable = [] } =
    command.getQueueInputRequirements(context);
  const resolveOwner = (requirement: SpatialSkeletonQueueInputRequirement) => {
    const node =
      requirement.nodeId === undefined
        ? undefined
        : layer.spatialSkeletonState.getCachedNode(requirement.nodeId);
    return Object.freeze({
      ...requirement,
      segmentId: node?.segmentId ?? requirement.segmentId,
    });
  };
  return Object.freeze({
    required: Object.freeze(required.map(resolveOwner)),
    loadable: Object.freeze(loadable.map(resolveOwner)),
  });
}

/** Bind required inputs to acquired cached references before starting any reads. */
function prepareRequiredInputBindings(
  layer: SpatialSkeletonLayerContext,
  requirements: readonly SpatialSkeletonQueueInputRequirement[],
  action?: SpatialSkeletonAction,
): QueueInputBinding[] {
  const bindings: QueueInputBinding[] = [];
  try {
    for (const requirement of requirements) {
      bindings.push({
        requirement,
        reference: layer.spatialSkeletonState.acquireInputReference(
          requirement,
          action,
        ),
      });
    }
    return bindings;
  } catch (error) {
    releaseInputReferences(bindings);
    throw error;
  }
}

async function loadQueueInputRequirement(
  layer: SpatialSkeletonLayerContext,
  requirement: SpatialSkeletonQueueInputRequirement,
  signal: AbortSignal,
) {
  const skeletonLayer = layer.getSpatiallyIndexedSkeletonLayer();
  if (skeletonLayer === undefined) {
    throw new Error(
      "No active spatial skeleton layer is available to load queue inputs.",
    );
  }
  signal.throwIfAborted();
  const requestOwner = {};
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    layer.spatialSkeletonState.releaseFullSegmentNodeFetchOwner(requestOwner);
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([
      layer.spatialSkeletonState.getFullSegmentNodes(
        skeletonLayer,
        requirement.segmentId,
        {
          // The edit still needs this read if the pointer leaves the skeleton.
          // Its owner joins any existing fetch without taking sole ownership.
          retainWhileInactive: true,
          requestOwner,
        },
      ),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    layer.spatialSkeletonState.releaseFullSegmentNodeFetchOwner(requestOwner);
  }
}

function assertInputReferencesCurrent(
  bindings: readonly QueueInputBinding[],
  action?: SpatialSkeletonAction,
) {
  for (const { reference, requirement } of bindings) {
    if (reference.isCurrent()) continue;
    throw new SpatialSkeletonInspectionRequiredError(
      requirement,
      action,
      "snapshot-changed",
    );
  }
}

/** Require unchanged endpoints and loading policies; order alone may differ. */
function assertQueueInputRequirementsUnchanged(
  original: SpatialSkeletonQueueInputRequirements,
  current: SpatialSkeletonQueueInputRequirements,
  action?: SpatialSkeletonAction,
): void {
  for (const group of ["required", "loadable"] as const) {
    const unmatched = [...(current[group] ?? [])];
    for (const requirement of original[group] ?? []) {
      const index = unmatched.findIndex(
        (candidate) =>
          candidate.segmentId === requirement.segmentId &&
          candidate.nodeId === requirement.nodeId,
      );
      if (index === -1) {
        throw new SpatialSkeletonInspectionRequiredError(
          requirement,
          action,
          "requirements-changed",
        );
      }
      unmatched.splice(index, 1);
    }
    if (unmatched.length !== 0) {
      throw new SpatialSkeletonInspectionRequiredError(
        unmatched[0],
        action,
        "requirements-changed",
      );
    }
  }
}

/** Capture requirements and bind each to a reference, loading missing inputs in order. */
function prepareQueueInputBindings(
  layer: SpatialSkeletonLayerContext,
  command: SpatialSkeletonEditCommand,
  context: SpatialSkeletonCommandContext,
  action: SpatialSkeletonAction | undefined,
  signal: AbortSignal,
  intent: "execute" | "redo",
): readonly QueueInputBinding[] | Promise<readonly QueueInputBinding[]> {
  const declared = captureQueueInputRequirements(command, context, layer);
  // A canceled, unprepared history entry has no retained exact recipe. Redo
  // may reacquire its previously validated source after visual cache eviction.
  const requirements =
    intent === "execute"
      ? declared
      : {
          required: [],
          loadable: [...declared.required, ...declared.loadable],
        };
  const requiredBindings = prepareRequiredInputBindings(
    layer,
    requirements.required,
    action,
  );
  const state = layer.spatialSkeletonState;
  const loadableBindings: (QueueInputBinding | undefined)[] = [];
  const getBindings = () => [
    ...requiredBindings,
    ...loadableBindings.filter((binding) => binding !== undefined),
  ];
  try {
    // Keep every cached input available before any read can yield.
    for (const requirement of requirements.loadable) {
      const reference = state.tryAcquireInputReference(requirement);
      loadableBindings.push(
        reference === undefined ? undefined : { requirement, reference },
      );
    }
    assertInputReferencesCurrent(getBindings(), action);
    if (loadableBindings.every((binding) => binding !== undefined))
      return getBindings();
  } catch (error) {
    releaseInputReferences(getBindings());
    throw error;
  }

  return (async () => {
    try {
      for (const [index, requirement] of requirements.loadable.entries()) {
        if (loadableBindings[index] !== undefined) continue;
        state.assertOptimisticEditingAllowed();
        assertInputReferencesCurrent(getBindings(), action);
        // An earlier endpoint may have loaded this same complete skeleton.
        let reference = state.tryAcquireInputReference(requirement);
        if (reference === undefined) {
          await loadQueueInputRequirement(layer, requirement, signal);
          signal.throwIfAborted();
          state.assertOptimisticEditingAllowed();
          assertInputReferencesCurrent(getBindings(), action);
          assertQueueInputRequirementsUnchanged(
            declared,
            captureQueueInputRequirements(command, context, layer),
            action,
          );
          reference = state.acquireInputReference(requirement, action);
        }
        loadableBindings[index] = { requirement, reference };
      }
      const bindings = getBindings();
      assertInputReferencesCurrent(bindings, action);
      return bindings;
    } catch (error) {
      releaseInputReferences(getBindings());
      throw error;
    }
  })();
}

function createQueueInput(
  bindings: readonly QueueInputBinding[],
): SpatialSkeletonQueueInput {
  const segments = new Map<
    number,
    SpatialSkeletonQueueInput["segments"][number]
  >();
  for (const { reference } of bindings) {
    const candidate = Object.freeze({
      segmentId: reference.segmentId,
      snapshot: reference.snapshot.handle,
      cacheRevision: reference.snapshot.cacheRevision,
    });
    const existing = segments.get(candidate.segmentId);
    if (existing === undefined) {
      segments.set(candidate.segmentId, candidate);
      continue;
    }
    if (
      existing.snapshot !== candidate.snapshot ||
      existing.cacheRevision !== candidate.cacheRevision
    ) {
      throw new Error(
        `Queue input requirements for segment ${candidate.segmentId} resolved to different complete snapshots.`,
      );
    }
  }
  return Object.freeze({ segments: Object.freeze([...segments.values()]) });
}

/** Validate inspection synchronously, acquire fresh inputs at the ordered frontier. */
export function createSpatialSkeletonQueueInputPreparation(
  layer: SpatialSkeletonLayerContext,
  command: SpatialSkeletonEditCommand,
  action?: SpatialSkeletonAction,
): SpatialSkeletonQueueInputPreparation {
  const context = {
    identities:
      layer.spatialSkeletonState.getOptimisticEditingIdentityService(),
  };
  return Object.freeze({
    getProtectedSegmentIds() {
      const requirements = captureQueueInputRequirements(
        command,
        context,
        layer,
      );
      return Object.freeze([
        ...new Set(
          [...requirements.required, ...requirements.loadable].map(
            ({ segmentId }) => segmentId,
          ),
        ),
      ]);
    },
    validate(intent: "execute" | "redo") {
      layer.spatialSkeletonState.assertOptimisticEditingAllowed();
      const requirements = captureQueueInputRequirements(
        command,
        context,
        layer,
      );
      const bindings =
        intent === "execute"
          ? prepareRequiredInputBindings(layer, requirements.required, action)
          : requirements.required.flatMap((requirement) => {
              const reference =
                layer.spatialSkeletonState.tryAcquireInputReference(
                  requirement,
                );
              return reference === undefined
                ? []
                : [{ requirement, reference }];
            });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseInputReferences(bindings);
      };
    },
    async acquire(
      signal: AbortSignal,
      intent: "execute" | "redo",
    ): Promise<SpatialSkeletonPreparedQueueInput> {
      signal.throwIfAborted();
      layer.spatialSkeletonState.assertOptimisticEditingAllowed();
      const bindings = await prepareQueueInputBindings(
        layer,
        command,
        context,
        action,
        signal,
        intent,
      );
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseInputReferences(bindings);
      };
      try {
        signal.throwIfAborted();
        layer.spatialSkeletonState.assertOptimisticEditingAllowed();
        assertInputReferencesCurrent(bindings, action);
        return Object.freeze({
          input: createQueueInput(bindings),
          assertCurrent: () => {
            signal.throwIfAborted();
            layer.spatialSkeletonState.assertOptimisticEditingAllowed();
            assertInputReferencesCurrent(bindings, action);
          },
          release,
        });
      } catch (error) {
        release();
        throw error;
      }
    },
  });
}

/** Registers before any input read; the queue owns preparation and cancellation. */
export function prepareAndSubmitSpatialSkeletonEdit<T>(
  layer: SpatialSkeletonLayerContext,
  command: SpatialSkeletonEditCommand,
  submitToQueue: (
    inputs: SpatialSkeletonQueueInputPreparation,
  ) => SpatialSkeletonOptimisticEditExecution<T>,
  action?: SpatialSkeletonAction,
): SpatialSkeletonOptimisticEditExecution<T> {
  try {
    return submitToQueue(
      createSpatialSkeletonQueueInputPreparation(layer, command, action),
    );
  } catch (error) {
    const acceptedByQueue = Promise.reject<void>(error);
    void acceptedByQueue.catch(() => undefined);
    const execution = Promise.reject<T>(error);
    void execution.catch(() => undefined);
    return withPromiseProperties(execution, {
      acceptedByQueue,
      settled: Promise.resolve(
        unchangedSpatialSkeletonOptimisticEditSettlement("not-started", error),
      ),
    });
  }
}
