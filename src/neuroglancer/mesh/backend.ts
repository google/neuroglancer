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
import {EncodedMeshData, FRAGMENT_SOURCE_RPC_ID, MESH_LAYER_RPC_ID, MULTISCALE_FRAGMENT_SOURCE_RPC_ID, MULTISCALE_MESH_LAYER_RPC_ID} from 'neuroglancer/mesh/base';
import {getDesiredMultiscaleMeshChunks, MultiscaleMeshManifest} from 'neuroglancer/mesh/multiscale';
import {computeTriangleStrips} from 'neuroglancer/mesh/triangle_strips';
import {PerspectiveViewRenderLayer, PerspectiveViewState} from 'neuroglancer/perspective_view/backend';
import {SegmentationLayerSharedObjectCounterpart} from 'neuroglancer/segmentation_display_state/backend';
import {getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {forEachVisibleSegment} from 'neuroglancer/segmentation_display_state/base';
import {WatchableSet} from 'neuroglancer/trackable_value';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {getFrustrumPlanes, mat4, vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyStringArray} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {getBasePriority, getPriorityTier} from 'neuroglancer/visibility_priority/backend';
import {registerSharedObject, RPC} from 'neuroglancer/worker_rpc';

const MESH_OBJECT_MANIFEST_CHUNK_PRIORITY = 100;
const MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY = 50;

const CONVERT_TO_TRIANGLE_STRIPS = false;

export type FragmentId = string;

// Chunk that contains the list of fragments that make up a single object.
export class ManifestChunk extends Chunk {
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

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg.fragmentIds = this.fragmentIds;
  }

  downloadSucceeded() {
    // We can't easily determine the memory usage of the JSON manifest.  Just use 100 bytes as a
    // default value.
    this.systemMemoryBytes = 100;
    this.gpuMemoryBytes = 0;
    super.downloadSucceeded();
    if (this.priorityTier < ChunkPriorityTier.RECENT) {
      this.source!.chunkManager.scheduleUpdateChunkPriorities();
    }
  }

  toString() {
    return this.objectId.toString();
  }
}

interface RawMeshData {
  vertexPositions: Float32Array;
  indices: Uint32Array|Uint16Array;
}

function serializeMeshData(data: EncodedMeshData, msg: any, transfers: any[]) {
  const {vertexPositions, indices, vertexNormals, strips} = data;
  msg['vertexPositions'] = vertexPositions;
  msg['indices'] = indices;
  msg['strips'] = strips;
  msg['vertexNormals'] = vertexNormals;
  let vertexPositionsBuffer = vertexPositions!.buffer;
  transfers.push(vertexPositionsBuffer);
  let indicesBuffer = indices!.buffer;
  if (indicesBuffer !== vertexPositionsBuffer) {
    transfers.push(indicesBuffer);
  }
  transfers.push(vertexNormals!.buffer);
}

function getMeshDataSize(data: EncodedMeshData) {
  let {vertexPositions, indices, vertexNormals} = data;
  return vertexPositions!.byteLength + indices!.byteLength + vertexNormals!.byteLength;
}

/**
 * Chunk that contains the mesh for a single fragment of a single object.
 */
export class FragmentChunk extends Chunk {
  manifestChunk: ManifestChunk|null = null;
  fragmentId: FragmentId|null = null;
  meshData: EncodedMeshData|null = null;
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
    this.meshData = null;
    this.fragmentId = null;
  }
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    serializeMeshData(this.meshData!, msg, transfers);
    this.meshData = null;
  }
  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = getMeshDataSize(this.meshData!);
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
export function computeVertexNormals(positions: Float32Array, indices: Uint16Array|Uint32Array) {
  const faceNormal = vec3.create();
  const v1v0 = vec3.create();
  const v2v1 = vec3.create();
  let vertexNormals = new Float32Array(positions.length);
  let numIndices = indices.length;
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
      let offset = index * 3;
      for (let j = 0; j < 3; ++j) {
        vertexNormals[offset + j] += faceNormal[j];
      }
    }
  }
  // Normalize all vertex normals.
  let numVertices = vertexNormals.length;
  for (let i = 0; i < numVertices; i += 3) {
    let vec = <vec3>vertexNormals.subarray(i, i + 3);
    vec3.normalize(vec, vec);
  }
  return vertexNormals;
}

/**
 * Converts a floating-point number in the range `[-1, 1]` to an integer in the range `[-127, 127]`.
 */
function snorm8(x: number) {
  return Math.min(Math.max(-127, x * 127 + 0.5), 127) >>> 0;
}

