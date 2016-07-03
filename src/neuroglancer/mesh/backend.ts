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

import 'neuroglancer/uint64_set'; // Import for side effects.

import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {FRAGMENT_SOURCE_RPC_ID, MESH_LAYER_RPC_ID} from 'neuroglancer/mesh/base';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {Endianness, convertEndian32} from 'neuroglancer/util/endian';
import {vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {RPC, SharedObjectCounterpart, registerSharedObject} from 'neuroglancer/worker_rpc';

const MESH_OBJECT_MANIFEST_CHUNK_PRIORITY = 100;
const MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY = 50;

export type FragmentId = string;

// Chunk that contains the list of fragments that make up a single object.
export class ManifestChunk extends Chunk {
  backendOnly = true;
  objectId = new Uint64();
  fragmentIds: FragmentId[]|null;

  constructor() { super(); }
  // We can't save a reference to objectId, because it may be a temporary
  // object.
  initializeManifestChunk(key: string, objectId: Uint64) {
    super.initialize(key);
    this.objectId.assign(objectId);
  }

  freeSystemMemory() { this.fragmentIds = null; }

  downloadSucceeded() {
    // We can't easily determine the memory usage of the JSON manifest.  Just use 100 bytes as a
    // default value.
    this.systemMemoryBytes = 100;
    super.downloadSucceeded();
    if (this.priorityTier === ChunkPriorityTier.VISIBLE) {
      this.source!.chunkManager.scheduleUpdateChunkPriorities();
    }
  }

  toString() { return this.objectId.toString(); }
};

/**
 * Chunk that contains the mesh for a single fragment of a single object.
 */
export class FragmentChunk extends Chunk {
  manifestChunk: ManifestChunk|null = null;
  fragmentId: FragmentId|null = null;
  vertexPositions: Float32Array|null = null;
  indices: Uint32Array|null = null;
  vertexNormals: Float32Array|null = null;
  constructor() { super(); }
  initializeFragmentChunk(key: string, manifestChunk: ManifestChunk, fragmentId: FragmentId) {
    super.initialize(key);
    this.manifestChunk = manifestChunk;
    this.fragmentId = fragmentId;
  }
  freeSystemMemory() {
    this.manifestChunk = null;
    this.vertexPositions = this.indices = this.vertexNormals = null;
    this.fragmentId = null;
  }
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg['objectKey'] = this.manifestChunk!.key;
    let {vertexPositions, indices, vertexNormals} = this;
    msg['vertexPositions'] = vertexPositions;
    msg['indices'] = indices;
    msg['vertexNormals'] = vertexNormals;
    let vertexPositionsBuffer = vertexPositions!.buffer;
    transfers.push(vertexPositionsBuffer);
    let indicesBuffer = indices!.buffer;
    if (indicesBuffer !== vertexPositionsBuffer) {
      transfers.push(indicesBuffer);
    }
    let vertexNormalsBuffer = vertexNormals!.buffer;
    if (vertexNormalsBuffer !== vertexPositionsBuffer && vertexNormalsBuffer !== indicesBuffer) {
      transfers.push(vertexNormalsBuffer);
    }
    this.vertexPositions = this.indices = this.vertexNormals = null;
  }
  downloadSucceeded() {
    let {vertexPositions, indices, vertexNormals} = this;
    this.systemMemoryBytes = this.gpuMemoryBytes =
        vertexPositions!.byteLength + indices!.byteLength + vertexNormals!.byteLength;
    super.downloadSucceeded();
  }
};

/**
 * Assigns chunk.fragmentKeys to response[keysPropertyName].
 *
 * Verifies that response[keysPropertyName] is an array of strings.
 */
export function decodeJsonManifestChunk(
    chunk: ManifestChunk, response: any, keysPropertyName: string) {
  verifyObject(response);
  chunk.fragmentIds = verifyObjectProperty(response, keysPropertyName, fragmentKeys => {
    if (!Array.isArray(fragmentKeys)) {
      throw new Error(`Expected array, received: ${JSON.stringify(fragmentKeys)}.`);
    }
    for (let x of fragmentKeys) {
      if (typeof x !== 'string') {
        throw new Error(`Expected string fragment key, received: ${JSON.stringify(x)}.`);
      }
    }
    return <string[]>fragmentKeys;
  });
}

/**
 * Computes normal vectors for each vertex of a triangular mesh.
 *
 * The normal vector for each triangle with vertices (v0, v1, v2) is computed as the (normalized)
 * cross product of (v1 - v0, v2 - v1).  The normal vector for each vertex is obtained by averaging
 * the normal vector of each of the triangles that contains it.
 *
 * @param positions The vertex positions in [x0, y0, z0, x1, y1, z1, ...] format.
 * @param indices The indices of the triangle vertices.  Each triplet of consecutive values
 *     specifies a triangle.
 */
