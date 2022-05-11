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

import throttle from 'lodash/throttle';
import {CHUNK_LAYER_STATISTICS_RPC_ID, CHUNK_MANAGER_RPC_ID, CHUNK_QUEUE_MANAGER_RPC_ID, CHUNK_SOURCE_INVALIDATE_RPC_ID, ChunkDownloadStatistics, ChunkMemoryStatistics, ChunkPriorityTier, LayerChunkProgressInfo, ChunkSourceParametersConstructor, ChunkState, getChunkDownloadStatisticIndex, getChunkStateStatisticIndex, numChunkMemoryStatistics, numChunkStatistics, REQUEST_CHUNK_STATISTICS_RPC_ID} from 'neuroglancer/chunk_manager/base';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {TypedArray} from 'neuroglancer/util/array';
import {CancellationToken, CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {Disposable, RefCounted} from 'neuroglancer/util/disposable';
import {Borrowed} from 'neuroglancer/util/disposable';
import {LinkedListOperations} from 'neuroglancer/util/linked_list';
import LinkedList0 from 'neuroglancer/util/linked_list.0';
import LinkedList1 from 'neuroglancer/util/linked_list.1';
import {StringMemoize} from 'neuroglancer/util/memoize';
import {ComparisonFunction, PairingHeapOperations} from 'neuroglancer/util/pairing_heap';
import PairingHeap0 from 'neuroglancer/util/pairing_heap.0';
import PairingHeap1 from 'neuroglancer/util/pairing_heap.1';
import {NullarySignal} from 'neuroglancer/util/signal';
import {initializeSharedObjectCounterpart, registerPromiseRPC, registerRPC, registerSharedObject, registerSharedObjectOwner, RPC, SharedObject, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const DEBUG_CHUNK_UPDATES = false;

export interface ChunkStateListener {
  stateChanged(chunk: Chunk, oldState: ChunkState): void;
}

let nextMarkGeneration = 0;
export function getNextMarkGeneration() {
  return ++nextMarkGeneration;
}

export class Chunk implements Disposable {
  // Node properties used for eviction/promotion heaps and LRU linked lists.
  child0: Chunk|null = null;
  next0: Chunk|null = null;
  prev0: Chunk|null = null;
  child1: Chunk|null = null;
  next1: Chunk|null = null;
  prev1: Chunk|null = null;

  source: ChunkSource|null = null;

  key: string|null = null;

  private state_ = ChunkState.NEW;

  error: any = null;

  // Used by layers for marking chunks for various purposes.
  markGeneration = -1;

  /**
   * Specifies existing priority within priority tier.  Only meaningful if priorityTier in
   * CHUNK_ORDERED_PRIORITY_TIERS.  Higher numbers mean higher priority.
   */
  priority = 0;

  /**
   * Specifies updated priority within priority tier, not yet reflected in priority queue state.
   * Only meaningful if newPriorityTier in CHUNK_ORDERED_PRIORITY_TIERS.
   */
  newPriority = 0;

  priorityTier = ChunkPriorityTier.RECENT;

  /**
   * Specifies updated priority tier, not yet reflected in priority queue state.
   */
  newPriorityTier = ChunkPriorityTier.RECENT;

  private systemMemoryBytes_: number = 0;
  private gpuMemoryBytes_: number = 0;
  private downloadSlots_: number = 1;
  backendOnly = false;
  isComputational = false;
  newlyRequestedToFrontend = false;
  requestedToFrontend = false;

  /**
   * Cancellation token used to cancel the pending download.  Set to undefined except when state !==
   * DOWNLOADING.  This should not be accessed by code outside this module.
   */
  downloadCancellationToken: CancellationTokenSource|undefined = undefined;

  initialize(key: string) {
    this.key = key;
    this.priority = Number.NEGATIVE_INFINITY;
    this.priorityTier = ChunkPriorityTier.RECENT;
    this.newPriority = Number.NEGATIVE_INFINITY;
    this.newPriorityTier = ChunkPriorityTier.RECENT;
    this.error = null;
    this.state = ChunkState.NEW;
    this.requestedToFrontend = false;
    this.newlyRequestedToFrontend = false;
  }

  /**
   * Sets this.priority{Tier,} to this.newPriority{Tier,}, and resets this.newPriorityTier to
   * ChunkPriorityTier.RECENT.
   *
   * This does not actually update any queues to reflect this change.
   */
  updatePriorityProperties() {
    this.priorityTier = this.newPriorityTier;
    this.priority = this.newPriority;
    this.newPriorityTier = ChunkPriorityTier.RECENT;
    this.newPriority = Number.NEGATIVE_INFINITY;
    this.requestedToFrontend = this.newlyRequestedToFrontend;
  }

  dispose() {
    this.source = null;
    this.error = null;
  }

  get chunkManager() {
    return (<ChunkSource>this.source).chunkManager;
  }

  get queueManager() {
    return (<ChunkSource>this.source).chunkManager.queueManager;
  }

  downloadFailed(error: any) {
    this.error = error;
    this.queueManager.updateChunkState(this, ChunkState.FAILED);
  }

  downloadSucceeded() {
    this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY_WORKER);
  }

  freeSystemMemory() {}

  serialize(msg: any, _transfers: any[]) {
    msg['id'] = this.key;
    msg['source'] = (<ChunkSource>this.source).rpcId;
    msg['new'] = true;
  }

  toString() {
    return this.key;
  }

  set state(newState: ChunkState) {
    if (newState === this.state_) {
      return;
    }
    const oldState = this.state_;
    this.state_ = newState;
    this.source!.chunkStateChanged(this, oldState);
  }

  get state() {
    return this.state_;
  }

  set systemMemoryBytes(bytes: number) {
    updateChunkStatistics(this, -1);
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, false);
    this.systemMemoryBytes_ = bytes;
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, true);
    updateChunkStatistics(this, 1);
    this.chunkManager.queueManager.scheduleUpdate();
  }

  get systemMemoryBytes() {
    return this.systemMemoryBytes_;
  }

  set gpuMemoryBytes(bytes: number) {
    updateChunkStatistics(this, -1);
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, false);
    this.gpuMemoryBytes_ = bytes;
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, true);
    updateChunkStatistics(this, 1);
    this.chunkManager.queueManager.scheduleUpdate();
  }

  get gpuMemoryBytes() {
    return this.gpuMemoryBytes_;
  }

  get downloadSlots() {
    return this.downloadSlots_;
  }

  set downloadSlots(count: number) {
    if (count === this.downloadSlots_) return;
    updateChunkStatistics(this, -1);
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, false);
    this.downloadSlots_ = count;
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, true);
    updateChunkStatistics(this, 1);
    this.chunkManager.queueManager.scheduleUpdate();
  }

  registerListener(listener: ChunkStateListener) {
    if (!this.source) {
      return false;
    }
    return this.source.registerChunkListener(this.key!, listener);
  }

  unregisterListener(listener: ChunkStateListener) {
    if (!this.source) {
      return false;
    }
    return this.source.unregisterChunkListener(this.key!, listener);
  }

  static priorityLess(a: Chunk, b: Chunk) {
    return a.priority < b.priority;
  }

  static priorityGreater(a: Chunk, b: Chunk) {
    return a.priority > b.priority;
  }
}

