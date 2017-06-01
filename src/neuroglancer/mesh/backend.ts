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

import {Chunk, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {FRAGMENT_SOURCE_RPC_ID, MESH_LAYER_RPC_ID} from 'neuroglancer/mesh/base';
import {SegmentationLayerSharedObjectCounterpart} from 'neuroglancer/segmentation_display_state/backend';
import {getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {forEachVisibleSegment} from 'neuroglancer/segmentation_display_state/base';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyStringArray} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {getBasePriority, getPriorityTier} from 'neuroglancer/visibility_priority/backend';
import {registerSharedObject, RPC} from 'neuroglancer/worker_rpc';

const MESH_OBJECT_MANIFEST_CHUNK_PRIORITY = 100;
const MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY = 50;

export type FragmentId = string;

// Chunk that contains the list of fragments that make up a single object.
export class ManifestChunk extends Chunk {
  backendOnly = true;
  objectId = new Uint64();
  fragmentIds: FragmentId[]|null;

  constructor() {
    super();
  }
  // We can't save a reference to objectId, because it may be a temporary
  // object.
  initializeManifestChunk(key: string, objectId: Uint64) {
    super.initialize(key);
    this.objectId.assign(objectId);
  }

  freeSystemMemory() {
    this.fragmentIds = null;
  }

  downloadSucceeded() {
    // We can't easily determine the memory usage of the JSON manifest.  Just use 100 bytes as a
    // default value.
    this.systemMemoryBytes = 100;
    super.downloadSucceeded();
    if (this.priorityTier < ChunkPriorityTier.RECENT) {
      this.source!.chunkManager.scheduleUpdateChunkPriorities();
    }
  }

  toString() {
    return this.objectId.toString();
  }
}

/**
 * Chunk that contains the mesh for a single fragment of a single object.
 */
export class FragmentChunk extends Chunk {
  manifestChunk: ManifestChunk|null = null;
  fragmentId: FragmentId|null = null;
  vertexPositions: Float32Array|null = null;
  indices: Uint32Array|null = null;
  vertexNormals: Float32Array|null = null;
  constructor() {
    super();
  }
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
}

/**
 * Assigns chunk.fragmentKeys to response[keysPropertyName].
 *
 * Verifies that response[keysPropertyName] is an array of strings.
 */
export function decodeJsonManifestChunk(
    chunk: ManifestChunk, response: any, keysPropertyName: string) {
  verifyObject(response);
  chunk.fragmentIds = verifyObjectProperty(response, keysPropertyName, verifyStringArray);
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
    let vec = <vec3>vertexNormals.subarray(i, 3);
    vec3.normalize(vec, vec);
  }
  return vertexNormals;
}

/**
 * Extracts vertex positions and indices of the specified endianness from `data'.
 *
 * The vertexByteOffset specifies the byte offset into `data' of the start of the vertex position
 * data.  The vertex data must consist of verticesPerPrimitive * numVertices 32-bit float values.
 *
 * If indexByteOffset is not specified, it defaults to the end of the vertex position data.  If
 * numPrimitives is not specified, it is assumed that the index data continues until the end of the
 * array.
 */
export function decodeVertexPositionsAndIndices(
    chunk: {vertexPositions: Float32Array | null, indices: Uint32Array | null},
    verticesPerPrimitive: number, data: ArrayBuffer, endianness: Endianness,
    vertexByteOffset: number, numVertices: number, indexByteOffset?: number,
    numPrimitives?: number) {
  let vertexPositions = new Float32Array(data, vertexByteOffset, numVertices * 3);
  convertEndian32(vertexPositions, endianness);

  if (indexByteOffset === undefined) {
    indexByteOffset = vertexByteOffset + 12 * numVertices;
  }

  let numIndices: number|undefined;
  if (numPrimitives !== undefined) {
    numIndices = numPrimitives * verticesPerPrimitive;
  }

  // For compatibility with Firefox, length argument must not be undefined.
  let indices = numIndices === undefined ? new Uint32Array(data, indexByteOffset) :
                                           new Uint32Array(data, indexByteOffset, numIndices);
  if (indices.length % verticesPerPrimitive !== 0) {
    throw new Error(
        `Number of indices is not a multiple of ${verticesPerPrimitive}: ${indices.length}.`);
  }
  convertEndian32(indices, endianness);

  chunk.vertexPositions = vertexPositions;
  chunk.indices = indices;
}

/**
 * Extracts vertex positions and triangle vertex indices of the specified endianness from `data'.
 *
 * Vertex normals are computed.
 *
 * See decodeVertexPositionsAndIndices above.
 */
export function decodeTriangleVertexPositionsAndIndices(
    chunk: FragmentChunk, data: ArrayBuffer, endianness: Endianness, vertexByteOffset: number,
    numVertices: number, indexByteOffset?: number, numTriangles?: number) {
  decodeVertexPositionsAndIndices(
      chunk, /*verticesPerPrimitive=*/3, data, endianness, vertexByteOffset, numVertices,
      indexByteOffset, numTriangles);
  chunk.vertexNormals = computeVertexNormals(chunk.vertexPositions!, chunk.indices!);
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
    const key = getObjectKey(objectId);
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

  abstract downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken):
      Promise<void>;
}

export abstract class ParameterizedMeshSource<Parameters> extends MeshSource {
  parameters: Parameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }
}

@registerSharedObject(FRAGMENT_SOURCE_RPC_ID)
export class FragmentSource extends ChunkSource {
  meshSource: MeshSource|null = null;
  download(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    return this.meshSource!.downloadFragment(chunk, cancellationToken);
  }
}

@registerSharedObject(MESH_LAYER_RPC_ID)
export class MeshLayer extends SegmentationLayerSharedObjectCounterpart {
  source: MeshSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(rpc.getRef<MeshSource>(options['source']));
    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateChunkPriorities();
    }));
  }

  private updateChunkPriorities() {
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    const priorityTier = getPriorityTier(visibility);
    const basePriority = getBasePriority(visibility);
    const {source, chunkManager} = this;
    forEachVisibleSegment(this, objectId => {
      let manifestChunk = source.getChunk(objectId);
      chunkManager.requestChunk(
          manifestChunk, priorityTier, basePriority + MESH_OBJECT_MANIFEST_CHUNK_PRIORITY);
      if (manifestChunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
        for (let fragmentId of manifestChunk.fragmentIds!) {
          let fragmentChunk = source.getFragmentChunk(manifestChunk, fragmentId);
          chunkManager.requestChunk(
              fragmentChunk, priorityTier, basePriority + MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY);
        }
      }
    });
  }
}
