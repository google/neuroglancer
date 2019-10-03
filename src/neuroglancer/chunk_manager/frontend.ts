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

import {CHUNK_MANAGER_RPC_ID, CHUNK_QUEUE_MANAGER_RPC_ID, CHUNK_SOURCE_INVALIDATE_RPC_ID, ChunkSourceParametersConstructor, ChunkState} from 'neuroglancer/chunk_manager/base';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {CANCELED, CancellationToken} from 'neuroglancer/util/cancellation';
import {Borrowed} from 'neuroglancer/util/disposable';
import {stableStringify} from 'neuroglancer/util/json';
import {StringMemoize} from 'neuroglancer/util/memoize';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {GL} from 'neuroglancer/webgl/context';
import {registerPromiseRPC, registerRPC, registerSharedObjectOwner, RPC, RPCPromise, SharedObject} from 'neuroglancer/worker_rpc';

const DEBUG_CHUNK_UPDATES = false;

export class Chunk {
  state = ChunkState.SYSTEM_MEMORY;
  constructor(public source: ChunkSource) {}

  get gl() {
    return this.source.gl;
  }

  copyToGPU(_gl: GL) {
    this.state = ChunkState.GPU_MEMORY;
  }

  freeGPUMemory(_gl: GL) {
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}

function validateLimitValue(x: any) {
  if (typeof x !== 'number' || x < 0) {
    throw new Error(`Expected non-negative number as limit, but received: ${JSON.stringify(x)}`);
  }
  return x;
}

export class CapacitySpecification {
  sizeLimit: TrackableValue<number>;
  itemLimit: TrackableValue<number>;
  constructor({
    defaultItemLimit = Number.POSITIVE_INFINITY,
    defaultSizeLimit = Number.POSITIVE_INFINITY
  } = {}) {
    this.sizeLimit = new TrackableValue<number>(defaultSizeLimit, validateLimitValue);
    this.itemLimit = new TrackableValue<number>(defaultItemLimit, validateLimitValue);
  }
}

export interface FrameNumberCounter {
  frameNumber: number;
  changed: NullarySignal;
}

@registerSharedObjectOwner(CHUNK_QUEUE_MANAGER_RPC_ID)
export class ChunkQueueManager extends SharedObject {
  visibleChunksChanged = new NullarySignal();
  pendingChunkUpdates: any = null;
  pendingChunkUpdatesTail: any = null;

  /**
   * If non-null, deadline in milliseconds since epoch after which chunk copies to the GPU may not
   * start (until the next frame).
   */
  chunkUpdateDeadline: number|null = null;

  chunkUpdateDelay: number = 30;