export interface ChunkConstructor<T extends Chunk> {
  new(): T;
}

const numSourceQueueLevels = 2;

/**
 * Base class inherited by both ChunkSource, for implementing the backend part of chunk sources that
 * also have a frontend-part, as well as other chunk sources, such as the GenericFileSource, that
 * has only a backend part.
 */
export class ChunkSourceBase extends SharedObject {
  private listeners_ = new Map<string, ChunkStateListener[]>();
  chunks: Map<string, Chunk> = new Map<string, Chunk>();
  freeChunks: Chunk[] = new Array<Chunk>();
  statistics = new Float64Array(numChunkStatistics);

  /**
   * sourceQueueLevel must be greater than the sourceQueueLevel of any ChunkSource whose download
   * method depends on chunks from this source.  A normal ChunkSource with no other dependencies
   * should have a level of 0.
   */
  sourceQueueLevel = 0;

  constructor(public chunkManager: Borrowed<ChunkManager>) {
    super();
    chunkManager.queueManager.sources.add(this);
  }

  disposed() {
    this.chunkManager.queueManager.sources.delete(this);
    super.disposed();
  }

  getNewChunk_<T extends Chunk>(chunkType: ChunkConstructor<T>): T {
    let freeChunks = this.freeChunks;
    let freeChunksLength = freeChunks.length;
    if (freeChunksLength > 0) {
      let chunk = <T>freeChunks[freeChunksLength - 1];
      freeChunks.length = freeChunksLength - 1;
      chunk.source = this;
      return chunk;
    }
    let chunk = new chunkType();
    chunk.source = this;
    return chunk;
  }

  /**
   * Adds the specified chunk to the chunk cache.
   *
   * If the chunk cache was previously empty, also call this.addRef() to increment the reference
   * count.
   */
  addChunk(chunk: Chunk) {
    let {chunks} = this;
    if (chunks.size === 0) {
      this.addRef();
    }
    chunks.set(chunk.key!, chunk);
    updateChunkStatistics(chunk, 1);
  }

  /**
   * Remove the specified chunk from the chunk cache.
   *
   * If the chunk cache becomes empty, also call this.dispose() to decrement the reference count.
   */
  removeChunk(chunk: Chunk) {
    let {chunks, freeChunks} = this;
    chunks.delete(chunk.key!);
    chunk.dispose();
    freeChunks[freeChunks.length] = chunk;
    if (chunks.size === 0) {
      this.dispose();
    }
  }

  registerChunkListener(key: string, listener: ChunkStateListener) {
    if (!this.listeners_.has(key)) {
      this.listeners_.set(key, [listener]);
    } else {
      this.listeners_.get(key)!.push(listener);
    }
    return true;
  }

  unregisterChunkListener(key: string, listener: ChunkStateListener) {
    if (!this.listeners_.has(key)) {
      return false;
    }
    const keyListeners = this.listeners_.get(key)!;
    const idx = keyListeners.indexOf(listener);
    if (idx < 0) {
      return false;
    }
    keyListeners.splice(idx, 1);
    if (keyListeners.length === 0) {
      this.listeners_.delete(key);
    }
    return true;
  }

