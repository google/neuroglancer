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

import {
  Chunk,
  ChunkSource,
  withChunkManager,
  WithParameters,
} from "#src/chunk_manager/backend.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { computeVertexNormals } from "#src/mesh/backend.js";
import type {
  SingleMeshData,
  SingleMeshInfo,
  SingleMeshSourceParameters,
  VertexAttributeInfo,
} from "#src/single_mesh/base.js";
import {
  GET_SINGLE_MESH_INFO_RPC_ID,
  SINGLE_MESH_CHUNK_KEY,
  SINGLE_MESH_LAYER_RPC_ID,
  SingleMeshSourceParametersWithInfo,
} from "#src/single_mesh/base.js";
import type { TypedNumberArray } from "#src/util/array.js";
import { stableStringify } from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import {
  getBasePriority,
  getPriorityTier,
  withSharedVisibility,
} from "#src/visibility_priority/backend.js";
import type { RPC, RPCPromise } from "#src/worker_rpc.js";
import {
  registerPromiseRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

const SINGLE_MESH_CHUNK_PRIORITY = 50;

/**
 * Chunk that contains the single mesh.
 */
export class SingleMeshChunk extends Chunk {
  data: SingleMeshData | null = null;
  freeSystemMemory() {
    this.data = null;
  }
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    const { vertexPositions, indices, vertexNormals, vertexAttributes } =
      this.data!;
    msg.vertexPositions = vertexPositions;
    msg.indices = indices;
    msg.vertexNormals = vertexNormals;
    msg.vertexAttributes = vertexAttributes;
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
    const { vertexPositions, indices, vertexNormals, vertexAttributes } =
      this.data!;
    let totalBytes = (this.gpuMemoryBytes =
      vertexPositions.byteLength +
      indices.byteLength +
      vertexNormals!.byteLength);
    for (const data of vertexAttributes) {
      totalBytes += data.byteLength;
    }
    this.systemMemoryBytes = this.gpuMemoryBytes = totalBytes;
    super.downloadSucceeded();
  }
}

export interface SingleMesh extends SingleMeshData {
  info: SingleMeshInfo;
}

export interface SingleMeshVertexAttributes {
  numVertices: number;
  attributeInfo: VertexAttributeInfo[];
  attributes: Float32Array[];
}

interface SingleMeshFactory {
  description?: string;
  getMesh: (
    sharedKvStoreContext: SharedKvStoreContextCounterpart,
    url: string,
    options: Partial<ProgressOptions>,
  ) => Promise<SingleMesh>;
}

const singleMeshFactories = new Map<string, SingleMeshFactory>();
export function registerSingleMeshFactory(
  name: string,
  factory: SingleMeshFactory,
) {
  singleMeshFactories.set(name, factory);
}

const protocolPattern = /^(?:([a-zA-Z-+_]+):\/\/)?(.*)$/;

function getDataSource<T>(
  factories: Map<string, T>,
  url: string,
): [T, string, string] {
  const m = url.match(protocolPattern);
  if (m === null || m[1] === undefined) {
    throw new Error(
      `Data source URL must have the form "<protocol>://<path>".`,
    );
  }
  const dataSource = m[1];
  const factory = factories.get(dataSource);
  if (factory === undefined) {
    throw new Error(`Unsupported data source: ${JSON.stringify(dataSource)}.`);
  }
  return [factory, m[2], dataSource];
}

export function getMesh(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  options: Partial<ProgressOptions>,
) {
  const [factory, path] = getDataSource(singleMeshFactories, url);
  return factory.getMesh(sharedKvStoreContext, path, options);
}

export function getMinMax(array: TypedNumberArray): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of array) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

export function getCombinedMesh(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  parameters: SingleMeshSourceParameters,
  options: Partial<ProgressOptions>,
) {
  return getMesh(sharedKvStoreContext, parameters.meshSourceUrl, options);
}

@registerSharedObject()
export class SingleMeshSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(ChunkSource),
  SingleMeshSourceParametersWithInfo,
) {
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

  async download(chunk: SingleMeshChunk, signal: AbortSignal) {
    const data = await getCombinedMesh(
      this.sharedKvStoreContext,
      this.parameters,
      {
        signal,
      },
    );
    if (stableStringify(data.info) !== stableStringify(this.parameters.info)) {
      throw new Error("Mesh info has changed.");
    }
    if (data.vertexNormals === undefined) {
      data.vertexNormals = computeVertexNormals(
        data.vertexPositions,
        data.indices,
      );
    }
    chunk.data = data;
  }
}

const SingleMeshLayerBase = withSharedVisibility(
  withChunkManager(SharedObjectCounterpart),
);
@registerSharedObject(SINGLE_MESH_LAYER_RPC_ID)
export class SingleMeshLayer extends SingleMeshLayerBase {
  source: SingleMeshSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(
      rpc.getRef<SingleMeshSource>(options.source),
    );
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() => {
        this.updateChunkPriorities();
      }),
    );
  }

  private updateChunkPriorities() {
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    const priorityTier = getPriorityTier(visibility);
    const basePriority = getBasePriority(visibility);
    const { source, chunkManager } = this;
    const chunk = source.getChunk();
    chunkManager.requestChunk(
      chunk,
      priorityTier,
      basePriority + SINGLE_MESH_CHUNK_PRIORITY,
    );
  }
}

registerPromiseRPC(
  GET_SINGLE_MESH_INFO_RPC_ID,
  async function (x, progressOptions): RPCPromise<SingleMeshInfo> {
    const sharedKvStoreContext = this.get(
      x.sharedKvStoreContext,
    ) as SharedKvStoreContextCounterpart;
    const parameters = <SingleMeshSourceParameters>x.parameters;
    const mesh = await getCombinedMesh(
      sharedKvStoreContext,
      parameters,
      progressOptions,
    );
    return { value: mesh.info };
  },
);