  constructor(
      rpc: RPC, public gl: GL, public frameNumberCounter: FrameNumberCounter, public capacities: {
        gpuMemory: CapacitySpecification,
        systemMemory: CapacitySpecification,
        download: CapacitySpecification,
        compute: CapacitySpecification
      }) {
    super();

    const makeCapacityCounterparts = (capacity: CapacitySpecification) => {
      return {
        itemLimit:
            this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, capacity.itemLimit))
                .rpcId,
        sizeLimit:
            this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, capacity.sizeLimit))
                .rpcId,
      };
    };

    this.initializeCounterpart(rpc, {
      'gpuMemoryCapacity': makeCapacityCounterparts(capacities.gpuMemory),
      'systemMemoryCapacity': makeCapacityCounterparts(capacities.systemMemory),
      'downloadCapacity': makeCapacityCounterparts(capacities.download),
      'computeCapacity': makeCapacityCounterparts(capacities.compute)
    });
  }

  scheduleChunkUpdate() {
    let deadline = this.chunkUpdateDeadline;
    let delay: number;
    if (deadline === null || Date.now() < deadline) {
      delay = 0;
    } else {
      delay = this.chunkUpdateDelay;
    }
    setTimeout(this.processPendingChunkUpdates.bind(this), delay);
  }
  processPendingChunkUpdates() {
    let deadline = this.chunkUpdateDeadline;
    if (deadline === null) {
      deadline = Date.now() + 30;
    }
    let visibleChunksChanged = false;
    while (true) {
      if (Date.now() > deadline) {
        // No time to perform chunk update now, we will wait some more.
        setTimeout(this.processPendingChunkUpdates.bind(this), this.chunkUpdateDelay);
        break;
      }
      let update = this.pendingChunkUpdates;
      if (this.applyChunkUpdate(update)) {
        visibleChunksChanged = true;
      }
      // FIXME: do chunk update
      let nextUpdate = this.pendingChunkUpdates = update.nextUpdate;
      --(<any>window).numPendingChunkUpdates;
      if (nextUpdate == null) {
        this.pendingChunkUpdatesTail = null;
        break;
      }
    }
    if (visibleChunksChanged) {
      this.visibleChunksChanged.dispatch();
    }
  }

  private handleFetch_(source: ChunkSource, update: any) {
    const {resolve, reject, cancellationToken} = update['promise'];
    if ((<CancellationToken>cancellationToken).isCanceled) {
      reject(CANCELED);
      return;
    }

    const key = update['key'];
    const chunk = source.chunks.get(key);
    if (!chunk) {
      reject(new Error(`No chunk found at ${key} for source ${source.constructor.name}`));
      return;
    }

    const data = (<any>chunk)['data'];
    if (!data) {
      reject(new Error(`At ${key} for source ${source.constructor.name}: chunk has no data`));
      return;
    }

    resolve({value: data});
  }

  applyChunkUpdate(update: any) {
    let visibleChunksChanged = false;
    let {rpc} = this;
    const source = <ChunkSource>rpc!.get(update['source']);
    if (DEBUG_CHUNK_UPDATES) {
      console.log(
          `${Date.now()} Chunk.update processed: ${source.rpcId} ` +
          `${update['id']} ${update['state']}`);
    }
    if (update['promise'] !== undefined) {
      this.handleFetch_(source, update);
    } else if (update['id'] === undefined) {
      // Invalidate source.
      for (const chunkKey of source.chunks.keys()) {
        source.deleteChunk(chunkKey);
      }
      visibleChunksChanged = true;
    } else {
      let newState: number = update['state'];
      if (newState === ChunkState.EXPIRED) {
        // FIXME: maybe use freeList for chunks here
        source.deleteChunk(update['id']);
      } else {
        let chunk: Chunk;
        let key = update['id'];
        if (update['new']) {
          chunk = source.getChunk(update);
          source.addChunk(key, chunk);
        } else {
          chunk = source.chunks.get(key)!;
        }
        let oldState = chunk.state;
        if (newState !== oldState) {
          switch (newState) {
            case ChunkState.GPU_MEMORY:
              // console.log("Copying to GPU", chunk);
              chunk.copyToGPU(this.gl);
              visibleChunksChanged = true;
              break;
            case ChunkState.SYSTEM_MEMORY:
              chunk.freeGPUMemory(this.gl);
              break;
            default:
              throw new Error(`INTERNAL ERROR: Invalid chunk state: ${ChunkState[newState]}`);
          }
        }
      }
    }
    return visibleChunksChanged;
  }
}

(<any>window).numPendingChunkUpdates = 0;

function updateChunk(rpc: RPC, x: any) {
  let source: ChunkSource = rpc.get(x['source']);
  if (DEBUG_CHUNK_UPDATES) {
    console.log(
        `${Date.now()} Chunk.update received: ` +
        `${source.rpcId} ${x['id']} ${x['state']} with chunkDataSize ${x['chunkDataSize']}`);
  }
  let queueManager = source.chunkManager.chunkQueueManager;
  if (source.immediateChunkUpdates) {
    if (queueManager.applyChunkUpdate(x)) {
      queueManager.visibleChunksChanged.dispatch();
    }
    return;
  }

  let pendingTail = queueManager.pendingChunkUpdatesTail;
  if (++(<any>window).numPendingChunkUpdates > 3) {
    // console.log(`numPendingChunkUpdates=${(<any>window).numPendingChunkUpdates}`);
  }
  if (pendingTail == null) {
    queueManager.pendingChunkUpdates = x;
    queueManager.pendingChunkUpdatesTail = x;
    queueManager.scheduleChunkUpdate();
  } else {
    pendingTail.nextUpdate = x;
    queueManager.pendingChunkUpdatesTail = x;
  }
}

