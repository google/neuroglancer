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

import type {
  ChunkSourceParametersConstructor,
  LayerChunkProgressInfo,
} from "#src/chunk_manager/base.js";
import {
  CHUNK_LAYER_STATISTICS_RPC_ID,
  CHUNK_MANAGER_RPC_ID,
  CHUNK_QUEUE_MANAGER_RPC_ID,
  CHUNK_SOURCE_INVALIDATE_RPC_ID,
  ChunkState,
  REQUEST_CHUNK_STATISTICS_RPC_ID,
} from "#src/chunk_manager/base.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import { TrackableValue } from "#src/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";
import { StringMemoize } from "#src/util/memoize.js";
import { getObjectId } from "#src/util/object_id.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import type { RPC, RPCPromise } from "#src/worker_rpc.js";
import {
  registerPromiseRPC,
  registerRPC,
  registerSharedObjectOwner,
  SharedObject,
} from "#src/worker_rpc.js";

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
  if (typeof x !== "number" || x < 0) {
    throw new Error(
      `Expected non-negative number as limit, but received: ${JSON.stringify(
        x,
      )}`,
    );
  }
  return x;
}

export class CapacitySpecification {
  sizeLimit: TrackableValue<number>;
  itemLimit: TrackableValue<number>;
  constructor({
    defaultItemLimit = Number.POSITIVE_INFINITY,
    defaultSizeLimit = Number.POSITIVE_INFINITY,
  } = {}) {
    this.sizeLimit = new TrackableValue<number>(
      defaultSizeLimit,
      validateLimitValue,
    );
    this.itemLimit = new TrackableValue<number>(
      defaultItemLimit,
      validateLimitValue,
    );
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
  chunkUpdateDeadline: number | null = null;

  chunkUpdateDelay = 30;

  enablePrefetch = new TrackableBoolean(true, true);

  constructor(
    rpc: RPC,
    public gl: GL,
    public frameNumberCounter: FrameNumberCounter,
    public capacities: {
      gpuMemory: CapacitySpecification;
      systemMemory: CapacitySpecification;
      download: CapacitySpecification;
      compute: CapacitySpecification;
    },
  ) {
    super();

    const makeCapacityCounterparts = (capacity: CapacitySpecification) => {
      return {
        itemLimit: this.registerDisposer(
          SharedWatchableValue.makeFromExisting(rpc, capacity.itemLimit),
        ).rpcId,
        sizeLimit: this.registerDisposer(
          SharedWatchableValue.makeFromExisting(rpc, capacity.sizeLimit),
        ).rpcId,
      };
    };

    this.initializeCounterpart(rpc, {
      gpuMemoryCapacity: makeCapacityCounterparts(capacities.gpuMemory),
      systemMemoryCapacity: makeCapacityCounterparts(capacities.systemMemory),
      downloadCapacity: makeCapacityCounterparts(capacities.download),
      computeCapacity: makeCapacityCounterparts(capacities.compute),
      enablePrefetch: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.enablePrefetch),
      ).rpcId,
    });
  }

  scheduleChunkUpdate() {
    const deadline = this.chunkUpdateDeadline;
    let delay: number;
    if (deadline === null || Date.now() < deadline) {
      delay = 0;
    } else {
      delay = this.chunkUpdateDelay;
    }
    setTimeout(this.processPendingChunkUpdates.bind(this), delay);
  }
  processPendingChunkUpdates(flush = false) {
    let deadline = this.chunkUpdateDeadline;
    if (!flush && deadline === null) {
      deadline = Date.now() + 30;
    }
    let visibleChunksChanged = false;
    let numUpdates = 0;
    while (true) {
      if (!flush && Date.now() > deadline!) {
        // No time to perform chunk update now, we will wait some more.
        this.chunkUpdateDeadline = null;
        setTimeout(
          () => this.processPendingChunkUpdates(),
          this.chunkUpdateDelay,
        );
        break;
      }
      const update = this.pendingChunkUpdates;
      if (update == null) break;
      try {
        if (this.applyChunkUpdate(update)) {
          visibleChunksChanged = true;
        }
      } finally {
        ++numUpdates;
        const nextUpdate = (this.pendingChunkUpdates = update.nextUpdate);
        if (nextUpdate == null) {
          this.pendingChunkUpdatesTail = null;
          break;
        }
      }
    }
    if (visibleChunksChanged) {
      this.visibleChunksChanged.dispatch();
    }
    return numUpdates;
  }

  private handleFetch_(source: ChunkSource, update: any) {
    const { resolve, reject, signal } = update.promise;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const key = update.key;
    const chunk = source.chunks.get(key);
    if (!chunk) {
      reject(
        new Error(
          `No chunk found at ${key} for source ${source.constructor.name}`,
        ),
      );
      return;
    }

    const data = (<any>chunk).data;
    if (!data) {
      reject(
        new Error(
          `At ${key} for source ${source.constructor.name}: chunk has no data`,
        ),
      );
      return;
    }

    resolve({ value: data });
  }

  applyChunkUpdate(update: any) {
    let visibleChunksChanged = false;
    const { rpc } = this;
    const source = <ChunkSource>rpc!.get(update.source);
    if (source === undefined) {
      // Source was removed while chunk update was enqueued.
      return;
    }
    if (DEBUG_CHUNK_UPDATES) {
      console.log(
        `${Date.now()} Chunk.update processed: ${source.rpcId} ` +
          `${update.id} ${update.state}`,
      );
    }
    if (update.promise !== undefined) {
      this.handleFetch_(source, update);
    } else if (update.id === undefined) {
      // Invalidate source.
      for (const chunkKey of source.chunks.keys()) {
        source.deleteChunk(chunkKey);
      }
      visibleChunksChanged = true;
    } else {
      const newState: number = update.state;
      if (newState === ChunkState.EXPIRED) {
        // FIXME: maybe use freeList for chunks here
        source.deleteChunk(update.id);
      } else {
        let chunk: Chunk;
        const key = update.id;
        if (update.new) {
          chunk = source.getChunk(update);
          source.addChunk(key, chunk);
        } else {
          chunk = source.chunks.get(key)!;
        }
        const oldState = chunk.state;
        if (newState !== oldState) {
          switch (newState) {
            case ChunkState.GPU_MEMORY:
              // console.log("Copying to GPU", chunk);
              chunk.copyToGPU(this.gl);
              visibleChunksChanged = true;
              break;
            case ChunkState.SYSTEM_MEMORY:
              if (oldState === ChunkState.GPU_MEMORY) {
                chunk.freeGPUMemory(this.gl);
              }
              break;
            default:
              throw new Error(
                `INTERNAL ERROR: Invalid chunk state: ${ChunkState[newState]}`,
              );
          }
        }
        if (newState <= ChunkState.SYSTEM_MEMORY) {
          const { chunkRequesters } = source;
          if (chunkRequesters !== undefined) {
            const requesters = chunkRequesters.get(key);
            if (requesters !== undefined) {
              for (const requester of requesters) {
                requester(chunk);
              }
            }
          }
        }
      }
    }
    return visibleChunksChanged;
  }

  flushPendingChunkUpdates(): number {
    return this.processPendingChunkUpdates(true);
  }

  async getStatistics(): Promise<Map<ChunkSource, Float64Array>> {
    const rpc = this.rpc!;
    const rawData = await rpc.promiseInvoke<Map<number, Float64Array>>(
      REQUEST_CHUNK_STATISTICS_RPC_ID,
      { queue: this.rpcId },
    );
    const data = new Map<ChunkSource, Float64Array>();
    for (const [id, statistics] of rawData) {
      const source = rpc.get(id) as ChunkSource | undefined;
      if (source === undefined) continue;
      data.set(source, statistics);
    }
    return data;
  }
}