  chunkStateChanged(chunk: Chunk, oldState: ChunkState) {
    if (!chunk.key) {
      return;
    }
    if (!this.listeners_.has(chunk.key)) {
      return;
    }
    for (const listener of [...this.listeners_.get(chunk.key)!]) {
      listener.stateChanged(chunk, oldState);
    }
  }
}

function updateChunkStatistics(chunk: Chunk, sign: number) {
  const {statistics} = chunk.source!;
  const {systemMemoryBytes, gpuMemoryBytes} = chunk;
  const index = getChunkStateStatisticIndex(chunk.state, chunk.priorityTier);
  statistics[index * numChunkMemoryStatistics + ChunkMemoryStatistics.numChunks] += sign;
  statistics[index * numChunkMemoryStatistics + ChunkMemoryStatistics.systemMemoryBytes] +=
      sign * systemMemoryBytes;
  statistics[index * numChunkMemoryStatistics + ChunkMemoryStatistics.gpuMemoryBytes] +=
      sign * gpuMemoryBytes;
}

export interface ChunkSourceBase {
  /**
   * Begin downloading the specified the chunk.  The returned promise should resolve when the
   * downloaded data has been successfully decoded and stored in the chunk, or rejected if the
   * download or decoding fails.
   *
   * Note: This method must be defined by subclasses.
   *
   * @param chunk Chunk to download.
   * @param cancellationToken If this token is canceled, the download/decoding should be aborted if
   * possible.
   *
   * TODO(jbms): Move this back to the class definition above and declare this abstract once mixins
   * are compatible with abstract classes.
   */
  download(chunk: Chunk, cancellationToken: CancellationToken): Promise<void>;
}

export class ChunkSource extends ChunkSourceBase {
  constructor(rpc: RPC, options: any) {
    // No need to add a reference, since the owner counterpart will hold a reference to the owner
    // counterpart of chunkManager.
    const chunkManager = <ChunkManager>rpc.get(options['chunkManager']);
    super(chunkManager);
    initializeSharedObjectCounterpart(this, rpc, options);
  }
}

function startChunkDownload(chunk: Chunk) {
  const downloadCancellationToken = chunk.downloadCancellationToken = new CancellationTokenSource();
  const startTime = Date.now();
  chunk.source!.download(chunk, downloadCancellationToken)
      .then(
          () => {
            if (chunk.downloadCancellationToken === downloadCancellationToken) {
              chunk.downloadCancellationToken = undefined;
              const endTime = Date.now();
              const {statistics} = chunk.source!;
              statistics[getChunkDownloadStatisticIndex(ChunkDownloadStatistics.totalTime)] +=
                  (endTime - startTime);
              ++statistics[getChunkDownloadStatisticIndex(ChunkDownloadStatistics.totalChunks)];
              chunk.downloadSucceeded();
            }
          },
          (error: any) => {
            if (chunk.downloadCancellationToken === downloadCancellationToken) {
              chunk.downloadCancellationToken = undefined;
              chunk.downloadFailed(error);
              console.log(`Error retrieving chunk ${chunk}: ${error}`);
            }
          });
}

function cancelChunkDownload(chunk: Chunk) {
  const token = chunk.downloadCancellationToken!;
  chunk.downloadCancellationToken = undefined;
  token.cancel();
}

class ChunkPriorityQueue {
  /**
   * Heap roots for VISIBLE and PREFETCH priority tiers.
   */
  private heapRoots: (Chunk|null)[] = [null, null];

  /**
   * Head node for RECENT linked list.
   */
  private recentHead = new Chunk();
  constructor(
      private heapOperations: PairingHeapOperations<Chunk>,
      private linkedListOperations: LinkedListOperations<Chunk>) {
    linkedListOperations.initializeHead(this.recentHead);
  }

  add(chunk: Chunk) {
    let priorityTier = chunk.priorityTier;
    if (priorityTier === ChunkPriorityTier.RECENT) {
      this.linkedListOperations.insertAfter(this.recentHead, chunk);
    } else {
      let {heapRoots} = this;
      heapRoots[priorityTier] = this.heapOperations.meld(heapRoots[priorityTier], chunk);
    }
  }

  * candidates(): Iterator<Chunk> {
    if (this.heapOperations.compare === Chunk.priorityLess) {
      // Start with least-recently used RECENT chunk.
      let {linkedListOperations, recentHead} = this;
      while (true) {
        let chunk = linkedListOperations.back(recentHead);
        if (chunk == null) {
          break;
        } else {
          yield chunk;
        }
      }
      let {heapRoots} = this;
      for (let tier = ChunkPriorityTier.LAST_ORDERED_TIER;
           tier >= ChunkPriorityTier.FIRST_ORDERED_TIER; --tier) {
        while (true) {
          let root = heapRoots[tier];
          if (root == null) {
            break;
          } else {
            yield root;
          }
        }
      }
    } else {
      let heapRoots = this.heapRoots;
      for (let tier = ChunkPriorityTier.FIRST_ORDERED_TIER;
           tier <= ChunkPriorityTier.LAST_ORDERED_TIER; ++tier) {
        while (true) {
          let root = heapRoots[tier];
          if (root == null) {
            break;
          } else {
            yield root;
          }
        }
      }
      let {linkedListOperations, recentHead} = this;
      while (true) {
        let chunk = linkedListOperations.front(recentHead);
        if (chunk == null) {
          break;
        } else {
          yield chunk;
        }
      }
    }
  }

