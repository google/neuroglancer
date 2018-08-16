/**
 * @license
 * Copyright 2017 The Neuroglancer Authors
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

import debounce from 'lodash/debounce';
import {ChunkState, ChunkPriorityTier} from 'neuroglancer/chunk_manager/base';
import {CHUNKED_GRAPH_LAYER_RPC_ID} from 'neuroglancer/chunked_graph/base';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {VolumeChunkSource as VolumeChunkSourceInterface} from 'neuroglancer/sliceview/volume/base';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {RenderLayer as RenderLayerInterface} from 'neuroglancer/sliceview/base';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {mat4, vec3, vec3Key} from 'neuroglancer/util/geom';
import {openHttpRequest, sendHttpRequest, HttpError} from 'neuroglancer/util/http_request';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';
import {withChunkManager, startChunkDownload, cancelChunkDownload } from 'neuroglancer/chunk_manager/backend';
import { CoordinateTransform } from 'neuroglancer/coordinate_transform';
import { ChunkLayout } from 'neuroglancer/sliceview/chunk_layout';

// Chunk that contains the list of fragments that make up a single object.
export class ChunkedGraphChunk extends VolumeChunk {
  backendOnly = true;
  mappings: Map<string, Uint64[]|null>|null = null;
  constructor() {
    super();
  }

  updateRootSegments(rootSegments: Uint64Set) {
    let changed = false;
    for (const rootObjectId of rootSegments) {
      const key = rootObjectId.toString();
      if (!this.mappings!.has(key)) {
        changed = true;
        this.mappings!.set(key, null);
      }
    }
    return changed;
  }

  initializeChunkedGraphChunk(key: string, chunkGridPosition: vec3, rootSegments: Uint64Set) {
    super.initializeVolumeChunk(key, chunkGridPosition);

    this.mappings = new Map<string, Uint64[]|null>();
    this.updateRootSegments(rootSegments);
  }

  downloadSucceeded() {
    this.systemMemoryBytes = 0;
    for (const supervoxelIds of this.mappings!.values()) {
      if (supervoxelIds !== null) {
        // Each supervoxel ID is a Uint64, consisting of two `number`s (8 Byte)
        this.systemMemoryBytes += 16 * supervoxelIds.length;
      }
    }
    this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY_WORKER);
    if (this.priorityTier < ChunkPriorityTier.RECENT) {
      this.source!.chunkManager.scheduleUpdateChunkPriorities();
    }
  }

  freeSystemMemory() {
    this.mappings = null;
  }
}

export function decodeSupervoxelArray(chunk: ChunkedGraphChunk, rootObjectKey: string, data: ArrayBuffer) {
  let uint32 = new Uint32Array(data);
  let final: Uint64[] = new Array(uint32.length / 2);
  for (let i = 0; i < uint32.length / 2; i++) {
    final[i] = new Uint64(uint32[2 * i], uint32[2 * i + 1]);
  }
  chunk.mappings!.set(rootObjectKey, final);
}

export class ChunkedGraphChunkSource extends VolumeChunkSource implements
  VolumeChunkSourceInterface {
  rootSegments: Uint64Set;
  chunks: Map<string, ChunkedGraphChunk>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.rootSegments = rpc.get(options['rootSegments']);
  }

  getChunk(chunkGridPosition: vec3) {
    let key = vec3Key(chunkGridPosition);
    let chunk = <ChunkedGraphChunk>this.chunks.get(key);

    if (chunk === undefined) {
      chunk = this.getNewChunk_(ChunkedGraphChunk);
      chunk.initializeChunkedGraphChunk(key, chunkGridPosition, this.rootSegments);
      this.addChunk(chunk);
    } else {
      if (chunk.updateRootSegments(this.rootSegments)) {
        if (chunk.downloadCancellationToken !== undefined) {
          cancelChunkDownload(chunk);
        }
        this.chunkManager.queueManager.updateChunkState(chunk, ChunkState.DOWNLOADING);
        startChunkDownload(chunk);
      }
    }
    return chunk;
  }
}

const Base = withChunkManager(SharedObjectCounterpart);

@registerSharedObject(CHUNKED_GRAPH_LAYER_RPC_ID)
export class ChunkedGraphLayer extends Base implements RenderLayerInterface {
  rpcId: number;
  sources: ChunkedGraphChunkSource[][];
  layerChanged = new NullarySignal();
  transform = new CoordinateTransform();
  transformedSources: {source: VolumeChunkSource, chunkLayout: ChunkLayout}[][];
  transformedSourcesGeneration = -1;

  graphurl: string;
  rootSegments: Uint64Set;
  visibleSegments3D: Uint64Set;
  segmentEquivalences: SharedDisjointUint64Sets;


  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.graphurl = options['url'];
    this.rootSegments = <Uint64Set>rpc.get(options['rootSegments']);
    this.visibleSegments3D = <Uint64Set>rpc.get(options['visibleSegments3D']);
    this.segmentEquivalences = <SharedDisjointUint64Sets>rpc.get(options['segmentEquivalences']);

    this.sources = new Array<ChunkedGraphChunkSource[]>();
    for (const alternativeIds of options['sources']) {
      const alternatives = new Array<ChunkedGraphChunkSource>();
      this.sources.push(alternatives);
      for (const sourceId of alternativeIds) {
        const source: ChunkedGraphChunkSource = rpc.get(sourceId);
        this.registerDisposer(source.addRef());
        alternatives.push(source);
      }
    }
    mat4.copy(this.transform.transform, options['transform']);
    this.transform.changed.add(this.layerChanged.dispatch);

    this.registerDisposer(this.rootSegments.changed.add(() => {
      this.chunkManager.scheduleUpdateChunkPriorities();
    }));

    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.debouncedupdateDisplayState();
    }));
  }

  get url() {
    return this.graphurl;
  }

  getChildren(segment: Uint64): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.resolve([segment]);
    }

    let promise = sendHttpRequest(openHttpRequest(`${url}/1.0/segment/${segment}/children`), 'arraybuffer');
    return promise.then(response => {
      let uint32 = new Uint32Array(response);
      let final: Uint64[] = new Array(uint32.length / 2);
      for (let i = 0; i < uint32.length / 2; i++) {
        final[i] = new Uint64(uint32[2 * i], uint32[2 * i + 1]);
      }
      return final;
    }).catch((e: HttpError) => {
      console.log(`Could not retrieve children for segment ${segment}`);
      console.error(e);
      return Promise.reject(e);
    });
  }

  private debouncedupdateDisplayState = debounce(() => {
    this.updateDisplayState();
  }, 100);

  private forEachSelectedRootWithLeaves(callback: (rootObjectKey: string, leaves: Uint64[]) => void) {
  for (const alternative of this.sources) {
    for (const source of alternative) {
      for (const chunk of source.chunks.values()) {
        if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER &&
            chunk.priorityTier < ChunkPriorityTier.RECENT) {
          for (const [rootObjectKey, leaves] of chunk.mappings!) {
            if (this.rootSegments.has(Uint64.parseString(rootObjectKey)) && leaves !== null) {
              callback(rootObjectKey, leaves);
            }
          }
        }
      }
    }
  }
}

  private updateDisplayState() {
    const visibleLeaves = new Map<string, Uint64Set>();
    const capacities = new Map<string, number>();

    // Reserve
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!capacities.has(rootObjectKey)) {
        capacities.set(rootObjectKey, leaves.length);
      } else {
        capacities.set(rootObjectKey, capacities.get(rootObjectKey)! + leaves.length);
      }
    });

    // Collect unique leaves
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!visibleLeaves.has(rootObjectKey)) {
        visibleLeaves.set(rootObjectKey, new Uint64Set());
        visibleLeaves.get(rootObjectKey)!.reserve(capacities.get(rootObjectKey)!);
        visibleLeaves.get(rootObjectKey)!.add(Uint64.parseString(rootObjectKey));
      }
      visibleLeaves.get(rootObjectKey)!.add(leaves);
    });

    for (const [root, leaves] of visibleLeaves) {
      // TODO: Delete segments not visible anymore from segmentEquivalences - requires a faster data structure, though.

      /*if (this.segmentEquivalences.has(Uint64.parseString(root))) {
        this.segmentEquivalences.delete([...this.segmentEquivalences.setElements(Uint64.parseString(root))].filter(x => !leaves.has(x) && !this.visibleSegments3D.has(x)));
      }*/

      this.segmentEquivalences.link(Uint64.parseString(root), [...leaves].filter(x => !this.segmentEquivalences.has(x)));
    }
  }
}
