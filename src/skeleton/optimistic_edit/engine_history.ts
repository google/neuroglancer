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
  EngineIntentJournal,
  EngineIntentRecord,
  EngineIntentRuntime,
} from "#src/skeleton/optimistic_edit/engine_runtime.js";
import type {
  SpatialSkeletonOptimisticHistoryPort,
  SpatialSkeletonOptimisticProjectionPort,
  SpatialSkeletonProjectionHistoryRecipe,
  SpatialSkeletonProjectionIntentArtifact,
} from "#src/skeleton/optimistic_edit/ports.js";
import type { SpatialSkeletonIntentKind } from "#src/skeleton/spatial_skeleton_intent_journal.js";

export interface SpatialSkeletonOptimisticEngineHistoryOptions<
  TInput,
  THistoryTicket,
  TWorkflow,
  TProjection,
  TMutation,
  TResult,
  TReconciliation,
  TInverseProjection,
> {
  readonly journal: EngineIntentJournal<
    TInput,
    TWorkflow,
    THistoryTicket,
    TProjection,
    TInverseProjection,
    TMutation,
    TResult
  >;
  readonly runtimes: Map<number, EngineIntentRuntime<TResult>>;
  readonly history: SpatialSkeletonOptimisticHistoryPort<
    TInput,
    THistoryTicket
  >;
  readonly projection: SpatialSkeletonOptimisticProjectionPort<
    TProjection,
    TReconciliation,
    TInverseProjection
  >;
}

/** Read-only recipe and retention queries over canonical engine state. */
export class SpatialSkeletonOptimisticEngineHistory<
  TInput,
  THistoryTicket,
  TWorkflow,
  TProjection,
  TMutation,
  TResult,
  TReconciliation,
  TInverseProjection,
