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

import {AvailableCapacity, CHUNK_MANAGER_RPC_ID, CHUNK_QUEUE_MANAGER_RPC_ID, ChunkPriorityTier, ChunkSourceParametersConstructor, ChunkState} from 'neuroglancer/chunk_manager/base';
import {CancellationToken, CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {Disposable} from 'neuroglancer/util/disposable';
import {LinkedListOperations} from 'neuroglancer/util/linked_list';
import LinkedList0 from 'neuroglancer/util/linked_list.0';
import LinkedList1 from 'neuroglancer/util/linked_list.1';
import {StringMemoize} from 'neuroglancer/util/memoize';
import {ComparisonFunction, PairingHeapOperations} from 'neuroglancer/util/pairing_heap';
import PairingHeap0 from 'neuroglancer/util/pairing_heap.0';
import PairingHeap1 from 'neuroglancer/util/pairing_heap.1';
import {NullarySignal} from 'neuroglancer/util/signal';
import {initializeSharedObjectCounterpart, registerSharedObject, RPC, SharedObject, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const DEBUG_CHUNK_UPDATES = false;

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
  state = ChunkState.NEW;

  error: any = null;

  /**
   * Specifies existing priority within priority tier.  Only meaningful if priorityTier in
   * CHUNK_ORDERED_PRIORITY_TIERS.
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

  systemMemoryBytes: number;
  gpuMemoryBytes: number;
  backendOnly = false;

  /**
   * Cancellation token used to cancel the pending download.  Set to undefined except when state !==
   * DOWNLOADING.  This should not be accessed by code outside this module.
   */
  downloadCancellationToken: CancellationTokenSource|undefined = undefined;

  initialize(key: string) {
    this.key = key;
    this.state = ChunkState.NEW;
    this.priority = Number.NEGATIVE_INFINITY;
    this.priorityTier = ChunkPriorityTier.RECENT;
    this.newPriority = Number.NEGATIVE_INFINITY;
    this.newPriorityTier = ChunkPriorityTier.RECENT;
    this.error = null;
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

  static priorityLess(a: Chunk, b: Chunk) {
    return a.priority < b.priority;
  }

  static priorityGreater(a: Chunk, b: Chunk) {
    return a.priority > b.priority;
  }
}

interface ChunkConstructor<T extends Chunk> {
  new(): T;
}

/**
 * Base class inherited by both ChunkSource, for implementing the backend part of chunk sources that
 * also have a frontend-part, as well as other chunk sources, such as the GenericFileSource, that
 * has only a backend part.
 */
export abstract class ChunkSourceBase extends SharedObject {
  chunks: Map<string, Chunk> = new Map<string, Chunk>();
  freeChunks: Chunk[] = new Array<Chunk>();

  constructor(public chunkManager: ChunkManager) {
    super();
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
   * Begin downloading the specified the chunk.  The returned promise should resolve when the
   * downloaded data has been successfully decoded and stored in the chunk, or rejected if the
   * download or decoding fails.
   *
   * @param chunk Chunk to download.
   * @param cancellationToken If this token is canceled, the download/decoding should be aborted if
   * possible.
   */
  abstract download(chunk: Chunk, cancellationToken: CancellationToken): Promise<void>;

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
}

export abstract class ChunkSource extends ChunkSourceBase {
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
  chunk.source!.download(chunk, downloadCancellationToken)
      .then(
          () => {
            if (chunk.downloadCancellationToken === downloadCancellationToken) {
              chunk.downloadCancellationToken = undefined;
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
      private linkedListOperations: LinkedListOperations) {
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

@registerSharedObject(CHUNK_QUEUE_MANAGER_RPC_ID)
export class ChunkQueueManager extends SharedObjectCounterpart {
  gpuMemoryCapacity: AvailableCapacity;
  systemMemoryCapacity: AvailableCapacity;
  downloadCapacity: AvailableCapacity;

  /**
   * Contains all chunks in QUEUED state.
   */
  private queuedPromotionQueue = makeChunkPriorityQueue1(Chunk.priorityGreater);

  /**
   * Contains all chunks in DOWNLOADING state.
   */
  private downloadEvictionQueue = makeChunkPriorityQueue1(Chunk.priorityLess);

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

  private updatePending: number|null = null;

  private numQueued = 0;
  private numFailed = 0;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.gpuMemoryCapacity = AvailableCapacity.fromObject(options['gpuMemoryCapacity']);
    this.systemMemoryCapacity = AvailableCapacity.fromObject(options['systemMemoryCapacity']);
    this.downloadCapacity = AvailableCapacity.fromObject(options['downloadCapacity']);
  }

  scheduleUpdate() {
    if (this.updatePending === null) {
      this.updatePending = setTimeout(this.process.bind(this), 0);
    }
  }

  * chunkQueuesForChunk(chunk: Chunk) {
    switch (chunk.state) {
      case ChunkState.QUEUED:
        yield this.queuedPromotionQueue;
        break;

      case ChunkState.DOWNLOADING:
        yield this.downloadEvictionQueue;
        yield this.systemMemoryEvictionQueue;
        break;

      case ChunkState.SYSTEM_MEMORY_WORKER:
      case ChunkState.SYSTEM_MEMORY:
        yield this.systemMemoryEvictionQueue;
        if (chunk.priorityTier !== ChunkPriorityTier.RECENT && !chunk.backendOnly) {
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
        this.downloadCapacity.adjust(factor, 0);
        this.systemMemoryCapacity.adjust(factor, 0);
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
      console.log(`${chunk}: changed state ${chunk.state} -> ${newState}`);
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
    let visibleChunksChanged = false;
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
        if (priorityTier === ChunkPriorityTier.VISIBLE) {
          visibleChunksChanged = true;
        }
      }
    }
  }

  freeChunkGPUMemory(chunk: Chunk) {
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

  copyChunkToGPU(chunk: Chunk) {
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
    function evict(chunk: Chunk) {
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
      chunk.source!.chunkManager.queueManager.updateChunkState(chunk, ChunkState.QUEUED);
    }
    let promotionCandidates = this.queuedPromotionQueue.candidates();
    let downloadEvictionCandidates = this.downloadEvictionQueue.candidates();
    let systemMemoryEvictionCandidates = this.systemMemoryEvictionQueue.candidates();
    let downloadCapacity = this.downloadCapacity;
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
              size, downloadCapacity, priorityTier, priority, downloadEvictionCandidates, evict)) {
        return;
      }
      if (!tryToFreeCapacity(
              size, systemMemoryCapacity, priorityTier, priority, systemMemoryEvictionCandidates,
              evict)) {
        return;
      }
      this.updateChunkState(promotionCandidate, ChunkState.DOWNLOADING);
      startChunkDownload(promotionCandidate);
    }
  }

  process() {
    if (!this.updatePending) {
      return;
    }
    this.updatePending = null;
    this.processGPUPromotions_();
    this.processQueuePromotions_();
    this.logStatistics();
  }

  logStatistics() {
    if (DEBUG_CHUNK_UPDATES) {
      console.log(
          `[Chunk status] QUEUED: ${this.numQueued}, FAILED: ` +
          `${this.numFailed}, DOWNLOAD: ${this.downloadCapacity}, ` +
          `MEM: ${this.systemMemoryCapacity}, GPU: ${this.gpuMemoryCapacity}`);
    }
  }
}

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

  private updatePending: number|null = null;

  recomputeChunkPriorities = new NullarySignal();

  /**
   * Dispatched immediately after recomputeChunkPriorities is dispatched.
   * This signal should be used for handlers that depend on the result of another handler.
   */
  recomputeChunkPrioritiesLate = new NullarySignal();

  memoize = new StringMemoize();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.queueManager = (<ChunkQueueManager>rpc.get(options['chunkQueueManager'])).addRef();

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

  private recomputeChunkPriorities_() {
    this.updatePending = null;
    this.recomputeChunkPriorities.dispatch();
    this.recomputeChunkPrioritiesLate.dispatch();
    this.updateQueueState([ChunkPriorityTier.VISIBLE]);
  }

  /**
   * @param chunk
   * @param tier New priority tier.  Must not equal ChunkPriorityTier.RECENT.
   * @param priority Priority within tier.
   */
  requestChunk(chunk: Chunk, tier: ChunkPriorityTier, priority: number) {
    if (chunk.newPriorityTier === ChunkPriorityTier.RECENT) {
      this.newTierChunks.push(chunk);
    }
    chunk.newPriorityTier = tier;
    chunk.newPriority = priority;
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
 * Decorates final subclasses of ChunkSource.
 *
 * Defines the toString method based on the stringify method of the specified Parameters class.
 *
 * Calls registerSharedObject using parametersConstructor.RPC_ID.
 */
export function registerChunkSource<Parameters>(
    parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return <T extends{parameters: Parameters}&SharedObjectCounterpart>(
             target: {new (rpc: RPC, options: any): T}) => {
    registerSharedObject(parametersConstructor.RPC_ID)(target);
    target.prototype.toString = function(this: {parameters: Parameters}) {
      return parametersConstructor.stringify(this.parameters);
    };
  };
}

/**
 * Interface that represents shared objects that request chunks from a ChunkManager.
 */
export interface ChunkRequester extends SharedObject { chunkManager: ChunkManager; }

/**
 * Mixin that adds a chunkManager property initialized from the RPC-supplied options.
 *
 * The resultant class implements `ChunkRequester`.
 */
export function withChunkManager<T extends{new (...args: any[]): SharedObject}>(Base: T) {
  return class extends Base implements ChunkRequester {
    chunkManager: ChunkManager;
    constructor(...args: any[]) {
      super(...args);
      const rpc: RPC = args[0];
      const options = args[1];
      // We don't increment the reference count, because our owner owns a reference to the
      // ChunkManager.
      this.chunkManager = this.registerDisposer(<ChunkManager>rpc.get(options['chunkManager']));
    }
  };
}
