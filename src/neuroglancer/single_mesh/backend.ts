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

import {Chunk, ChunkManager, ChunkSource, withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier} from 'neuroglancer/chunk_manager/base';
import {PriorityGetter} from 'neuroglancer/chunk_manager/generic_file_source';
import {computeVertexNormals} from 'neuroglancer/mesh/backend';
import {GET_SINGLE_MESH_INFO_RPC_ID, SINGLE_MESH_CHUNK_KEY, SINGLE_MESH_LAYER_RPC_ID, SINGLE_MESH_SOURCE_RPC_ID, SingleMeshData, SingleMeshInfo, SingleMeshSourceParameters, VertexAttributeInfo} from 'neuroglancer/single_mesh/base';
import {TypedArray} from 'neuroglancer/util/array';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {stableStringify} from 'neuroglancer/util/json';
import {getBasePriority, getPriorityTier, withSharedVisibility} from 'neuroglancer/visibility_priority/backend';
import {registerPromiseRPC, registerSharedObject, RPC, RPCPromise, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const SINGLE_MESH_CHUNK_PRIORITY = 50;

/**
 * Chunk that contains the single mesh.
 */
export class SingleMeshChunk extends Chunk {
  data: SingleMeshData|null = null;
  constructor() {
    super();
  }
  freeSystemMemory() {
    this.data = null;
  }
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    let {vertexPositions, indices, vertexNormals, vertexAttributes} = this.data!;
    msg['vertexPositions'] = vertexPositions;
    msg['indices'] = indices;
    msg['vertexNormals'] = vertexNormals;
    msg['vertexAttributes'] = vertexAttributes;
    const transferSet = new Set<ArrayBuffer>();
    transferSet.add(vertexPositions!.buffer);
    transferSet.add(indices!.buffer);
    transferSet.add(vertexNormals!.buffer);
    for (const data of vertexAttributes!) {
      transferSet.add(data.buffer);
    }
    transfers.push(...transferSet);
    this.data = null;
  }
  downloadSucceeded() {
    let {vertexPositions, indices, vertexNormals, vertexAttributes} = this.data!;
    let totalBytes = this.gpuMemoryBytes =
        vertexPositions.byteLength + indices.byteLength + vertexNormals!.byteLength;
    for (const data of vertexAttributes) {
      totalBytes += data.byteLength;
    }
    this.systemMemoryBytes = this.gpuMemoryBytes = totalBytes;
    super.downloadSucceeded();
  }
}

export interface SingleMesh extends SingleMeshData { info: SingleMeshInfo; }

export interface SingleMeshVertexAttributes {
  numVertices: number;
  attributeInfo: VertexAttributeInfo[];
  attributes: Float32Array[];
}

interface SingleMeshFactory {
  description?: string;
  getMesh:
      (chunkManager: ChunkManager, url: string, getPriority: PriorityGetter,
       cancellationToken: CancellationToken) => Promise<SingleMesh>;
}

interface SingleMeshVertexAttributesFactory {
  description?: string;
  getMeshVertexAttributes:
      (chunkManager: ChunkManager, url: string, getPriority: PriorityGetter,
       cancellationToken: CancellationToken) => Promise<SingleMeshVertexAttributes>;
}

const singleMeshFactories = new Map<string, SingleMeshFactory>();
const singleMeshVertexAttributesFactories = new Map<string, SingleMeshVertexAttributesFactory>();
export function registerSingleMeshFactory(name: string, factory: SingleMeshFactory) {
  singleMeshFactories.set(name, factory);
}

export function registerSingleMeshVertexAttributesFactory(
    name: string, factory: SingleMeshVertexAttributesFactory) {
  singleMeshVertexAttributesFactories.set(name, factory);
}

const protocolPattern = /^(?:([a-zA-Z-+_]+):\/\/)?(.*)$/;

function getDataSource<T>(factories: Map<string, T>, url: string): [T, string, string] {
  let m = url.match(protocolPattern);
  if (m === null || m[1] === undefined) {
    throw new Error(`Data source URL must have the form "<protocol>://<path>".`);
  }
  let dataSource = m[1];
  let factory = factories.get(dataSource);
  if (factory === undefined) {
    throw new Error(`Unsupported data source: ${JSON.stringify(dataSource)}.`);
  }
  return [factory, m[2], dataSource];
}

export function getMesh(
    chunkManager: ChunkManager, url: string, getPriority: PriorityGetter,
    cancellationToken: CancellationToken) {
  let [factory, path] = getDataSource(singleMeshFactories, url);
  return factory.getMesh(chunkManager, path, getPriority, cancellationToken);
}

