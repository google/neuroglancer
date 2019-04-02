/**
 * @license
 * Copyright 2016 Google Inc.
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

export enum ChunkState {
  // Chunk is stored in GPU memory in addition to system memory.
  GPU_MEMORY = 0,
  // Chunk is stored only in system memory but not in GPU memory.
  SYSTEM_MEMORY = 1,

  // Chunk is stored in system memory on worker.
  SYSTEM_MEMORY_WORKER = 2,

  // Chunk is downloading.
  DOWNLOADING = 3,
  // Chunk is not yet downloading.
  QUEUED = 4,

  // Chunk has just been added.
  NEW = 5,

  // Download failed.
  FAILED = 6,

  EXPIRED = 7,

  COMPUTING = 8,
}

export const numChunkStates = 9;

export enum ChunkPriorityTier {
  FIRST_TIER = 0,
  FIRST_ORDERED_TIER = 0,
  VISIBLE = 0,
  PREFETCH = 1,
  LAST_ORDERED_TIER = 1,
  RECENT = 2,
  LAST_TIER = 2
}

export const numChunkPriorityTiers = 3;

export enum ChunkDownloadStatistics {
  totalTime = 0,
  totalChunks = 1,
}

export enum ChunkMemoryStatistics {
  numChunks = 0,
  systemMemoryBytes = 1,
  gpuMemoryBytes = 2,
}

export const numChunkMemoryStatistics = 3;

export const numChunkDownloadStatistics = 2;

export const numChunkStatistics =
    numChunkStates * numChunkPriorityTiers * numChunkMemoryStatistics + numChunkDownloadStatistics;

export function getChunkStateStatisticIndex(state: ChunkState, priorityTier: ChunkPriorityTier) {
  return state * numChunkPriorityTiers + priorityTier;
}

export function getChunkDownloadStatisticIndex(statistic: ChunkDownloadStatistics) {
  return numChunkStates * numChunkPriorityTiers * numChunkMemoryStatistics + statistic;
}

export const PREFETCH_PRIORITY_MULTIPLIER = 1e13;

export const CHUNK_QUEUE_MANAGER_RPC_ID = 'ChunkQueueManager';
export const CHUNK_MANAGER_RPC_ID = 'ChunkManager';
export const CHUNK_SOURCE_INVALIDATE_RPC_ID = 'ChunkSource.invalidate';

export const REQUEST_CHUNK_STATISTICS_RPC_ID = 'ChunkQueueManager.requestChunkStatistics';

export interface ChunkSourceParametersConstructor<T> {
  new(): T;
  RPC_ID: string;
}