> {
  constructor(
    private readonly options: SpatialSkeletonOptimisticEngineHistoryOptions<
      TInput,
      THistoryTicket,
      TWorkflow,
      TProjection,
      TMutation,
      TResult,
      TReconciliation,
      TInverseProjection
    >,
  ) {}

  getQueuedOppositeTarget(
    intent: SpatialSkeletonIntentKind,
    historyEntryId: string | number,
    dependencySequences: readonly number[],
  ) {
    if (intent === "execute") return undefined;
    for (const dependencyId of [...dependencySequences].reverse()) {
      const dependency = this.options.journal.get(dependencyId);
      if (
        dependency !== undefined &&
        !dependency.terminal &&
        dependency.lifecycle.authority === "queued" &&
        dependency.metadata.historyEntryId === historyEntryId &&
        dependency.kind !== intent &&
        !this.hasUnresolvedSameEntryDependency(dependency.sequence)
      ) {
        return dependency.sequence;
      }
    }
    return undefined;
  }

  getProjectedQueuedOppositeTarget(intent: "undo" | "redo") {
    const historyEntryId = this.options.history.getProjectedEntryId(intent);
    if (historyEntryId === undefined) return undefined;
    return this.options.journal
      .getEntries({ includeTerminal: false })
      .reverse()
      .find(
        (entry) =>
          entry.metadata.historyEntryId === historyEntryId &&
          entry.kind !== intent &&
          entry.lifecycle.authority === "queued" &&
          !this.hasUnresolvedSameEntryDependency(entry.sequence),
      )?.sequence;
  }

  private hasUnresolvedSameEntryDependency(intentId: number) {
    const entry = this.options.journal.get(intentId);
    if (entry === undefined) return false;
    return this.options.journal
      .getBlockingDependencies(intentId)
      .some(
        (dependencyId) =>
          this.options.journal.get(dependencyId)?.metadata.historyEntryId ===
          entry.metadata.historyEntryId,
      );
  }

  getActivePreviewArtifacts(excludeIntentId?: number) {
    return this.options.journal
      .getEntries({ includeTerminal: false })
      .filter(
        (entry) =>
          entry.sequence !== excludeIntentId &&
          entry.lifecycle.preview === "exact",
      )
      .flatMap((entry) => this.getProjectionArtifact(entry.sequence));
  }

  getProjectionArtifacts(intentIds: readonly number[]) {
    return intentIds.flatMap((intentId) =>
      this.getProjectionArtifact(intentId),
    );
  }

  private getProjectionArtifact(
    intentId: number,
  ): readonly SpatialSkeletonProjectionIntentArtifact<
    TProjection,
    TInverseProjection
  >[] {
    const entry = this.options.journal.get(intentId);
    const projection = entry?.requestedResult.value;
    const inverseProjection = entry?.inverseDelta.value;
    return projection === undefined || inverseProjection === undefined
      ? []
      : [{ intentId, projection, inverseProjection }];
  }

  getHistoryRecipeByEntryId(
    historyEntryId: string | number,
  ):
    | SpatialSkeletonProjectionHistoryRecipe<
        TWorkflow,
        TProjection,
        TInverseProjection
      >
    | undefined {
    const candidates = this.options.journal
      .getEntries()
      .filter(
        (entry) =>
          entry.metadata.historyEntryId === historyEntryId &&
          entry.requestedResult.value !== undefined,
      );
    return this.createHistoryRecipe(
      candidates.find((candidate) => candidate.kind === "execute") ??
        candidates.at(-1),
    );
  }

  getCanonicalHistoryInput(historyEntryId: string | number) {
    const candidates = this.options.journal
      .getEntries()
      .filter((entry) => entry.metadata.historyEntryId === historyEntryId);
    return (
      candidates.find((candidate) => candidate.kind === "execute") ??
      candidates.at(-1)
    )?.metadata.input;
  }

  getCanonicalInputPreparation(historyEntryId: string | number) {
    return this.options.journal
      .getEntries()
      .find(
        (entry) =>
          entry.kind === "execute" &&
          entry.metadata.historyEntryId === historyEntryId,
      )?.metadata.inputPreparation;
  }

  private createHistoryRecipe(
    entry:
      | EngineIntentRecord<
          TInput,
          TWorkflow,
          THistoryTicket,
          TProjection,
          TInverseProjection,
          TMutation,
          TResult
        >
      | undefined,
  ) {
    const projection = entry?.requestedResult.value;
    return entry === undefined ||
      projection === undefined ||
      entry.metadata.workflow === undefined
      ? undefined
      : {
          workflow: entry.metadata.workflow,
          projection,
          inverseProjection: entry.inverseDelta.value,
        };
  }

  refreshCanonicalRecipeFromRedo(
    redoEntry: EngineIntentRecord<
      TInput,
      TWorkflow,
      THistoryTicket,
      TProjection,
      TInverseProjection,
      TMutation,
      TResult
    >,
    artifact: SpatialSkeletonProjectionIntentArtifact<
      TProjection,
      TInverseProjection
    >,
  ) {
    if (redoEntry.kind !== "redo") return;
    const canonical = this.options.journal
      .getEntries()
      .find(
        (entry) =>
          entry.kind === "execute" &&
          entry.metadata.historyEntryId === redoEntry.metadata.historyEntryId,
      );
    if (canonical === undefined) {
      throw new Error(
        `History entry ${redoEntry.metadata.historyEntryId} lost its canonical Execute recipe.`,
      );
    }
    this.options.journal.refreshRetainedRecord(canonical.sequence, {
      requestedResult: { value: artifact.projection },
      inverseDelta: { value: artifact.inverseProjection },
      metadata: {
        ...canonical.metadata,
        workflow: redoEntry.metadata.workflow,
      },
    });
  }

  syncRetainedHistoryResources() {
    const retainedEntryIds = new Set(
      this.options.history.getRetainedEntryIds(),
    );
    const projections = this.options.journal
      .getEntries()
      .filter(
        (entry) =>
          entry.kind === "execute" &&
          retainedEntryIds.has(entry.metadata.historyEntryId),
      )
      .flatMap((entry) => {
        const projection = entry.requestedResult.value;
        return projection === undefined ? [] : [projection];
      });
    this.options.projection.setRetainedHistoryProjections(projections);
  }

  compactTerminalState() {
    const retainedEntryIds = new Set(
      this.options.history.getRetainedEntryIds(),
    );
    const canonicalSequences = this.options.journal
      .getEntries()
      .filter(
        (entry) =>
          entry.kind === "execute" &&
          retainedEntryIds.has(entry.metadata.historyEntryId),
      )
      .map(({ sequence }) => sequence);
    this.syncRetainedHistoryResources();
    this.options.journal.compactTerminalRecords({
      retainRecent: this.options.history.capacity,
      preserveSequences: canonicalSequences,
    });
    for (const [intentId, runtime] of this.options.runtimes) {
      if (runtime.settled.settled) this.options.runtimes.delete(intentId);
    }
  }
}
