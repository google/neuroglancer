/**
 * @license
 * Copyright 2026 Google Inc.
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

/**
 * @file Defines the main-thread spatial skeleton source, whose chunks upload
 * their node positions and segment IDs to the GPU.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import {
  type EditableSkeletonSource,
  type SkeletonFragmentSource,
  type SkeletonSpatialIndexMetadata,
} from "#src/skeleton/api.js";
import {
  freeSkeletonChunkGPUMemory,
  type PackedSkeletonGeometry,
  type SkeletonChunkBase,
  uploadSkeletonChunkToGPU,
  type VertexAttributeRenderInfo,
  vertexPositionAttribute,
} from "#src/skeleton/frontend.js";
import { type SpatiallyIndexedSkeletonChunkSpecification } from "#src/skeleton/spatial/base.js";
import { getSpatialSkeletonLevelSpecs } from "#src/skeleton/spatial/base.js";
import {
  SliceViewChunk,
  SliceViewChunkSource,
  MultiscaleSliceViewChunkSource,
  type SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import { DataType } from "#src/util/data_type.js";
import { type Borrowed } from "#src/util/disposable.js";
import type { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import {
  computeTextureFormat,
  setOneDimensionalTextureData,
  TextureFormat,
} from "#src/webgl/texture_access.js";

export interface SkeletonPickGeometry {
  readonly indices: Uint32Array;
  readonly numVertices: number;
  readonly nodeIds: BigUint64Array;
  readonly nodePositions: Float32Array;
  readonly segmentIds: BigUint64Array;
}

const segmentIdTextureFormat = computeTextureFormat(
  new TextureFormat(),
  DataType.UINT64,
  1,
);

export function uploadSegmentIdTexture(
  gl: GL,
  segmentIds: BigUint64Array,
): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
  setOneDimensionalTextureData(
    gl,
    segmentIdTextureFormat,
    new Uint8Array(
      segmentIds.buffer,
      segmentIds.byteOffset,
      segmentIds.byteLength,
    ),
  );
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
  return texture;
}

export interface PackedSpatiallyIndexedSkeletonGeometry
  extends PackedSkeletonGeometry {
  nodeIds: BigUint64Array;
  segmentIds: BigUint64Array;
}

export class SpatiallyIndexedSkeletonChunk
  extends SliceViewChunk
  implements SkeletonChunkBase, SkeletonPickGeometry
{
  declare source: SpatiallyIndexedSkeletonSource;
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  indexBuffer!: GLBuffer;
  numIndices: number;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  vertexAttributeTextures: (WebGLTexture | null)[] = [];
  segmentIdTexture: WebGLTexture | null = null;
  readonly nodeIds: BigUint64Array;
  readonly nodePositions: Float32Array;
  readonly segmentIds: BigUint64Array;

  constructor(
    source: SpatiallyIndexedSkeletonSource,
    chunkData: PackedSpatiallyIndexedSkeletonGeometry,
  ) {
    super(source, chunkData);
    this.vertexAttributes = chunkData.vertexAttributes;
    const indices = (this.indices = chunkData.indices);
    this.numVertices = chunkData.numVertices;
    this.numIndices = indices.length;
    this.vertexAttributeOffsets = chunkData.vertexAttributeOffsets;
    this.nodeIds = chunkData.nodeIds;
    this.nodePositions = new Float32Array(
      this.vertexAttributes.buffer,
      this.vertexAttributes.byteOffset + this.vertexAttributeOffsets[0],
      this.numVertices * 3,
    );
    this.segmentIds = chunkData.segmentIds;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    uploadSkeletonChunkToGPU(gl, this);
    this.segmentIdTexture = uploadSegmentIdTexture(gl, this.segmentIds);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    freeSkeletonChunkGPUMemory(gl, this);
    gl.deleteTexture(this.segmentIdTexture);
    this.segmentIdTexture = null;
  }
}

const spatiallyIndexedSkeletonTextureAttributeSpecs = Object.freeze([
  { name: "position", dataType: DataType.FLOAT32, numComponents: 3 },
]);

export class SpatiallyIndexedSkeletonSource extends SliceViewChunkSource<
  SpatiallyIndexedSkeletonChunkSpecification,
  SpatiallyIndexedSkeletonChunk
> {
  vertexAttributes: VertexAttributeRenderInfo[];
  private attributeTextureFormats_?: TextureFormat[];

  constructor(chunkManager: ChunkManager, options: any) {
    super(chunkManager, options);
    this.vertexAttributes = [vertexPositionAttribute];
  }

  get attributeTextureFormats() {
    let attributeTextureFormats = this.attributeTextureFormats_;
    if (attributeTextureFormats === undefined) {
      attributeTextureFormats = this.attributeTextureFormats_ =
        spatiallyIndexedSkeletonTextureAttributeSpecs.map(
          ({ dataType, numComponents }) =>
            computeTextureFormat(new TextureFormat(), dataType, numComponents),
        );
    }
    return attributeTextureFormats;
  }

  static encodeSpec(spec: SpatiallyIndexedSkeletonChunkSpecification) {
    const base = SliceViewChunkSource.encodeSpec(spec);
    return { ...base, chunkLayout: spec.chunkLayout.toObject() };
  }

  getChunk(chunkData: PackedSpatiallyIndexedSkeletonGeometry) {
    return new SpatiallyIndexedSkeletonChunk(this, chunkData);
  }
}

export function disposeSpatiallyIndexedSkeletonSourceRuntimeState(
  sources: Iterable<SpatiallyIndexedSkeletonSource>,
) {
  const uniqueSources = new Set(sources);
  const chunkQueueManagersWithDeletedChunks = new Set<
    ChunkManager["chunkQueueManager"]
  >();
  for (const source of uniqueSources) {
    if (source.chunks.size !== 0) {
      for (const chunkKey of source.chunks.keys()) {
        source.deleteChunk(chunkKey);
      }
      chunkQueueManagersWithDeletedChunks.add(
        source.chunkManager.chunkQueueManager,
      );
    }
    if (
      source.wasDisposed !== true &&
      source.rpc !== null &&
      source.rpcId !== null
    ) {
      source.invalidateCache();
    }
  }
  for (const chunkQueueManager of chunkQueueManagersWithDeletedChunks) {
    chunkQueueManager.visibleChunksChanged.dispatch();
  }
}

export abstract class MultiscaleSpatiallyIndexedSkeletonSource extends MultiscaleSliceViewChunkSource<SpatiallyIndexedSkeletonSource> {
  abstract readonly fragmentSource: SkeletonFragmentSource;
  private readonly levelSpecs: SpatiallyIndexedSkeletonChunkSpecification[];
  // Undefined when the source cannot be edited.
  abstract readonly editableSource: EditableSkeletonSource | undefined;

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    protected readonly metadata: SkeletonSpatialIndexMetadata,
  ) {
    super(chunkManager);
    this.levelSpecs = getSpatialSkeletonLevelSpecs(metadata);
  }

  get rank() {
    return 3;
  }

  abstract override getSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[][];

  getLevelSpecs(): SpatiallyIndexedSkeletonChunkSpecification[] {
    return this.levelSpecs;
  }
}
