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

import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {Uint64} from 'neuroglancer/util/uint64';
import {RPC, registerSharedObject, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';
import {Uint64Set} from 'neuroglancer/uint64_set';
import 'neuroglancer/uint64_set'; // Import for side effects.


const MESH_OBJECT_MANIFEST_CHUNK_PRIORITY = 100;
const MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY = 50;

// Chunk that contains the list of fragments that make up a single object.
export class ManifestChunk extends Chunk {
  backendOnly = true;
  objectId = new Uint64();
  data: any;

  constructor () {
    super();
  }
  // We can't save a reference to objectId, because it may be a temporary
  // object.
  initializeManifestChunk (key: string, objectId: Uint64) {
    super.initialize(key);
    this.objectId.assign(objectId);
  }

  freeSystemMemory () {
    this.data = null;
  }

  downloadSucceeded () {
    // We can't easily determine the memory usage of the JSON manifest.  Just use 100 bytes as a default value.
    this.systemMemoryBytes = 100;
    super.downloadSucceeded();
    if (this.priorityTier === ChunkPriorityTier.VISIBLE) {
      this.source.chunkManager.scheduleUpdateChunkPriorities();
    }
  }

  toString () {
    return this.objectId.toString();
  }
};

export type FragmentId = string;

/**
 * Chunk that contains the mesh for a single fragment of a single object.
 */
export class FragmentChunk extends Chunk {
  manifestChunk: ManifestChunk = null;
  fragmentId: FragmentId = null;
  data: Uint8Array = null;
  constructor () {
    super();
  }
  initializeFragmentChunk (key: string, manifestChunk: ManifestChunk, fragmentId: FragmentId) {
    super.initialize(key);
    this.manifestChunk = manifestChunk;
    this.fragmentId = fragmentId;
  }
  freeSystemMemory () {
    this.manifestChunk = null;
    this.data = null;
    this.fragmentId = null;
  }
  serialize (msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg['objectKey'] = this.manifestChunk.key;
    let data = msg['data'] = this.data;
    transfers.push(data.buffer);
    this.data = null;
  }
  downloadSucceeded () {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data.byteLength;
    super.downloadSucceeded();
  }
};

/**
 * Assigns chunk.data based on the received JSON manifest response.
 *
 * Currently just directly stores the JSON response.
 */
export function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  chunk.data = response;
}

/**
 * Assigns chunk.data based on the received mesh fragment.
 *
 * Currently just directly stores the fragment data as a Uint8Array.
 */
export function decodeFragmentChunk(chunk: FragmentChunk, response: any) {
  chunk.data = new Uint8Array(response);
}

export abstract class MeshSource extends ChunkSource {
  fragmentSource: FragmentSource;

  constructor (rpc: RPC, options: any) {
    super (rpc, options);
    let fragmentSource = this.fragmentSource =
        this.registerDisposer(rpc.getRef<FragmentSource>(options['fragmentSource']));
    fragmentSource.meshSource = this;
  }

  getChunk (objectId: Uint64) {
    let key = `${objectId.low}:${objectId.high}`;
    let chunk = <ManifestChunk>this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(ManifestChunk);
      chunk.initializeManifestChunk(key, objectId);
      this.addChunk(chunk);
    }
    return chunk;
  }

  getFragmentChunk (manifestChunk: ManifestChunk, fragmentId: FragmentId) {
    let key = `${manifestChunk.key}/${fragmentId}`;
    let fragmentSource = this.fragmentSource;
    let chunk = <FragmentChunk>fragmentSource.chunks.get(key);
    if (chunk === undefined) {
      chunk = fragmentSource.getNewChunk_(FragmentChunk);
      chunk.initializeFragmentChunk(key, manifestChunk, fragmentId);
      fragmentSource.addChunk(chunk);
    }
    return chunk;
  }

  abstract downloadFragment(chunk: FragmentChunk): void;
};

export class FragmentSource extends ChunkSource {
  meshSource: MeshSource = null;
  download (chunk: FragmentChunk) {
    this.meshSource.downloadFragment(chunk);
  }
};
registerSharedObject('mesh/FragmentSource', FragmentSource);

class MeshLayer extends SharedObjectCounterpart {
  chunkManager: ChunkManager;
  source: MeshSource;
  visibleSegmentSet: Uint64Set;

  constructor (rpc: RPC, options: any) {
    super(rpc, options);
    // No need to increase reference count of chunkManager and visibleSegmentSet since our owner
    // counterpart will hold a reference to the owner counterparts of them.
    this.chunkManager = <ChunkManager>rpc.get(options['chunkManager']);
    this.visibleSegmentSet = <Uint64Set>rpc.get(options['visibleSegmentSet']);
    this.source = this.registerDisposer(rpc.getRef<MeshSource>(options['source']));
    this.registerSignalBinding(this.chunkManager.recomputeChunkPriorities.add(this.updateChunkPriorities, this));
    this.registerSignalBinding(this.visibleSegmentSet.changed.add(this.handleVisibleSegmentSetChanged, this));
  }

  private handleVisibleSegmentSetChanged () {
    this.chunkManager.scheduleUpdateChunkPriorities();
  }

  private updateChunkPriorities () {
    let {source, chunkManager} = this;
    for (let segment of this.visibleSegmentSet) {
      let manifestChunk = source.getChunk(segment);
      chunkManager.requestChunk(manifestChunk, ChunkPriorityTier.VISIBLE,
                                MESH_OBJECT_MANIFEST_CHUNK_PRIORITY);
      if (manifestChunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
        for (let fragmentId of manifestChunk.data['fragments']) {
          let fragmentChunk = source.getFragmentChunk(manifestChunk, fragmentId);
          chunkManager.requestChunk(fragmentChunk, ChunkPriorityTier.VISIBLE,
                                    MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY);
        }
        // console.log("FIXME: updatefragment chunk priority");
        // console.log(manifestChunk.data);
        // let fragmentChunk = fragmentSource.getChunk(manifestChunk);
      }
    }
  }
};
registerSharedObject('mesh/MeshLayer', MeshLayer);