  /**
   * Deletes a chunk from this priority queue.
   * @param chunk The chunk to delete from the priority queue.
   */
  delete(chunk: Chunk) {
    let priorityTier = chunk.priorityTier;
    if (priorityTier === ChunkPriorityTier.RECENT) {
      this.linkedListOperations.pop(chunk);
    } else {
      let heapRoots = this.heapRoots;
      heapRoots[priorityTier] = this.heapOperations.remove(<Chunk>heapRoots[priorityTier], chunk);
    }
  }
}

function makeChunkPriorityQueue0(compare: ComparisonFunction<Chunk>) {
  return new ChunkPriorityQueue(new PairingHeap0(compare), LinkedList0);
}

function makeChunkPriorityQueue1(compare: ComparisonFunction<Chunk>) {
  return new ChunkPriorityQueue(new PairingHeap1(compare), LinkedList1);
}

function tryToFreeCapacity(
    size: number, capacity: AvailableCapacity, priorityTier: ChunkPriorityTier, priority: number,
    evictionCandidates: Iterator<Chunk>, evict: (chunk: Chunk) => void) {
  while (capacity.availableItems < 1 || capacity.availableSize < size) {
    let evictionCandidate = evictionCandidates.next().value;
    if (evictionCandidate === undefined) {
      // No eviction candidates available, promotions are done.
      return false;
    } else {
      let evictionTier = evictionCandidate.priorityTier;
      if (evictionTier < priorityTier ||
          (evictionTier === priorityTier && evictionCandidate.priority >= priority)) {
        // Lowest priority eviction candidate has priority >= highest
        // priority promotion candidate.  No more promotions are
        // possible.
        return false;
      }
      evict(evictionCandidate);
    }
  }
  return true;
}

class AvailableCapacity extends RefCounted {
  currentSize: number = 0;
  currentItems: number = 0;

  capacityChanged = new NullarySignal();

  constructor(
      public itemLimit: Borrowed<SharedWatchableValue<number>>,
      public sizeLimit: Borrowed<SharedWatchableValue<number>>) {
    super();
    this.registerDisposer(itemLimit.changed.add(this.capacityChanged.dispatch));
    this.registerDisposer(sizeLimit.changed.add(this.capacityChanged.dispatch));
  }

  /**
   * Adjust available capacity by the specified amounts.
   */
  adjust(items: number, size: number) {
    this.currentItems -= items;
    this.currentSize -= size;
  }

  get availableSize() {
    return this.sizeLimit.value - this.currentSize;
  }
  get availableItems() {
    return this.itemLimit.value - this.currentItems;
  }

  toString() {
    return `bytes=${this.currentSize}/${this.sizeLimit.value},` +
        `items=${this.currentItems}/${this.itemLimit.value}`;
  }
}

@registerSharedObject(CHUNK_QUEUE_MANAGER_RPC_ID)
export class ChunkQueueManager extends SharedObjectCounterpart {
  gpuMemoryCapacity: AvailableCapacity;
  systemMemoryCapacity: AvailableCapacity;

  /**
   * Download capacity for each sourceQueueLevel.
   */
  downloadCapacity: AvailableCapacity[];
  computeCapacity: AvailableCapacity;

  enablePrefetch: SharedWatchableValue<boolean>;

  /**
   * Set of chunk sources associated with this queue manager.
   */
  sources = new Set<Borrowed<ChunkSource>>();

  /**
   * Contains all chunks in QUEUED state pending download, for each sourceQueueLevel.
   */
  private queuedDownloadPromotionQueue = [
    makeChunkPriorityQueue1(Chunk.priorityGreater),
    makeChunkPriorityQueue1(Chunk.priorityGreater),
  ];

  /**
   * Contains all chunks in QUEUED state pending compute.
   */
  private queuedComputePromotionQueue = makeChunkPriorityQueue1(Chunk.priorityGreater);

  /**
   * Contains all chunks in DOWNLOADING state, for each sourceQueueLevel.
   */
  private downloadEvictionQueue = [
    makeChunkPriorityQueue1(Chunk.priorityLess),
    makeChunkPriorityQueue1(Chunk.priorityLess),
  ];

  /**
   * Contains all chunks in COMPUTING state.
   */
  private computeEvictionQueue = makeChunkPriorityQueue1(Chunk.priorityLess);

  /**
   * Contains all chunks that take up memory (DOWNLOADING, SYSTEM_MEMORY,
   * GPU_MEMORY).
   */
  private systemMemoryEvictionQueue = makeChunkPriorityQueue0(Chunk.priorityLess);

  /**
   * Contains all chunks in SYSTEM_MEMORY state not in RECENT priority tier.
   */
  private gpuMemoryPromotionQueue = makeChunkPriorityQueue1(Chunk.priorityGreater);