function signNotZero(x: number) {
  return x < 0 ? -1 : 1;
}

/**
 * Encodes normal vectors represented as 3x32-bit floating vectors into a 2x8-bit octahedron
 * representation.
 *
 * Zina H. Cigolle, Sam Donow, Daniel Evangelakos, Michael Mara, Morgan McGuire, and Quirin Meyer,
 * Survey of Efficient Representations for Independent Unit Vectors, Journal of Computer Graphics
 * Techniques (JCGT), vol. 3, no. 2, 1-30, 2014
 *
 * Available online http://jcgt.org/published/0003/02/01/
 *
 * @param out[out] Row-major array of shape `[n, 2]` set to octahedron representation.
 * @param normals[in] Row-major array of shape `[n, 3]` specifying unit normal vectors.
 */
export function encodeNormals32fx3ToOctahedron8x2(out: Uint8Array, normals: Float32Array) {
  const length = normals.length;
  let outIndex = 0;
  for (let i = 0; i < length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];

    const invL1Norm = 1 / (Math.abs(x) + Math.abs(y) + Math.abs(z));

    if (z < 0) {
      out[outIndex] = snorm8((1 - Math.abs(y * invL1Norm)) * signNotZero(x));
      out[outIndex + 1] = snorm8((1 - Math.abs(x * invL1Norm)) * signNotZero(y));
    } else {
      out[outIndex] = snorm8(x * invL1Norm);
      out[outIndex + 1] = snorm8(y * invL1Norm);
    }
    outIndex += 2;
  }
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
    verticesPerPrimitive: number, data: ArrayBuffer, endianness: Endianness,
    vertexByteOffset: number, numVertices: number, indexByteOffset?: number,
    numPrimitives?: number): RawMeshData {
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

  return {vertexPositions, indices};
}

/**
 * Extracts vertex positions and triangle vertex indices of the specified endianness from `data'.
 *
 * Vertex normals are computed.
 *
 * See decodeVertexPositionsAndIndices above.
 */
export function decodeTriangleVertexPositionsAndIndices(
    data: ArrayBuffer, endianness: Endianness, vertexByteOffset: number, numVertices: number,
    indexByteOffset?: number, numTriangles?: number) {
  return decodeVertexPositionsAndIndices(
      /*verticesPerPrimitive=*/ 3, data, endianness, vertexByteOffset, numVertices, indexByteOffset,
      numTriangles);
}

export interface MeshSource {
  // TODO(jbms): Move this declaration to class definition below and declare abstract once
  // TypeScript supports mixins with abstract classes.
  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken): Promise<void>;
}

export class MeshSource extends ChunkSource {
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
}

@registerSharedObject(FRAGMENT_SOURCE_RPC_ID)
export class FragmentSource extends ChunkSource {
  meshSource: MeshSource|null = null;
  download(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    return this.meshSource!.downloadFragment(chunk, cancellationToken);
  }
}

@registerSharedObject(MESH_LAYER_RPC_ID)
export class MeshLayer extends SegmentationLayerSharedObjectCounterpart implements
    PerspectiveViewRenderLayer {
  source: MeshSource;
  viewStates = new WatchableSet<PerspectiveViewState>();
  private viewStatesDisposers = new Map<PerspectiveViewState, () => void>();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(rpc.getRef<MeshSource>(options['source']));
    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateChunkPriorities();
    }));
    const scheduleUpdateChunkPriorities = () => {
      this.chunkManager.scheduleUpdateChunkPriorities();
    };
    this.registerDisposer(this.viewStates.changed.add(() => {
      const {viewStatesDisposers} = this;
      const {viewStates} = this;
      for (const [viewState, disposer] of viewStatesDisposers) {
        if (!viewStates.has(viewState)) {
          disposer();
        }
      }
      for (const viewState of viewStates) {
        if (!viewStatesDisposers.has(viewState)) {
          viewState.viewport.changed.add(scheduleUpdateChunkPriorities);
          viewState.visibility.changed.add(scheduleUpdateChunkPriorities);
          viewStatesDisposers.set(viewState, () => {
            viewState.viewport.changed.remove(scheduleUpdateChunkPriorities);
            viewState.visibility.changed.remove(scheduleUpdateChunkPriorities);
          });
        }
      }
    }));
    this.registerDisposer(() => {
      for (const disposer of this.viewStatesDisposers.values()) {
        disposer();
      }
    });
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
      const state = manifestChunk.state;
      if (state === ChunkState.SYSTEM_MEMORY_WORKER || state === ChunkState.SYSTEM_MEMORY ||
          state === ChunkState.GPU_MEMORY) {
        for (let fragmentId of manifestChunk.fragmentIds!) {
          let fragmentChunk = source.getFragmentChunk(manifestChunk, fragmentId);
          chunkManager.requestChunk(
              fragmentChunk, priorityTier, basePriority + MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY);
        }
      }
    });
  }
}