export function getMeshVertexAttributes(
    chunkManager: ChunkManager, url: string, getPriority: PriorityGetter,
    cancellationToken: CancellationToken) {
  let [factory, path] = getDataSource(singleMeshVertexAttributesFactories, url);
  return factory.getMeshVertexAttributes(chunkManager, path, getPriority, cancellationToken);
}

export function getMinMax(array: TypedArray): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let value of array) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

export function getCombinedMesh(
    chunkManager: ChunkManager, parameters: SingleMeshSourceParameters, getPriority: PriorityGetter,
    cancellationToken: CancellationToken) {
  let promises: Promise<SingleMesh|SingleMeshVertexAttributes>[] =
      [getMesh(chunkManager, parameters.meshSourceUrl, getPriority, cancellationToken)];
  for (let source of parameters.attributeSourceUrls) {
    promises.push(getMeshVertexAttributes(chunkManager, source, getPriority, cancellationToken));
  }
  return Promise.all(promises).then(results => {
    let origMesh = <SingleMesh>results[0];
    let combinedMesh: SingleMesh = {
      info: {
        numVertices: origMesh.info.numVertices,
        numTriangles: origMesh.info.numTriangles,
        vertexAttributes: [],
      },
      vertexPositions: origMesh.vertexPositions,
      indices: origMesh.indices,
      vertexNormals: origMesh.vertexNormals,
      vertexAttributes: [],
    };
    function addAttribute(info: VertexAttributeInfo, data: Float32Array, source?: string) {
      let [min, max] = getMinMax(data);
      combinedMesh.info.vertexAttributes.push({
        name: info.name,
        source,
        numComponents: info.numComponents,
        dataType: info.dataType,
        min,
        max
      });
      combinedMesh.vertexAttributes.push(data);
    }
    function addAttributes(info: VertexAttributeInfo[], data: Float32Array[], source?: string) {
      const numAttributes = info.length;
      for (let i = 0; i < numAttributes; ++i) {
        addAttribute(info[i], data[i], source);
      }
    }
    addAttributes(origMesh.info.vertexAttributes, origMesh.vertexAttributes);
    parameters.attributeSourceUrls.forEach((source, i) => {
      let result = <SingleMeshVertexAttributes>results[i + 1];
      if (result.numVertices !== origMesh.info.numVertices) {
        throw new Error(
            `Vertex attribute source ${JSON.stringify(source)} specifies attributes for ` +
            `${result.numVertices} vertices, but mesh has ${origMesh.info.numVertices} vertices.`);
      }
      addAttributes(result.attributeInfo, result.attributes, source);
    });
    return combinedMesh;
  });
}

@registerSharedObject(SINGLE_MESH_SOURCE_RPC_ID)
export class SingleMeshSource extends ChunkSource {
  parameters: SingleMeshSourceParameters;
  info: SingleMeshInfo;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
    this.info = options['info'];
  }

  getChunk() {
    const key = SINGLE_MESH_CHUNK_KEY;
    let chunk = <SingleMeshChunk>this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(SingleMeshChunk);
      chunk.initialize(key);
      this.addChunk(chunk);
    }
    return chunk;
  }

  download(chunk: SingleMeshChunk, cancellationToken: CancellationToken) {
    const getPriority = () => ({priorityTier: chunk.priorityTier, priority: chunk.priority});
    return getCombinedMesh(this.chunkManager, this.parameters, getPriority, cancellationToken)
        .then(data => {
          if (stableStringify(data.info) !== stableStringify(this.info)) {
            throw new Error(`Mesh info has changed.`);
          }
          if (data.vertexNormals === undefined) {
            data.vertexNormals = computeVertexNormals(data.vertexPositions, data.indices);
          }
          chunk.data = data;
        });
  }
}

const SingleMeshLayerBase = withSharedVisibility(withChunkManager(SharedObjectCounterpart));
@registerSharedObject(SINGLE_MESH_LAYER_RPC_ID)
export class SingleMeshLayer extends SingleMeshLayerBase {
  source: SingleMeshSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(rpc.getRef<SingleMeshSource>(options['source']));
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
    const chunk = source.getChunk();
    chunkManager.requestChunk(chunk, priorityTier, basePriority + SINGLE_MESH_CHUNK_PRIORITY);
  }
}

const INFO_PRIORITY = 1000;

registerPromiseRPC(
    GET_SINGLE_MESH_INFO_RPC_ID, function(x, cancellationToken): RPCPromise<SingleMeshInfo> {
      let chunkManager = this.getRef<ChunkManager>(x['chunkManager']);
      try {
        let parameters = <SingleMeshSourceParameters>x['parameters'];
        return getCombinedMesh(
                   chunkManager, parameters,
                   () => ({priorityTier: ChunkPriorityTier.VISIBLE, priority: INFO_PRIORITY}),
                   cancellationToken)
            .then(mesh => ({value: mesh.info}));
      } finally {
        chunkManager.dispose();
      }
    });