  /**
   * Contains all chunks in GPU_MEMORY state.
   */
  private gpuMemoryEvictionQueue = makeChunkPriorityQueue1(Chunk.priorityLess);

  // Should be `number|null`, but marked `any` to work around @types/node being pulled in.
  private updatePending: any = null;

  gpuMemoryChanged = new NullarySignal();

  private numQueued = 0;
  private numFailed = 0;
  private gpuMemoryGeneration = 0;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const getCapacity = (capacity: any) => {
      const result = this.registerDisposer(
          new AvailableCapacity(rpc.get(capacity['itemLimit']), rpc.get(capacity['sizeLimit'])));
      result.capacityChanged.add(() => this.scheduleUpdate());
      return result;
    };
    this.gpuMemoryCapacity = getCapacity(options['gpuMemoryCapacity']);
    this.systemMemoryCapacity = getCapacity(options['systemMemoryCapacity']);
    this.enablePrefetch = rpc.get(options['enablePrefetch']);
    this.downloadCapacity = [
      getCapacity(options['downloadCapacity']),
      getCapacity(options['downloadCapacity']),
    ];
    this.computeCapacity = getCapacity(options['computeCapacity']);
  }

  scheduleUpdate() {
    if (this.updatePending === null) {
      this.updatePending = setTimeout(this.process.bind(this), 0);
    }
  }

  * chunkQueuesForChunk(chunk: Chunk) {
    switch (chunk.state) {
      case ChunkState.QUEUED:
        if (chunk.isComputational) {
          yield this.queuedComputePromotionQueue;
        } else {
          yield this.queuedDownloadPromotionQueue[chunk.source!.sourceQueueLevel];
        }
        break;

      case ChunkState.DOWNLOADING:
        if (chunk.isComputational) {
          yield this.computeEvictionQueue;
        } else {
          yield this.downloadEvictionQueue[chunk.source!.sourceQueueLevel];
          yield this.systemMemoryEvictionQueue;
        }
        break;

      case ChunkState.SYSTEM_MEMORY_WORKER:
      case ChunkState.SYSTEM_MEMORY:
        yield this.systemMemoryEvictionQueue;
        if (chunk.priorityTier !== ChunkPriorityTier.RECENT && !chunk.backendOnly &&
            chunk.requestedToFrontend) {
          yield this.gpuMemoryPromotionQueue;
        }
        break;

      case ChunkState.GPU_MEMORY:
        yield this.systemMemoryEvictionQueue;
        yield this.gpuMemoryEvictionQueue;
        break;
    }
  }

  adjustCapacitiesForChunk(chunk: Chunk, add: boolean) {
    let factor = add ? -1 : 1;
    switch (chunk.state) {
      case ChunkState.FAILED:
        this.numFailed -= factor;
        break;

      case ChunkState.QUEUED:
        this.numQueued -= factor;
        break;

      case ChunkState.DOWNLOADING:
        (chunk.isComputational ? this.computeCapacity :
                                 this.downloadCapacity[chunk.source!.sourceQueueLevel])
            .adjust(factor * chunk.downloadSlots, factor * chunk.systemMemoryBytes);
        this.systemMemoryCapacity.adjust(factor, factor * chunk.systemMemoryBytes);
        break;

      case ChunkState.SYSTEM_MEMORY:
      case ChunkState.SYSTEM_MEMORY_WORKER:
        this.systemMemoryCapacity.adjust(factor, factor * chunk.systemMemoryBytes);
        break;

      case ChunkState.GPU_MEMORY:
        this.systemMemoryCapacity.adjust(factor, factor * chunk.systemMemoryBytes);
        this.gpuMemoryCapacity.adjust(factor, factor * chunk.gpuMemoryBytes);
        break;
    }
  }

  private removeChunkFromQueues_(chunk: Chunk) {
    updateChunkStatistics(chunk, -1);
    for (let queue of this.chunkQueuesForChunk(chunk)) {
      queue.delete(chunk);
    }
  }

  // var freedChunks = 0;
  private addChunkToQueues_(chunk: Chunk) {
    if (chunk.state === ChunkState.QUEUED && chunk.priorityTier === ChunkPriorityTier.RECENT) {
      // Delete this chunk.
      let {source} = chunk;
      source!.removeChunk(chunk);
      this.adjustCapacitiesForChunk(chunk, false);
      return false;
    } else {
      updateChunkStatistics(chunk, 1);
      for (let queue of this.chunkQueuesForChunk(chunk)) {
        queue.add(chunk);
      }
      return true;
    }
  }

  performChunkPriorityUpdate(chunk: Chunk) {
    if (chunk.priorityTier === chunk.newPriorityTier && chunk.priority === chunk.newPriority) {
      chunk.newPriorityTier = ChunkPriorityTier.RECENT;
      chunk.newPriority = Number.NEGATIVE_INFINITY;
      return;
    }
    if (DEBUG_CHUNK_UPDATES) {
      console.log(
          `${chunk}: changed priority ${chunk.priorityTier}:` +
          `${chunk.priority} -> ${chunk.newPriorityTier}:${chunk.newPriority}`);
    }
    this.removeChunkFromQueues_(chunk);
    chunk.updatePriorityProperties();
    if (chunk.state === ChunkState.NEW) {
      chunk.state = ChunkState.QUEUED;
      this.adjustCapacitiesForChunk(chunk, true);
    }
    this.addChunkToQueues_(chunk);
  }

  updateChunkState(chunk: Chunk, newState: ChunkState) {
    if (newState === chunk.state) {
      return;
    }
    if (DEBUG_CHUNK_UPDATES) {
      console.log(`${chunk}: changed state ${ChunkState[chunk.state]} -> ${ChunkState[newState]}`);
    }
    this.adjustCapacitiesForChunk(chunk, false);
    this.removeChunkFromQueues_(chunk);
    chunk.state = newState;
    this.adjustCapacitiesForChunk(chunk, true);
    this.addChunkToQueues_(chunk);
    this.scheduleUpdate();
  }

  private processGPUPromotions_() {
    let queueManager = this;
    function evictFromGPUMemory(chunk: Chunk) {
      queueManager.freeChunkGPUMemory(chunk);
      chunk.source!.chunkManager.queueManager.updateChunkState(chunk, ChunkState.SYSTEM_MEMORY);
    }
    let promotionCandidates = this.gpuMemoryPromotionQueue.candidates();
    let evictionCandidates = this.gpuMemoryEvictionQueue.candidates();
    let capacity = this.gpuMemoryCapacity;
    while (true) {
      let promotionCandidate = promotionCandidates.next().value;
      if (promotionCandidate === undefined) {
        break;
      } else {
        let priorityTier = promotionCandidate.priorityTier;
        let priority = promotionCandidate.priority;
        if (!tryToFreeCapacity(
                promotionCandidate.gpuMemoryBytes, capacity, priorityTier, priority,
                evictionCandidates, evictFromGPUMemory)) {
          break;
        }
        this.copyChunkToGPU(promotionCandidate);
        this.updateChunkState(promotionCandidate, ChunkState.GPU_MEMORY);
      }
    }
  }

  freeChunkGPUMemory(chunk: Chunk) {
    ++this.gpuMemoryGeneration;
    this.rpc!.invoke(
        'Chunk.update',
        {'id': chunk.key, 'state': ChunkState.SYSTEM_MEMORY, 'source': chunk.source!.rpcId});
  }

  freeChunkSystemMemory(chunk: Chunk) {
    if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
      chunk.freeSystemMemory();
    } else {
      this.rpc!.invoke(
          'Chunk.update',
          {'id': chunk.key, 'state': ChunkState.EXPIRED, 'source': chunk.source!.rpcId});
    }
  }

  retrieveChunkData(chunk: Chunk) {
    return this.rpc!.promiseInvoke<TypedArray>(
        'Chunk.retrieve', {key: chunk.key!, source: chunk.source!.rpcId});
  }

  copyChunkToGPU(chunk: Chunk) {
    ++this.gpuMemoryGeneration;
    let rpc = this.rpc!;
    if (chunk.state === ChunkState.SYSTEM_MEMORY) {
      rpc.invoke(
          'Chunk.update',
          {'id': chunk.key, 'source': chunk.source!.rpcId, 'state': ChunkState.GPU_MEMORY});
    } else {
      let msg: any = {};
      let transfers: any[] = [];
      chunk.serialize(msg, transfers);
      msg['state'] = ChunkState.GPU_MEMORY;
      rpc.invoke('Chunk.update', msg, transfers);
    }
  }

  private processQueuePromotions_() {
    let queueManager = this;
    const evict = (chunk: Chunk) => {
      switch (chunk.state) {
        case ChunkState.DOWNLOADING:
          cancelChunkDownload(chunk);
          break;
        case ChunkState.GPU_MEMORY:
          queueManager.freeChunkGPUMemory(chunk);
        case ChunkState.SYSTEM_MEMORY_WORKER:
        case ChunkState.SYSTEM_MEMORY:
          queueManager.freeChunkSystemMemory(chunk);
          break;
      }
      // Note: After calling this, chunk may no longer be valid.
      this.updateChunkState(chunk, ChunkState.QUEUED);
    };

    const promotionLambda =
        (promotionCandidates: Iterator<Chunk>, evictionCandidates: Iterator<Chunk>,
         capacity: AvailableCapacity) => {
          let systemMemoryEvictionCandidates = this.systemMemoryEvictionQueue.candidates();
          let systemMemoryCapacity = this.systemMemoryCapacity;
          while (true) {
            let promotionCandidateResult = promotionCandidates.next();
            if (promotionCandidateResult.done) {
              return;
            }
            let promotionCandidate = promotionCandidateResult.value;
            const size = 0; /* unknown size, since it hasn't been downloaded yet. */
            let priorityTier = promotionCandidate.priorityTier;
            let priority = promotionCandidate.priority;
            // console.log("Download capacity: " + downloadCapacity);
            if (!tryToFreeCapacity(
                    size, capacity, priorityTier, priority, evictionCandidates, evict)) {
              return;
            }
            if (!tryToFreeCapacity(
                    size, systemMemoryCapacity, priorityTier, priority,
                    systemMemoryEvictionCandidates, evict)) {
              return;
            }
            this.updateChunkState(promotionCandidate, ChunkState.DOWNLOADING);
            startChunkDownload(promotionCandidate);
          }
        };

    for (let sourceQueueLevel = 0; sourceQueueLevel < numSourceQueueLevels; ++sourceQueueLevel) {
      promotionLambda(
          this.queuedDownloadPromotionQueue[sourceQueueLevel].candidates(),
          this.downloadEvictionQueue[sourceQueueLevel].candidates(),
          this.downloadCapacity[sourceQueueLevel]);
    }
    promotionLambda(
        this.queuedComputePromotionQueue.candidates(), this.computeEvictionQueue.candidates(),
        this.computeCapacity);
  }

  process() {
    if (!this.updatePending) {
      return;
    }
    this.updatePending = null;
    const gpuMemoryGeneration = this.gpuMemoryGeneration;
    this.processGPUPromotions_();
    this.processQueuePromotions_();
    this.logStatistics();
    if (this.gpuMemoryGeneration !== gpuMemoryGeneration) {
      this.gpuMemoryChanged.dispatch();
    }
  }

  logStatistics() {
    if (DEBUG_CHUNK_UPDATES) {
      console.log(
          `[Chunk status] QUEUED: ${this.numQueued}, FAILED: ` +
          `${this.numFailed}, DOWNLOAD: ${this.downloadCapacity}, ` +
          `MEM: ${this.systemMemoryCapacity}, GPU: ${this.gpuMemoryCapacity}`);
    }
  }

  invalidateSourceCache(source: ChunkSource) {
    for (const chunk of source.chunks.values()) {
      switch (chunk.state) {
        case ChunkState.DOWNLOADING:
          cancelChunkDownload(chunk);
          break;
        case ChunkState.SYSTEM_MEMORY_WORKER:
          chunk.freeSystemMemory();
          break;
      }
      // Note: After calling this, chunk may no longer be valid.
      this.updateChunkState(chunk, ChunkState.QUEUED);
    }
    this.rpc!.invoke('Chunk.update', {'source': source.rpcId});
    this.scheduleUpdate();
  }
}