// Chunk that contains the list of fragments that make up a single object.
export class MultiscaleManifestChunk extends Chunk {
  objectId = new Uint64();
  manifest: MultiscaleMeshManifest|undefined;

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
    this.manifest = undefined;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg.manifest = this.manifest;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.manifest!.chunkCoordinates.byteLength;
    this.gpuMemoryBytes = 0;
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
export class MultiscaleFragmentChunk extends Chunk {
  subChunkOffsets: Uint32Array|null = null;
  meshData: EncodedMeshData|null = null;
  lod: number = 0;
  chunkIndex: number = 0;
  manifestChunk: MultiscaleManifestChunk|null = null;
  constructor() {
    super();
  }
  freeSystemMemory() {
    this.meshData = this.subChunkOffsets = null;
  }
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    serializeMeshData(this.meshData!, msg, transfers);
    const {subChunkOffsets} = this;
    msg['subChunkOffsets'] = subChunkOffsets;
    transfers.push(subChunkOffsets!.buffer);
    this.meshData = this.subChunkOffsets = null;
  }
  downloadSucceeded() {
    const {subChunkOffsets} = this;
    this.systemMemoryBytes = this.gpuMemoryBytes = getMeshDataSize(this.meshData!);
    this.systemMemoryBytes += subChunkOffsets!.byteLength;
    super.downloadSucceeded();
  }
}



export interface MultiscaleMeshSource {
  // TODO(jbms): Move this declaration to class definition below and declare abstract once
  // TypeScript supports mixins with abstract classes.
  downloadFragment(chunk: MultiscaleFragmentChunk, cancellationToken: CancellationToken):
      Promise<void>;
}

export class MultiscaleMeshSource extends ChunkSource {
  fragmentSource: MultiscaleFragmentSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    let fragmentSource = this.fragmentSource =
        this.registerDisposer(rpc.getRef<MultiscaleFragmentSource>(options['fragmentSource']));
    fragmentSource.meshSource = this;
  }

  getChunk(objectId: Uint64) {
    const key = getObjectKey(objectId);
    let chunk = <MultiscaleManifestChunk>this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(MultiscaleManifestChunk);
      chunk.initializeManifestChunk(key, objectId);
      this.addChunk(chunk);
    }
    return chunk;
  }

  getFragmentChunk(manifestChunk: MultiscaleManifestChunk, lod: number, chunkIndex: number) {
    let key = `${manifestChunk.key}/${lod}:${chunkIndex}`;
    let fragmentSource = this.fragmentSource;
    let chunk = <MultiscaleFragmentChunk>fragmentSource.chunks.get(key);
    if (chunk === undefined) {
      chunk = fragmentSource.getNewChunk_(MultiscaleFragmentChunk);
      chunk.initialize(key);
      chunk.lod = lod;
      chunk.chunkIndex = chunkIndex;
      chunk.manifestChunk = manifestChunk;
      fragmentSource.addChunk(chunk);
    }
    return chunk;
  }
}

@registerSharedObject(MULTISCALE_FRAGMENT_SOURCE_RPC_ID)
export class MultiscaleFragmentSource extends ChunkSource {
  meshSource: MultiscaleMeshSource|null = null;
  download(chunk: MultiscaleFragmentChunk, cancellationToken: CancellationToken) {
    return this.meshSource!.downloadFragment(chunk, cancellationToken);
  }
}

