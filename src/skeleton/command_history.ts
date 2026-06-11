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

import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export const SPATIAL_SKELETON_COMMAND_HISTORY_MAX_ENTRIES = 100;

export interface SpatialSkeletonCommandContext {
  readonly mappings: SpatialSkeletonCommandMappings;
}

export interface SpatialSkeletonCommand {
  readonly label: string;
  execute(context: SpatialSkeletonCommandContext): Promise<void>;
  undo(context: SpatialSkeletonCommandContext): Promise<void>;
  redo?(context: SpatialSkeletonCommandContext): Promise<void>;
}

interface SpatialSkeletonCommandMappingSnapshot {
  nodeIdMappings: Array<[number, number]>;
  segmentIdMappings: Array<[number, number]>;
}

function normalizeIdentifier(value: number | undefined) {
  if (value === undefined) return undefined;
  const normalizedValue = Math.round(Number(value));
  if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
    return undefined;
  }
  return normalizedValue;
}

function resolveIdentifierMapping(
  mappings: Map<number, number>,
  value: number | undefined,
) {
  let currentValue = normalizeIdentifier(value);
  if (currentValue === undefined) {
    return undefined;
  }
  const seen = new Set<number>();
  while (true) {
    const nextValue = mappings.get(currentValue);
    if (nextValue === undefined || seen.has(currentValue)) {
      return currentValue;
    }
    seen.add(currentValue);
    currentValue = nextValue;
  }
}

function findStableIdentifier(
  mappings: Map<number, number>,
  value: number | undefined,
) {
  const currentValue = normalizeIdentifier(value);
  if (currentValue === undefined) {
    return undefined;
  }
  let stableValue = currentValue;
  for (const candidate of mappings.keys()) {
    if (resolveIdentifierMapping(mappings, candidate) !== currentValue) {
      continue;
    }
    if (candidate < stableValue) {
      stableValue = candidate;
    }
  }
  return stableValue;
}

export class SpatialSkeletonCommandMappings {
  private nodeIdMappings = new Map<number, number>();
  private segmentIdMappings = new Map<number, number>();

  clear() {
    this.nodeIdMappings.clear();
    this.segmentIdMappings.clear();
  }

  cloneSnapshot(): SpatialSkeletonCommandMappingSnapshot {
    return {
      nodeIdMappings: [...this.nodeIdMappings.entries()],
      segmentIdMappings: [...this.segmentIdMappings.entries()],
    };
  }

  restoreSnapshot(snapshot: SpatialSkeletonCommandMappingSnapshot) {
    this.nodeIdMappings = new Map(snapshot.nodeIdMappings);
    this.segmentIdMappings = new Map(snapshot.segmentIdMappings);
  }

  resolveNodeId(nodeId: number | undefined) {
    return resolveIdentifierMapping(this.nodeIdMappings, nodeId);
  }

  resolveSegmentId(segmentId: number | undefined) {
    return resolveIdentifierMapping(this.segmentIdMappings, segmentId);
  }

  getStableNodeId(nodeId: number | undefined) {
    return findStableIdentifier(this.nodeIdMappings, nodeId);
  }

  getStableSegmentId(segmentId: number | undefined) {
    return findStableIdentifier(this.segmentIdMappings, segmentId);
  }

  getStableOrCurrentNodeId(nodeId: number | undefined) {
    return this.getStableNodeId(nodeId) ?? normalizeIdentifier(nodeId);
  }

  getStableOrCurrentSegmentId(segmentId: number | undefined) {
    return this.getStableSegmentId(segmentId) ?? normalizeIdentifier(segmentId);
  }

  remapNodeId(originalNodeId: number | undefined, currentNodeId: number) {
    const normalizedOriginalNodeId = normalizeIdentifier(originalNodeId);
    const normalizedCurrentNodeId = normalizeIdentifier(currentNodeId);
    if (
      normalizedOriginalNodeId === undefined ||
      normalizedCurrentNodeId === undefined
    ) {
      return false;
    }
    if (normalizedOriginalNodeId === normalizedCurrentNodeId) {
      return this.nodeIdMappings.delete(normalizedOriginalNodeId);
    }
    if (
      this.nodeIdMappings.get(normalizedOriginalNodeId) ===
      normalizedCurrentNodeId
    ) {
      return false;
    }
    this.nodeIdMappings.set(normalizedOriginalNodeId, normalizedCurrentNodeId);
    return true;
  }