function updateChunk(rpc: RPC, x: any) {
  const source: ChunkSource = rpc.get(x.source);
  if (DEBUG_CHUNK_UPDATES) {
    console.log(
      `${Date.now()} Chunk.update received: ` +
        `${source.rpcId} ${x.id} ${x.state} with chunkDataSize ${x.chunkDataSize}`,
    );
  }
  const queueManager = source.chunkManager.chunkQueueManager;
  if (source.immediateChunkUpdates) {
    if (queueManager.applyChunkUpdate(x)) {
      queueManager.visibleChunksChanged.dispatch();
    }
    return;
  }

  const pendingTail = queueManager.pendingChunkUpdatesTail;
  if (pendingTail == null) {
    queueManager.pendingChunkUpdates = x;
    queueManager.pendingChunkUpdatesTail = x;
    queueManager.scheduleChunkUpdate();
  } else {
    pendingTail.nextUpdate = x;
    queueManager.pendingChunkUpdatesTail = x;
  }
}

registerRPC("Chunk.update", function (x) {
  updateChunk(this, x);
});

registerPromiseRPC("Chunk.retrieve", function (x, signal): RPCPromise<any> {
  return new Promise<{ value: any }>((resolve, reject) => {
    x.promise = { resolve, reject, signal };
    updateChunk(this, x);
  });
});