registerRPC('Chunk.update', function(x) {
  updateChunk(this, x);
});

registerPromiseRPC('Chunk.retrieve', function(x, cancellationToken): RPCPromise<any> {
  return new Promise<{value: any}>((resolve, reject) => {
    x['promise'] = {resolve, reject, cancellationToken};
    updateChunk(this, x);
  });
});

export interface ChunkSourceConstructor<Options, T extends SharedObject = ChunkSource> {
  new(...args: any[]): T;
  encodeOptions(options: Options): {[key: string]: any};
}

@registerSharedObjectOwner(CHUNK_MANAGER_RPC_ID)
export class ChunkManager extends SharedObject {
  memoize = new StringMemoize();

  get gl() {
    return this.chunkQueueManager.gl;
  }

  constructor(public chunkQueueManager: ChunkQueueManager) {
    super();
    this.registerDisposer(chunkQueueManager.addRef());
    this.initializeCounterpart(
        chunkQueueManager.rpc!, {'chunkQueueManager': chunkQueueManager.rpcId});
  }

  getChunkSource<T extends SharedObject&{key: any}, Options>(
      constructorFunction: ChunkSourceConstructor<Options, T>, options: any): T {
    const keyObject = constructorFunction.encodeOptions(options);
    keyObject['constructorId'] = getObjectId(constructorFunction);
    const key = stableStringify(keyObject);
    return this.memoize.get(key, () => {
      const newSource = new constructorFunction(this, options);
      newSource.initializeCounterpart(this.rpc!, {});
      newSource.key = keyObject;
      return newSource;
    }) as T;
  }
}

export class ChunkSource extends SharedObject {
  chunks = new Map<string, Chunk>();
  key: any;

  /**
   * If set to true, chunk updates will be applied to this source immediately, rather than queueing
   * them.  Sources that dynamically update chunks and need to ensure a consistent order of
   * processing relative to other messages between the frontend and worker should set this to true.
   */
  immediateChunkUpdates = false;

  constructor(public chunkManager: Borrowed<ChunkManager>, _options: {} = {}) {
    super();
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['chunkManager'] = this.chunkManager.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  deleteChunk(key: string) {
    const chunk = this.chunks.get(key)!;
    if (chunk.state === ChunkState.GPU_MEMORY) {
      chunk.freeGPUMemory(this.gl);
    }
    this.chunks.delete(key);
  }

  addChunk(key: string, chunk: Chunk) {
    this.chunks.set(key, chunk);
  }

  /**
   * Default implementation for use with backendOnly chunk sources.
   */
  getChunk(_x: any): Chunk {
    throw new Error('Not implemented.');
  }

  /**
   * Invalidates the chunk cache.  Operates asynchronously.
   */
  invalidateCache(): void {
    this.rpc!.invoke(CHUNK_SOURCE_INVALIDATE_RPC_ID, {'id': this.rpcId});
  }

  static encodeOptions(_options: {}): {[key: string]: any} {
    return {};
  }
}

export function WithParameters<Parameters, BaseOptions,
                               TBase extends ChunkSourceConstructor<BaseOptions, SharedObject>>(
    Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  type Options = BaseOptions&{parameters: Parameters};
  @registerSharedObjectOwner(parametersConstructor.RPC_ID)
  class C extends Base {
    parameters: Parameters;
    constructor(...args: any[]) {
      super(...args);
      const options: Options = args[1];
      this.parameters = options.parameters;
    }
    initializeCounterpart(rpc: RPC, options: any) {
      options['parameters'] = this.parameters;
      super.initializeCounterpart(rpc, options);
    }
    static encodeOptions(options: Options) {
      return Object.assign({parameters: options.parameters}, super.encodeOptions(options));
    }
  }
  return C;
}