  remapSegmentId(
    originalSegmentId: number | undefined,
    currentSegmentId: number,
  ) {
    const normalizedOriginalSegmentId = normalizeIdentifier(originalSegmentId);
    const normalizedCurrentSegmentId = normalizeIdentifier(currentSegmentId);
    if (
      normalizedOriginalSegmentId === undefined ||
      normalizedCurrentSegmentId === undefined
    ) {
      return false;
    }
    if (normalizedOriginalSegmentId === normalizedCurrentSegmentId) {
      return this.segmentIdMappings.delete(normalizedOriginalSegmentId);
    }
    if (
      this.segmentIdMappings.get(normalizedOriginalSegmentId) ===
      normalizedCurrentSegmentId
    ) {
      return false;
    }
    this.segmentIdMappings.set(
      normalizedOriginalSegmentId,
      normalizedCurrentSegmentId,
    );
    return true;
  }
}

interface SpatialSkeletonCommandHistoryEntry {
  readonly command: SpatialSkeletonCommand;
}

export class SpatialSkeletonCommandHistory extends RefCounted {
  readonly canUndo = new WatchableValue(false);
  readonly canRedo = new WatchableValue(false);
  readonly isBusy = new WatchableValue(false);
  readonly undoLabel = new WatchableValue<string | undefined>(undefined);
  readonly redoLabel = new WatchableValue<string | undefined>(undefined);
  readonly mappings = new SpatialSkeletonCommandMappings();

  private undoEntries: SpatialSkeletonCommandHistoryEntry[] = [];
  private redoEntries: SpatialSkeletonCommandHistoryEntry[] = [];
  private operationQueue = Promise.resolve();
  private pendingOperations = 0;
  private source: unknown;
  private readonly maxEntries = SPATIAL_SKELETON_COMMAND_HISTORY_MAX_ENTRIES;

  private updateState() {
    const canUndo = this.undoEntries.length > 0;
    const canRedo = this.redoEntries.length > 0;
    const undoLabel = this.undoEntries.at(-1)?.command.label;
    const redoLabel = this.redoEntries.at(-1)?.command.label;
    if (this.canUndo.value !== canUndo) {
      this.canUndo.value = canUndo;
    }
    if (this.canRedo.value !== canRedo) {
      this.canRedo.value = canRedo;
    }
    if (this.undoLabel.value !== undoLabel) {
      this.undoLabel.value = undoLabel;
    }
    if (this.redoLabel.value !== redoLabel) {
      this.redoLabel.value = redoLabel;
    }
  }

  private async runOperation<T>(operation: () => Promise<T>) {
    const previousOperation = this.operationQueue.catch(() => undefined);
    const startsImmediately = this.pendingOperations === 0;
    this.pendingOperations += 1;
    if (!this.isBusy.value) {
      this.isBusy.value = true;
    }
    const run = async () => {
      try {
        return await operation();
      } finally {
        this.pendingOperations -= 1;
        if (this.pendingOperations === 0 && this.isBusy.value) {
          this.isBusy.value = false;
        }
        this.updateState();
      }
    };
    const result = startsImmediately ? run() : previousOperation.then(run);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private trimUndoEntries() {
    if (this.undoEntries.length <= this.maxEntries) {
      return;
    }
    this.undoEntries.splice(0, this.undoEntries.length - this.maxEntries);
  }

  clear() {
    this.undoEntries = [];
    this.redoEntries = [];
    this.mappings.clear();
    this.updateState();
  }

  setSource(source: unknown) {
    if (this.source === source) {
      return false;
    }
    this.source = source;
    this.clear();
    return true;
  }

  execute(command: SpatialSkeletonCommand) {
    return this.runOperation(async () => {
      const mappingSnapshot = this.mappings.cloneSnapshot();
      try {
        await command.execute({ mappings: this.mappings });
      } catch (error) {
        this.mappings.restoreSnapshot(mappingSnapshot);
        throw error;
      }
      this.redoEntries = [];
      this.undoEntries.push({ command });
      this.trimUndoEntries();
    });
  }

  undo() {
    return this.runOperation(async () => {
      const entry = this.undoEntries.at(-1);
      if (entry === undefined) {
        return false;
      }
      const mappingSnapshot = this.mappings.cloneSnapshot();
      try {
        await entry.command.undo({ mappings: this.mappings });
      } catch (error) {
        this.mappings.restoreSnapshot(mappingSnapshot);
        throw error;
      }
      this.undoEntries.pop();
      this.redoEntries.push(entry);
      return true;
    });
  }

  redo() {
    return this.runOperation(async () => {
      const entry = this.redoEntries.at(-1);
      if (entry === undefined) {
        return false;
      }
      const mappingSnapshot = this.mappings.cloneSnapshot();
      try {
        if (entry.command.redo !== undefined) {
          await entry.command.redo({ mappings: this.mappings });
        } else {
          await entry.command.execute({ mappings: this.mappings });
        }
      } catch (error) {
        this.mappings.restoreSnapshot(mappingSnapshot);
        throw error;
      }
      this.redoEntries.pop();
      this.undoEntries.push(entry);
      this.trimUndoEntries();
      return true;
    });
  }
}