export class ChunkRenderLayerBackend extends SharedObjectCounterpart implements LayerChunkProgressInfo {
  chunkManagerGeneration: number = -1;

  numVisibleChunksNeeded: number = 0;
  numVisibleChunksAvailable: number = 0;
  numPrefetchChunksNeeded: number = 0;
  numPrefetchChunksAvailable: number = 0;
}

const LAYER_CHUNK_STATISTICS_INTERVAL = 200;

@registerSharedObject(CHUNK_MANAGER_RPC_ID)
export class ChunkManager extends SharedObjectCounterpart {
  queueManager: ChunkQueueManager;

  /**
   * Array of chunks within each existing priority tier.
   */
  private existingTierChunks: Chunk[][] = [];

  /**
   * Array of chunks whose new priorities have not yet been reflected in the
   * queue states.
   */
  private newTierChunks: Chunk[] = [];

  // Should be `number|null`, but marked `any` to workaround `@types/node` being pulled in.
  private updatePending: any = null;

  recomputeChunkPriorities = new NullarySignal();

  /**
   * Dispatched immediately after recomputeChunkPriorities is dispatched.
   * This signal should be used for handlers that depend on the result of another handler.
   */
  recomputeChunkPrioritiesLate = new NullarySignal();

  memoize = new StringMemoize();