registerRPC(CHUNK_LAYER_STATISTICS_RPC_ID, function (x) {
  const chunkManager = this.get(x.id) as ChunkManager;
  for (const stats of chunkManager.prevStatisticsLayers) {
    stats.numVisibleChunksNeeded = 0;
    stats.numVisibleChunksAvailable = 0;
    stats.numPrefetchChunksNeeded = 0;
    stats.numPrefetchChunksAvailable = 0;
  }
  chunkManager.prevStatisticsLayers.length = 0;
  for (const layerUpdate of x.layers) {
    const layer = this.get(layerUpdate.id) as ChunkRenderLayerFrontend;
    if (layer === undefined) continue;
    const stats = layer.layerChunkProgressInfo;
    stats.numVisibleChunksAvailable = layerUpdate.numVisibleChunksAvailable;
    stats.numVisibleChunksNeeded = layerUpdate.numVisibleChunksNeeded;
    stats.numPrefetchChunksAvailable = layerUpdate.numPrefetchChunksAvailable;
    stats.numPrefetchChunksNeeded = layerUpdate.numPrefetchChunksNeeded;
    chunkManager.prevStatisticsLayers.push(stats);
  }
  chunkManager.layerChunkStatisticsUpdated.dispatch();
});

export type GettableChunkSource = SharedObject & { OPTIONS: object; key: any };

export interface ChunkSourceConstructor<
  T extends GettableChunkSource = GettableChunkSource,
> {
  new (...args: any[]): T;
  encodeOptions(options: T["OPTIONS"]): any;
}

@registerSharedObjectOwner(CHUNK_MANAGER_RPC_ID)
export class ChunkManager extends SharedObject {
  memoize = new StringMemoize();

  prevStatisticsLayers: LayerChunkProgressInfo[] = [];
  layerChunkStatisticsUpdated = new NullarySignal();

  get gl() {
    return this.chunkQueueManager.gl;
  }

  constructor(public chunkQueueManager: ChunkQueueManager) {
    super();
    this.registerDisposer(chunkQueueManager.addRef());
    this.initializeCounterpart(chunkQueueManager.rpc!, {
      chunkQueueManager: chunkQueueManager.rpcId,
    });
  }

  getChunkSource<T extends GettableChunkSource>(
    constructorFunction: ChunkSourceConstructor<T>,
    options: T["OPTIONS"],
  ): T {
    const keyObject = constructorFunction.encodeOptions(options);
    keyObject.constructorId = getObjectId(constructorFunction);
    const key = stableStringify(keyObject);
    return this.memoize.get(key, () => {
      const newSource = new constructorFunction(this, options);
      newSource.initializeCounterpart(this.rpc!, {});
      newSource.key = keyObject;
      return newSource;
    });
  }
}

export interface ChunkRequesterState {
  (chunk: Chunk): void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ChunkSource extends SharedObject {
  declare OPTIONS: object;
  chunks = new Map<string, Chunk>();

  chunkRequesters: Map<string, ChunkRequesterState[]> | undefined;

  /**
   * If set to true, chunk updates will be applied to this source immediately, rather than queueing
   * them.  Sources that dynamically update chunks and need to ensure a consistent order of
   * processing relative to other messages between the frontend and worker should set this to true.
   */
  immediateChunkUpdates = false;

  constructor(
    public chunkManager: Borrowed<ChunkManager>,
    _options: object = {},
  ) {
    super();
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.chunkManager = this.chunkManager.rpcId;
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
    throw new Error("Not implemented.");
  }

  /**
   * Invalidates the chunk cache.  Operates asynchronously.
   */
  invalidateCache(): void {
    this.rpc!.invoke(CHUNK_SOURCE_INVALIDATE_RPC_ID, { id: this.rpcId });
  }

  static encodeOptions(_options: object): { [key: string]: any } {
    return {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ChunkSource {
  key: any;
}

export function WithParameters<
  Parameters,
  TBase extends ChunkSourceConstructor,
>(
  Base: TBase,
  parametersConstructor: ChunkSourceParametersConstructor<Parameters>,
) {
  type WithParametersOptions = InstanceType<TBase>["OPTIONS"] & {
    parameters: Parameters;
  };
  @registerSharedObjectOwner(parametersConstructor.RPC_ID)
  class C extends Base {
    declare OPTIONS: WithParametersOptions;
    parameters: Parameters;
    constructor(...args: any[]) {
      super(...args);
      const options: WithParametersOptions = args[1];
      this.parameters = options.parameters;
    }
    initializeCounterpart(rpc: RPC, options: any) {
      options.parameters = this.parameters;
      super.initializeCounterpart(rpc, options);
    }
    static encodeOptions(options: WithParametersOptions) {
      return Object.assign(
        { parameters: options.parameters },
        Base.encodeOptions(options),
      );
    }
  }
  return C;
}

export class ChunkRenderLayerFrontend extends SharedObject {
  constructor(public layerChunkProgressInfo: LayerChunkProgressInfo) {
    super();
  }
}

export type ChunkStatistics = Map<ChunkSource, Float64Array>;
