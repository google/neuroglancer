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

import {SliceViewChunk, SliceViewChunkSource} from 'neuroglancer/sliceview/backend';
import {VectorGraphicsChunkSource as VectorGraphicsChunkSourceInterface, VectorGraphicsChunkSpecification} from 'neuroglancer/sliceview/vector_graphics/base';
import {vec3} from 'neuroglancer/util/geom';
import {RPC} from 'neuroglancer/worker_rpc';

export class VectorGraphicsChunk extends SliceViewChunk {
  source: VectorGraphicsChunkSource|null = null;
  vertexPositions: Float32Array|null = null;
  vertexNormals: Float32Array|null = null;
  constructor() {
    super();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);

    let chunkBytes: number = 0;
    if (this.vertexPositions) {
      chunkBytes = chunkBytes + this.vertexPositions!.buffer.byteLength;
    }
    if (this.vertexNormals) {
      chunkBytes = chunkBytes + this.vertexNormals!.buffer.byteLength;
    }
    this.systemMemoryBytes = chunkBytes;
    this.gpuMemoryBytes = chunkBytes;

    this.vertexPositions = null;
  }


  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    let {vertexPositions, vertexNormals} = this;

    msg['vertexPositions'] = vertexPositions;
    let vertexPositionsBuffer = vertexPositions!.buffer;
    transfers.push(vertexPositionsBuffer);

    if (vertexNormals) {
      msg['vertexNormals'] = vertexNormals;
      let vertexNormalsBuffer = vertexNormals!.buffer;
      transfers.push(vertexNormalsBuffer);
    }

    this.vertexPositions = null;
    this.vertexNormals = null;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.vertexPositions!.byteLength;
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.vertexPositions = null;
    this.vertexNormals = null;
  }
}

export class VectorGraphicsChunkSource extends SliceViewChunkSource implements
    VectorGraphicsChunkSourceInterface {
  spec: VectorGraphicsChunkSpecification;
  chunkBytes: number;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = VectorGraphicsChunkSpecification.fromObject(options['spec']);
  }
}
VectorGraphicsChunkSource.prototype.chunkConstructor = VectorGraphicsChunk;