  layers: ChunkRenderLayerBackend[] = [];

  private sendLayerChunkStatistics = this.registerCancellable(throttle(() => {
    this.rpc!.invoke(CHUNK_LAYER_STATISTICS_RPC_ID, {
      id: this.rpcId,
      layers: this.layers.map(layer => ({
                                id: layer.rpcId,
                                numVisibleChunksAvailable: layer.numVisibleChunksAvailable,
                                numVisibleChunksNeeded: layer.numVisibleChunksNeeded,
                                numPrefetchChunksAvailable: layer.numPrefetchChunksAvailable,
                                numPrefetchChunksNeeded: layer.numPrefetchChunksNeeded
                              }))
    });
  }, LAYER_CHUNK_STATISTICS_INTERVAL));

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.queueManager = (<ChunkQueueManager>rpc.get(options['chunkQueueManager'])).addRef();

    // Update chunk priorities periodically after GPU memory changes to ensure layer chunk
    // statistics are updated.
    this.registerDisposer(this.queueManager.gpuMemoryChanged.add(this.registerCancellable(throttle(
        () => this.scheduleUpdateChunkPriorities(), LAYER_CHUNK_STATISTICS_INTERVAL,
        {leading: false, trailing: true}))));

    for (let tier = ChunkPriorityTier.FIRST_TIER; tier <= ChunkPriorityTier.LAST_TIER; ++tier) {
      if (tier === ChunkPriorityTier.RECENT) {
        continue;
      }
      this.existingTierChunks[tier] = [];
    }
  }

  scheduleUpdateChunkPriorities() {
    if (this.updatePending === null) {
      this.updatePending = setTimeout(this.recomputeChunkPriorities_.bind(this), 0);
    }
  }

  registerLayer(layer: ChunkRenderLayerBackend) {
    const generation = this.recomputeChunkPriorities.count;
    if (layer.chunkManagerGeneration !== generation) {
      layer.chunkManagerGeneration = generation;
      this.layers.push(layer);
      layer.numVisibleChunksAvailable = 0;
      layer.numVisibleChunksNeeded = 0;
      layer.numPrefetchChunksAvailable = 0;
      layer.numPrefetchChunksNeeded = 0;
    }
  }

  private recomputeChunkPriorities_() {
    this.updatePending = null;
    this.layers.length = 0;
    this.recomputeChunkPriorities.dispatch();
    this.recomputeChunkPrioritiesLate.dispatch();
    this.updateQueueState([ChunkPriorityTier.VISIBLE, ChunkPriorityTier.PREFETCH]);
    this.sendLayerChunkStatistics();
  }

  /**
   * @param chunk
   * @param tier New priority tier.  Must not equal ChunkPriorityTier.RECENT.
   * @param priority Priority within tier.
   * @param toFrontend true if the chunk should be moved to the frontend when ready.
   */
  requestChunk(chunk: Chunk, tier: ChunkPriorityTier, priority: number, toFrontend = true) {
    if (!Number.isFinite(priority)) {
      // Non-finite priority indicates a bug.
      debugger;
      return;
    }
    if (tier === ChunkPriorityTier.RECENT) {
      throw new Error('Not going to request a chunk with the RECENT tier');
    }
    chunk.newlyRequestedToFrontend = chunk.newlyRequestedToFrontend || toFrontend;
    if (chunk.newPriorityTier === ChunkPriorityTier.RECENT) {
      this.newTierChunks.push(chunk);
    }
    const newPriorityTier = chunk.newPriorityTier;
    if (tier < newPriorityTier || (tier === newPriorityTier && priority > chunk.newPriority)) {
      chunk.newPriorityTier = tier;
      chunk.newPriority = priority;
    }
  }

  /**
   * Update queue state to reflect updated contents of the specified priority tiers.  Existing
   * chunks within those tiers not present in this.newTierChunks will be moved to the RECENT tier
   * (and removed if in the QUEUED state).
   */
  updateQueueState(tiers: ChunkPriorityTier[]) {
    let existingTierChunks = this.existingTierChunks;
    let queueManager = this.queueManager;
    for (let tier of tiers) {
      let chunks = existingTierChunks[tier];
      if (DEBUG_CHUNK_UPDATES) {
        console.log(`existingTierChunks[${ChunkPriorityTier[tier]}].length=${chunks.length}`);
      }
      for (let chunk of chunks) {
        if (chunk.newPriorityTier === ChunkPriorityTier.RECENT) {
          // Downgrade the priority of this chunk.
          queueManager.performChunkPriorityUpdate(chunk);
        }
      }
      chunks.length = 0;
    }
    let newTierChunks = this.newTierChunks;
    for (let chunk of newTierChunks) {
      queueManager.performChunkPriorityUpdate(chunk);
      existingTierChunks[chunk.priorityTier].push(chunk);
    }
    if (DEBUG_CHUNK_UPDATES) {
      console.log(`updateQueueState: newTierChunks.length = ${newTierChunks.length}`);
    }
    newTierChunks.length = 0;
    this.queueManager.scheduleUpdate();
  }
}