export function computeVertexNormals(positions: Float32Array, indices: Uint32Array) {
  const faceNormal = vec3.create();
  const v1v0 = vec3.create();
  const v2v1 = vec3.create();
  let vertexNormals = new Float32Array(positions.length);
  let vertexFaceCount = new Float32Array(positions.length / 3);
  let numIndices = indices.length;
  for (let i = 0; i < numIndices; i += 3) {
    for (let j = 0; j < 3; ++j) {
      vertexFaceCount[indices[i + j]] += 1;
    }
  }
  for (let i = 0; i < numIndices; i += 3) {
    let i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    for (let j = 0; j < 3; ++j) {
      v1v0[j] = positions[i1 + j] - positions[i0 + j];
      v2v1[j] = positions[i2 + j] - positions[i1 + j];
    }
    vec3.cross(faceNormal, v1v0, v2v1);
    vec3.normalize(faceNormal, faceNormal);

    for (let k = 0; k < 3; ++k) {
      let index = indices[i + k];
      let scalar = 1.0 / vertexFaceCount[index];
      let offset = index * 3;
      for (let j = 0; j < 3; ++j) {
        vertexNormals[offset + j] += scalar * faceNormal[j];
      }
    }
  }
  // Normalize all vertex normals.
  let numVertices = vertexNormals.length;
  for (let i = 0; i < numVertices; i += 3) {
    let vec = vertexNormals.subarray(i, 3);
    vec3.normalize(vec, vec);
  }
  return vertexNormals;
}

/**
 * Extracts vertex positions and triangle vertex indices of the specified endianness from `data'.
 *
 * Vertex normals are computed.
 *
 * The vertexByteOffset specifies the byte offset into `data' of the start of the vertex position
 * data.  The vertex data must consist of 3 * numVertices 32-bit float values.
 *
 * If indexByteOffset is not specified, it defaults to the end of the vertex position data.  If
 * numTriangles is not specified, it is assumed that the index data continues until the end of the
 * array.
 */
export function decodeVertexPositionsAndIndices(
    chunk: FragmentChunk, data: ArrayBuffer, endianness: Endianness, vertexByteOffset: number,
    numVertices: number, indexByteOffset?: number, numTriangles?: number) {
  let vertexPositions = new Float32Array(data, vertexByteOffset, numVertices * 3);
  convertEndian32(vertexPositions, endianness);

  if (indexByteOffset === undefined) {
    indexByteOffset = vertexByteOffset + 12 * numVertices;
  }

  let numIndices: number|undefined;
  if (numTriangles !== undefined) {
    numIndices = numTriangles * 3;
  }

  // For compatibility with Firefox, length argument must not be undefined.
  let indices = numIndices === undefined ? new Uint32Array(data, indexByteOffset) :
                                           new Uint32Array(data, indexByteOffset, numIndices);
  if (indices.length % 3 !== 0) {
    throw new Error(`Number of indices is not a multiple of 3: ${indices.length}.`);
  }
  convertEndian32(indices, endianness);

  chunk.vertexPositions = vertexPositions;
  chunk.indices = indices;
  chunk.vertexNormals = computeVertexNormals(vertexPositions, indices);
}

export abstract class MeshSource extends ChunkSource {
  fragmentSource: FragmentSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    let fragmentSource = this.fragmentSource =
        this.registerDisposer(rpc.getRef<FragmentSource>(options['fragmentSource']));
    fragmentSource.meshSource = this;
  }

  getChunk(objectId: Uint64) {
    let key = `${objectId.low}:${objectId.high}`;
    let chunk = <ManifestChunk>this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(ManifestChunk);
      chunk.initializeManifestChunk(key, objectId);
      this.addChunk(chunk);
    }
    return chunk;
  }

  getFragmentChunk(manifestChunk: ManifestChunk, fragmentId: FragmentId) {
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

export abstract class ParameterizedMeshSource<Parameters> extends MeshSource {
  parameters: Parameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }
};

@registerSharedObject(FRAGMENT_SOURCE_RPC_ID)
export class FragmentSource extends ChunkSource {
  meshSource: MeshSource|null = null;
  download(chunk: FragmentChunk) { this.meshSource!.downloadFragment(chunk); }
};

@registerSharedObject(MESH_LAYER_RPC_ID)
class MeshLayer extends SharedObjectCounterpart {
  chunkManager: ChunkManager;
  source: MeshSource;
  visibleSegmentSet: Uint64Set;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // No need to increase reference count of chunkManager and visibleSegmentSet since our owner
    // counterpart will hold a reference to the owner counterparts of them.
    this.chunkManager = <ChunkManager>rpc.get(options['chunkManager']);
    this.visibleSegmentSet = <Uint64Set>rpc.get(options['visibleSegmentSet']);
    this.source = this.registerDisposer(rpc.getRef<MeshSource>(options['source']));
    this.registerSignalBinding(
        this.chunkManager.recomputeChunkPriorities.add(this.updateChunkPriorities, this));
    this.registerSignalBinding(
        this.visibleSegmentSet.changed.add(this.handleVisibleSegmentSetChanged, this));
  }

  private handleVisibleSegmentSetChanged() { this.chunkManager.scheduleUpdateChunkPriorities(); }

  private updateChunkPriorities() {
    let {source, chunkManager} = this;
    for (let segment of this.visibleSegmentSet) {
      let manifestChunk = source.getChunk(segment);
      chunkManager.requestChunk(
          manifestChunk, ChunkPriorityTier.VISIBLE, MESH_OBJECT_MANIFEST_CHUNK_PRIORITY);
      if (manifestChunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
        for (let fragmentId of manifestChunk.fragmentIds!) {
          let fragmentChunk = source.getFragmentChunk(manifestChunk, fragmentId);
          chunkManager.requestChunk(
              fragmentChunk, ChunkPriorityTier.VISIBLE, MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY);
        }
        // console.log("FIXME: updatefragment chunk priority");
        // console.log(manifestChunk.data);
        // let fragmentChunk = fragmentSource.getChunk(manifestChunk);
      }
    }
  }
};
