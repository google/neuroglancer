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

import {RenderLayer as SliceViewRenderLayer, SliceViewChunk, SliceViewChunkSource} from 'neuroglancer/sliceview/backend';
import {RenderLayer as RenderLayerInterface, VOLUME_RENDERLAYER_RPC_ID, VolumeChunkSource as VolumeChunkSourceInterface, VolumeChunkSpecification} from 'neuroglancer/sliceview/volume/base';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {registerSharedObject, RPC} from 'neuroglancer/worker_rpc';

export class VolumeChunk extends SliceViewChunk {
  source: VolumeChunkSource|null = null;
  data: ArrayBufferView|null;
  constructor() {
    super();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);

    let source = this.source;

    /**
     * Grid position within chunk layout (coordinates are in units of chunks).
     */
    this.systemMemoryBytes = source!.spec.chunkBytes;
    this.gpuMemoryBytes = source!.spec.chunkBytes;

    this.data = null;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    let data = msg['data'] = this.data!;

    transfers.push(data.buffer);
    this.data = null;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data!.byteLength;
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.data = null;
  }
}

export abstract class VolumeChunkSource extends SliceViewChunkSource implements
    VolumeChunkSourceInterface {
  spec: VolumeChunkSpecification;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = VolumeChunkSpecification.fromObject(options['spec']);
  }

  getChunk(chunkGridPosition: vec3) {
    let key = vec3Key(chunkGridPosition);
    let chunk = <VolumeChunk>this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(VolumeChunk);
      chunk.initializeVolumeChunk(key, chunkGridPosition);
      this.addChunk(chunk);
    }
    return chunk;
  }
}

@registerSharedObject(VOLUME_RENDERLAYER_RPC_ID)
export class RenderLayer extends SliceViewRenderLayer implements RenderLayerInterface {
  sources: VolumeChunkSource[][];
}

/**
 * Extends VolumeChunkSource with a parameters member.
 *
 * Subclasses should be decorated with
 * src/neuroglancer/chunk_manager/backend.ts:registerChunkSource.
 */
export abstract class ParameterizedVolumeChunkSource<Parameters> extends VolumeChunkSource {
  parameters: Parameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }
}