@registerSharedObject(MULTISCALE_MESH_LAYER_RPC_ID)
export class MultiscaleMeshLayer extends SegmentationLayerSharedObjectCounterpart implements
    PerspectiveViewRenderLayer {
  source: MultiscaleMeshSource;
  viewStates = new WatchableSet<PerspectiveViewState>();
  private viewStatesDisposers = new Map<PerspectiveViewState, () => void>();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(rpc.getRef<MultiscaleMeshSource>(options['source']));
    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateChunkPriorities();
    }));
    const scheduleUpdateChunkPriorities = () => {
      this.chunkManager.scheduleUpdateChunkPriorities();
    };
    this.registerDisposer(this.viewStates.changed.add(() => {
      const {viewStatesDisposers} = this;
      const {viewStates} = this;
      for (const [viewState, disposer] of viewStatesDisposers) {
        if (!viewStates.has(viewState)) {
          disposer();
        }
      }
      for (const viewState of viewStates) {
        if (!viewStatesDisposers.has(viewState)) {
          viewState.viewport.changed.add(scheduleUpdateChunkPriorities);
          viewState.visibility.changed.add(scheduleUpdateChunkPriorities);
          viewStatesDisposers.set(viewState, () => {
            viewState.viewport.changed.remove(scheduleUpdateChunkPriorities);
            viewState.visibility.changed.remove(scheduleUpdateChunkPriorities);
          });
        }
      }
    }));
    this.registerDisposer(() => {
      for (const disposer of this.viewStatesDisposers.values()) {
        disposer();
      }
    });
  }

  private updateChunkPriorities() {
    const maxVisibility = this.visibility.value;
    if (maxVisibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    const manifestChunks = new Array<MultiscaleManifestChunk>();
    {
      const priorityTier = getPriorityTier(maxVisibility);
      const basePriority = getBasePriority(maxVisibility);
      const {source, chunkManager} = this;
      forEachVisibleSegment(this, objectId => {
        const manifestChunk = source.getChunk(objectId);
        chunkManager.requestChunk(
            manifestChunk, priorityTier, basePriority + MESH_OBJECT_MANIFEST_CHUNK_PRIORITY);
        const state = manifestChunk.state;
        if (state === ChunkState.SYSTEM_MEMORY_WORKER || state === ChunkState.SYSTEM_MEMORY ||
            state === ChunkState.GPU_MEMORY) {
          manifestChunks.push(manifestChunk);
        }
      });
    }
    if (manifestChunks.length === 0) return;
    const {source, chunkManager} = this;
    for (const viewState of this.viewStates) {
      const visibility = viewState.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) {
        continue;
      }
      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility);
      const viewport = viewState.viewport.value;
      const modelViewProjection = mat4.create();
      mat4.multiply(
          modelViewProjection, viewport.viewProjectionMat, this.objectToDataTransform.value);
      const clippingPlanes = getFrustrumPlanes(new Float32Array(24), modelViewProjection);
      const detailCutoff = this.renderScaleTarget.value;
      for (const manifestChunk of manifestChunks) {
        const maxLod = manifestChunk.manifest!.lodScales.length - 1;
        getDesiredMultiscaleMeshChunks(
            manifestChunk.manifest!, modelViewProjection, clippingPlanes, detailCutoff,
            viewport.width, viewport.height, (lod, chunkIndex) => {
              let fragmentChunk = source.getFragmentChunk(manifestChunk, lod, chunkIndex);
              chunkManager.requestChunk(
                  fragmentChunk, priorityTier,
                  basePriority + MESH_OBJECT_FRAGMENT_CHUNK_PRIORITY - maxLod + lod);
            });
      }
    }
  }
}

function convertMeshData(data: {
  vertexPositions: Float32Array,
  indices: Uint32Array|Uint16Array,
  subChunkOffsets?: Uint32Array
}): EncodedMeshData {
  const normals = computeVertexNormals(data.vertexPositions, data.indices);
  const encodedNormals = new Uint8Array(normals.length / 3 * 2);
  encodeNormals32fx3ToOctahedron8x2(encodedNormals, normals);
  let encodedIndices: Uint16Array| Uint32Array;
  let strips: boolean;
  if (CONVERT_TO_TRIANGLE_STRIPS) {
    encodedIndices = computeTriangleStrips(data.indices, data.subChunkOffsets);
    strips = true;
  } else {
    if (data.indices.BYTES_PER_ELEMENT === 4 && data.vertexPositions.length / 3 < 65535) {
      encodedIndices = new Uint16Array(data.indices.length);
      encodedIndices.set(data.indices);
    } else {
      encodedIndices = data.indices;
    }
    strips = false;
  }
  return {
    vertexPositions: data.vertexPositions,
    vertexNormals: encodedNormals,
    indices: encodedIndices,
    strips,
  };
}

export function assignMeshFragmentData(chunk: FragmentChunk, data: RawMeshData) {
  chunk.meshData = convertMeshData(data);
}

export function assignMultiscaleMeshFragmentData(
    chunk: MultiscaleFragmentChunk, data: RawMeshData&{subChunkOffsets: Uint32Array}) {
  chunk.meshData = convertMeshData(data);
  chunk.subChunkOffsets = data.subChunkOffsets;
}