/**
 * Mixin for adding a `parameters` member to a ChunkSource, and for registering the shared object
 * type based on the `RPC_ID` member of the Parameters class.
 */
export function WithParameters<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
    Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  @registerSharedObjectOwner(parametersConstructor.RPC_ID)
  class C extends Base {
    parameters: Parameters;
    constructor(...args: any[]) {
      super(...args);
      const options = args[1];
      this.parameters = options['parameters'];
    }
  }
  return C;
}

/**
 * Interface that represents shared objects that request chunks from a ChunkManager.
 */
export interface ChunkRequester extends SharedObject {
  chunkManager: ChunkManager;
}

/**
 * Mixin that adds a chunkManager property initialized from the RPC-supplied options.
 *
 * The resultant class implements `ChunkRequester`.
 */
export function withChunkManager<T extends {new (...args: any[]): SharedObject}>(Base: T) {
  return class extends Base implements ChunkRequester {
    chunkManager: ChunkManager;
    constructor(...args: any[]) {
      super(...args);
      const rpc: RPC = args[0];
      const options = args[1];
      // We don't increment the reference count, because our owner owns a reference to the
      // ChunkManager.
      this.chunkManager = <ChunkManager>rpc.get(options['chunkManager']);
    }
  };
}

registerRPC(CHUNK_SOURCE_INVALIDATE_RPC_ID, function(x) {
  const source = <ChunkSource>this.get(x['id']);
  source.chunkManager.queueManager.invalidateSourceCache(source);
});

registerPromiseRPC(REQUEST_CHUNK_STATISTICS_RPC_ID, function(x: {queue: number}) {
  const queue = this.get(x.queue) as ChunkQueueManager;
  const results = new Map<number, Float64Array>();
  for (const source of queue.sources) {
    results.set(source.rpcId!, source.statistics);
  }
  return Promise.resolve({value: results});
});
