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

import type {
  AnnotationGeometryChunk,
  AnnotationMetadataChunk,
  AnnotationSubsetGeometryChunk,
} from "#src/annotation/backend.js";
import {
  AnnotationGeometryData,
  AnnotationSource,
  AnnotationGeometryChunkSourceBackend,
} from "#src/annotation/backend.js";
import type { Annotation } from "#src/annotation/index.js";
import {
  AnnotationPropertySerializer,
  annotationTypeHandlers,
  annotationTypes,
} from "#src/annotation/index.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import {
  AnnotationSourceParameters,
  AnnotationSpatialIndexSourceParameters,
  MeshSourceParameters,
  MultiscaleMeshSourceParameters,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/precomputed/base.js";
import type {
  ShardedKvStore,
  ShardInfo,
} from "#src/datasource/precomputed/sharded.js";
import { getShardedKvStoreIfApplicable } from "#src/datasource/precomputed/sharded.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { KvStoreWithPath, ReadResponse } from "#src/kvstore/index.js";
import { readKvStore } from "#src/kvstore/index.js";
import type {
  FragmentChunk,
  ManifestChunk,
  MultiscaleFragmentChunk,
  MultiscaleManifestChunk,
} from "#src/mesh/backend.js";
import {
  assignMeshFragmentData,
  assignMultiscaleMeshFragmentData,
  computeOctreeChildOffsets,
  decodeJsonManifestChunk,
  decodeTriangleVertexPositionsAndIndices,
  generateHigherOctreeLevel,
  MeshSource,
  MultiscaleMeshSource,
} from "#src/mesh/backend.js";
import { decodeDracoPartitioned } from "#src/mesh/draco/index.js";
import type { SkeletonChunk } from "#src/skeleton/backend.js";
import { SkeletonSource } from "#src/skeleton/backend.js";
import { decodeSkeletonChunk } from "#src/skeleton/decode_precomputed_skeleton.js";
import { decodeCompressedSegmentationChunk } from "#src/sliceview/backend_chunk_decoders/compressed_segmentation.js";
import { decodeCompressoChunk } from "#src/sliceview/backend_chunk_decoders/compresso.js";
import type { ChunkDecoder } from "#src/sliceview/backend_chunk_decoders/index.js";
import { decodeJpegChunk } from "#src/sliceview/backend_chunk_decoders/jpeg.js";
import { decodeJxlChunk } from "#src/sliceview/backend_chunk_decoders/jxl.js";
import { decodePngChunk } from "#src/sliceview/backend_chunk_decoders/png.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { convertEndian32, Endianness } from "#src/util/endian.js";
import { vec3 } from "#src/util/geom.js";
import {
  encodeZIndexCompressed,
  encodeZIndexCompressed3d,
  zorder3LessThan,
} from "#src/util/zorder.js";
import { registerSharedObject } from "#src/worker_rpc.js";

// Set to true to validate the multiscale index.
const DEBUG_MULTISCALE_INDEX = false;

function getOrNotFoundError<T>(v: T | undefined) {
  if (v === undefined) throw new Error("not found");
  return v;
}

const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(
  VolumeChunkEncoding.COMPRESSED_SEGMENTATION,
  decodeCompressedSegmentationChunk,
);
chunkDecoders.set(VolumeChunkEncoding.COMPRESSO, decodeCompressoChunk);
chunkDecoders.set(VolumeChunkEncoding.PNG, decodePngChunk);
chunkDecoders.set(VolumeChunkEncoding.JXL, decodeJxlChunk);

@registerSharedObject()
export class PrecomputedVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;
  kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.url,
  );
  shardedKvStore = getShardedKvStoreIfApplicable(
    this,
    this.kvStore,
    this.parameters.sharding,
  );

  gridShape = (() => {
    const gridShape = new Uint32Array(3);
    const { upperVoxelBound, chunkDataSize } = this.spec;
    for (let i = 0; i < 3; ++i) {
      gridShape[i] = Math.ceil(upperVoxelBound[i] / chunkDataSize[i]);
    }
    return gridShape;
  })();

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    const { shardedKvStore } = this;
    let readResponse: ReadResponse | undefined;
    if (shardedKvStore === undefined) {
      const { kvStore } = this;
      let path: string;
      {
        // chunkPosition must not be captured, since it will be invalidated by the next call to
        // computeChunkBounds.
        const chunkPosition = this.computeChunkBounds(chunk);
        const chunkDataSize = chunk.chunkDataSize!;
        path =
          `${kvStore.path}${chunkPosition[0]}-${
            chunkPosition[0] + chunkDataSize[0]
          }_` +
          `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
          `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
      }
      readResponse = await kvStore.store.read(path, { signal });
    } else {
      this.computeChunkBounds(chunk);
      const { gridShape } = this;
      const { chunkGridPosition } = chunk;
      const xBits = Math.ceil(Math.log2(gridShape[0]));
      const yBits = Math.ceil(Math.log2(gridShape[1]));
      const zBits = Math.ceil(Math.log2(gridShape[2]));
      const chunkIndex = encodeZIndexCompressed3d(
        xBits,
        yBits,
        zBits,
        chunkGridPosition[0],
        chunkGridPosition[1],
        chunkGridPosition[2],
      );
      readResponse = await shardedKvStore.read(chunkIndex, { signal });
    }
    if (readResponse !== undefined) {
      await this.chunkDecoder(
        chunk,
        signal,
        await readResponse.response.arrayBuffer(),
      );
    }
  }
}

export function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, "fragments");
}

export function decodeFragmentChunk(
  chunk: FragmentChunk,
  response: ArrayBuffer,
) {
  const dv = new DataView(response);
  const numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
    chunk,
    decodeTriangleVertexPositionsAndIndices(
      response,
      Endianness.LITTLE,
      /*vertexByteOffset=*/ 4,
      numVertices,
    ),
  );
}

@registerSharedObject()
export class PrecomputedMeshSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(MeshSource),
  MeshSourceParameters,
) {
  kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.url,
  );
  async download(chunk: ManifestChunk, signal: AbortSignal) {
    const { parameters, kvStore } = this;
    const response = await readKvStore(
      kvStore.store,
      `${kvStore.path}${chunk.objectId}:${parameters.lod}`,
      { signal, throwIfMissing: true },
    );
    decodeManifestChunk(chunk, await response.response.json());
  }

  async downloadFragment(chunk: FragmentChunk, signal: AbortSignal) {
    const { kvStore } = this;
    const response = await readKvStore(
      kvStore.store,
      `${kvStore.path}${chunk.fragmentId}`,
      { signal, throwIfMissing: true },
    );
    decodeFragmentChunk(chunk, await response.response.arrayBuffer());
  }
}

interface PrecomputedMultiscaleManifestChunk extends MultiscaleManifestChunk {
  /**
   * Byte offsets into data file for each octree node.
   *
   * Stored as Float64Array to allow 53-bit integer values.
   */
  offsets: Float64Array;
  shardInfo?: ShardInfo;
}

function decodeMultiscaleManifestChunk(
  chunk: PrecomputedMultiscaleManifestChunk,
  response: ArrayBuffer,
) {
  if (response.byteLength < 28 || response.byteLength % 4 !== 0) {
    throw new Error(`Invalid index file size: ${response.byteLength}`);
  }
  const dv = new DataView(response);
  let offset = 0;
  const chunkShape = vec3.fromValues(
    dv.getFloat32(offset, /*littleEndian=*/ true),
    dv.getFloat32(offset + 4, /*littleEndian=*/ true),
    dv.getFloat32(offset + 8, /*littleEndian=*/ true),
  );
  offset += 12;
  const gridOrigin = vec3.fromValues(
    dv.getFloat32(offset, /*littleEndian=*/ true),
    dv.getFloat32(offset + 4, /*littleEndian=*/ true),
    dv.getFloat32(offset + 8, /*littleEndian=*/ true),
  );
  offset += 12;
  const numStoredLods = dv.getUint32(offset, /*littleEndian=*/ true);
  offset += 4;
  if (response.byteLength < offset + (4 + 4 + 4 * 3) * numStoredLods) {
    throw new Error(
      `Invalid index file size for ${numStoredLods} lods: ${response.byteLength}`,
    );
  }
  const storedLodScales = new Float32Array(response, offset, numStoredLods);
  offset += 4 * numStoredLods;
  convertEndian32(storedLodScales, Endianness.LITTLE);
  const vertexOffsets = new Float32Array(response, offset, numStoredLods * 3);
  convertEndian32(vertexOffsets, Endianness.LITTLE);
  offset += 12 * numStoredLods;
  const numFragmentsPerLod = new Uint32Array(response, offset, numStoredLods);
  offset += 4 * numStoredLods;
  convertEndian32(numFragmentsPerLod, Endianness.LITTLE);
  const totalFragments = numFragmentsPerLod.reduce((a, b) => a + b);
  if (response.byteLength !== offset + 16 * totalFragments) {
    throw new Error(
      `Invalid index file size for ${numStoredLods} lods and ` +
        `${totalFragments} total fragments: ${response.byteLength}`,
    );
  }
  const fragmentInfo = new Uint32Array(response, offset);
  convertEndian32(fragmentInfo, Endianness.LITTLE);
  const clipLowerBound = vec3.fromValues(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const clipUpperBound = vec3.fromValues(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  let numLods = Math.max(1, storedLodScales.length);
  // Compute `clipLowerBound` and `clipUpperBound` and `numLods`.  Note that `numLods` is >=
  // `storedLodScales.length`; it may contain additional levels since at the highest level the
  // octree must be a single node.
  {
    let fragmentBase = 0;
    for (let lodIndex = 0; lodIndex < numStoredLods; ++lodIndex) {
      const numFragments = numFragmentsPerLod[lodIndex];
      if (DEBUG_MULTISCALE_INDEX) {
        for (let i = 1; i < numFragments; ++i) {
          const x0 = fragmentInfo[fragmentBase + numFragments * 0 + (i - 1)];
          const y0 = fragmentInfo[fragmentBase + numFragments * 1 + (i - 1)];
          const z0 = fragmentInfo[fragmentBase + numFragments * 2 + (i - 1)];
          const x1 = fragmentInfo[fragmentBase + numFragments * 0 + i];
          const y1 = fragmentInfo[fragmentBase + numFragments * 1 + i];
          const z1 = fragmentInfo[fragmentBase + numFragments * 2 + i];
          if (!zorder3LessThan(x0, y0, z0, x1, y1, z1)) {
            console.log(
              "Fragment index violates zorder constraint: " +
                `lod=${lodIndex}, ` +
                `chunk ${i - 1} = [${x0},${y0},${z0}], ` +
                `chunk ${i} = [${x1},${y1},${z1}]`,
            );
          }
        }
      }
      for (let i = 0; i < 3; ++i) {
        let upperBoundValue = Number.NEGATIVE_INFINITY;
        let lowerBoundValue = Number.POSITIVE_INFINITY;
        const base = fragmentBase + numFragments * i;
        for (let j = 0; j < numFragments; ++j) {
          const v = fragmentInfo[base + j];
          upperBoundValue = Math.max(upperBoundValue, v);
          lowerBoundValue = Math.min(lowerBoundValue, v);
        }
        if (numFragments !== 0) {
          while (
            upperBoundValue >>> (numLods - lodIndex - 1) !==
            lowerBoundValue >>> (numLods - lodIndex - 1)
          ) {
            ++numLods;
          }
          if (lodIndex === 0) {
            clipLowerBound[i] = Math.min(
              clipLowerBound[i],
              (1 << lodIndex) * lowerBoundValue,
            );
            clipUpperBound[i] = Math.max(
              clipUpperBound[i],
              (1 << lodIndex) * (upperBoundValue + 1),
            );
          }
        }
      }
      fragmentBase += numFragments * 4;
    }
  }

  // Compute upper bound on number of nodes that will be in the octree, so that we can allocate a
  // sufficiently large buffer without having to worry about resizing.
  let maxFragments = 0;
  {
    let prevNumFragments = 0;
    let prevLodIndex = 0;
    for (let lodIndex = 0; lodIndex < numStoredLods; ++lodIndex) {
      const numFragments = numFragmentsPerLod[lodIndex];
      maxFragments += prevNumFragments * (lodIndex - prevLodIndex);
      prevLodIndex = lodIndex;
      prevNumFragments = numFragments;
      maxFragments += numFragments;
    }
    maxFragments += (numLods - 1 - prevLodIndex) * prevNumFragments;
  }
  const octreeTemp = new Uint32Array(5 * maxFragments);
  const offsetsTemp = new Float64Array(maxFragments + 1);
  let octree: Uint32Array;
  {
    let priorStart = 0;
    let baseRow = 0;
    let dataOffset = 0;
    let fragmentBase = 0;
    for (let lodIndex = 0; lodIndex < numStoredLods; ++lodIndex) {
      const numFragments = numFragmentsPerLod[lodIndex];
      // Copy in indices
      for (let j = 0; j < numFragments; ++j) {
        for (let i = 0; i < 3; ++i) {
          octreeTemp[5 * (baseRow + j) + i] =
            fragmentInfo[fragmentBase + j + i * numFragments];
        }
        const dataSize = fragmentInfo[fragmentBase + j + 3 * numFragments];
        dataOffset += dataSize;
        offsetsTemp[baseRow + j + 1] = dataOffset;
        if (dataSize === 0) {
          // Mark node as empty.
          octreeTemp[5 * (baseRow + j) + 4] = 0x80000000;
        }
      }

      fragmentBase += 4 * numFragments;

      if (lodIndex !== 0) {
        // Connect with prior level
        computeOctreeChildOffsets(
          octreeTemp,
          priorStart,
          baseRow,
          baseRow + numFragments,
        );
      }

      priorStart = baseRow;
      baseRow += numFragments;
      while (
        lodIndex + 1 < numLods &&
        (lodIndex + 1 >= storedLodScales.length ||
          storedLodScales[lodIndex + 1] === 0)
      ) {
        const curEnd = generateHigherOctreeLevel(
          octreeTemp,
          priorStart,
          baseRow,
        );
        offsetsTemp.fill(dataOffset, baseRow + 1, curEnd + 1);
        priorStart = baseRow;
        baseRow = curEnd;
        ++lodIndex;
      }
    }
    octree = octreeTemp.slice(0, 5 * baseRow);
    chunk.offsets = offsetsTemp.slice(0, baseRow + 1);
  }
  const source = chunk.source! as PrecomputedMultiscaleMeshSource;
  const { lodScaleMultiplier } = source.parameters.metadata;
  const lodScales = new Float32Array(numLods);
  lodScales.set(storedLodScales, 0);
  for (let i = 0; i < storedLodScales.length; ++i) {
    lodScales[i] *= lodScaleMultiplier;
  }
  chunk.manifest = {
    chunkShape,
    chunkGridSpatialOrigin: gridOrigin,
    clipLowerBound: vec3.add(
      clipLowerBound,
      gridOrigin,
      vec3.multiply(clipLowerBound, clipLowerBound, chunkShape),
    ),
    clipUpperBound: vec3.add(
      clipUpperBound,
      gridOrigin,
      vec3.multiply(clipUpperBound, clipUpperBound, chunkShape),
    ),
    octree,
    lodScales,
    vertexOffsets,
  };
}

async function decodeMultiscaleFragmentChunk(
  chunk: MultiscaleFragmentChunk,
  response: ArrayBuffer,
) {
  const { lod } = chunk;
  const source = chunk.manifestChunk!
    .source! as PrecomputedMultiscaleMeshSource;
  const rawMesh = await decodeDracoPartitioned(
    new Uint8Array(response),
    source.parameters.metadata.vertexQuantizationBits,
    lod !== 0,
  );
  assignMultiscaleMeshFragmentData(
    chunk,
    rawMesh,
    source.format.vertexPositionFormat,
  );
}

@registerSharedObject() //
export class PrecomputedMultiscaleMeshSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(MultiscaleMeshSource),
  MultiscaleMeshSourceParameters,
) {
  kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.url,
  );
  shardedKvStore = getShardedKvStoreIfApplicable(
    this,
    this.kvStore,
    this.parameters.metadata.sharding,
  );

  async download(
    chunk: PrecomputedMultiscaleManifestChunk,
    signal: AbortSignal,
  ): Promise<void> {
    const { shardedKvStore } = this;
    let readResponse: ReadResponse | undefined;
    if (shardedKvStore === undefined) {
      const { kvStore } = this;
      readResponse = await kvStore.store.read(
        `${kvStore.path}${chunk.objectId}.index`,
        { signal },
      );
    } else {
      ({ response: readResponse, shardInfo: chunk.shardInfo } =
        getOrNotFoundError(
          await shardedKvStore.readWithShardInfo(chunk.objectId, {
            signal,
          }),
        ));
    }

    const data = await getOrNotFoundError(readResponse).response.arrayBuffer();

    decodeMultiscaleManifestChunk(chunk, data);
  }

  async downloadFragment(
    chunk: MultiscaleFragmentChunk,
    signal: AbortSignal,
  ): Promise<void> {
    const { kvStore } = this;
    const manifestChunk =
      chunk.manifestChunk! as PrecomputedMultiscaleManifestChunk;
    const chunkIndex = chunk.chunkIndex;
    const { shardInfo, offsets } = manifestChunk;
    const startOffset = offsets[chunkIndex];
    const endOffset = offsets[chunkIndex + 1];
    let requestPath: string;
    let adjustedStartOffset: number;
    let adjustedEndOffset: number;
    if (shardInfo !== undefined) {
      requestPath = shardInfo.shardPath;
      const fullDataSize = offsets[offsets.length - 1];
      const start = shardInfo.offset - fullDataSize + startOffset;
      const end = start + endOffset - startOffset;
      adjustedStartOffset = start;
      adjustedEndOffset = end;
    } else {
      requestPath = `${kvStore.path}${manifestChunk.objectId}`;
      adjustedStartOffset = startOffset;
      adjustedEndOffset = endOffset;
    }
    const readResponse = await readKvStore(kvStore.store, requestPath, {
      signal,
      byteRange: {
        offset: adjustedStartOffset,
        length: adjustedEndOffset - adjustedStartOffset,
      },
      throwIfMissing: true,
      strictByteRange: true,
    });
    await decodeMultiscaleFragmentChunk(
      chunk,
      await readResponse.response.arrayBuffer(),
    );
  }
}

async function fetchByUint64(
  chunkSource: {
    kvStore: KvStoreWithPath;
    shardedKvStore: ShardedKvStore | undefined;
  },
  id: bigint,
  signal: AbortSignal,
): Promise<ReadResponse | undefined> {
  const { shardedKvStore } = chunkSource;
  if (shardedKvStore === undefined) {
    const { kvStore } = chunkSource;
    return kvStore.store.read(`${kvStore.path}${id}`, {
      signal,
    });
  } else {
    return shardedKvStore.read(id, { signal });
  }
}

@registerSharedObject() //
export class PrecomputedSkeletonSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(SkeletonSource),
  SkeletonSourceParameters,
) {
  kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.url,
  );
  shardedKvStore = getShardedKvStoreIfApplicable(
    this,
    this.kvStore,
    this.parameters.metadata.sharding,
  );
  async download(chunk: SkeletonChunk, signal: AbortSignal) {
    const { parameters } = this;
    const response = getOrNotFoundError(
      await fetchByUint64(this, chunk.objectId, signal),
    );
    decodeSkeletonChunk(
      chunk,
      await response.response.arrayBuffer(),
      parameters.metadata.vertexAttributes,
    );
  }
}

function parseAnnotations(
  buffer: ArrayBuffer,
  parameters: AnnotationSourceParameters,
  propertySerializer: AnnotationPropertySerializer,
): AnnotationGeometryData {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 8) throw new Error("Expected at least 8 bytes");
  const countLow = dv.getUint32(0, /*littleEndian=*/ true);
  const countHigh = dv.getUint32(4, /*littleEndian=*/ true);
  if (countHigh !== 0) throw new Error("Annotation count too high");
  const numBytes = propertySerializer.serializedBytes;
  const expectedBytes = 8 + (numBytes + 8) * countLow;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `Expected ${expectedBytes} bytes, but received: ${buffer.byteLength} bytes`,
    );
  }
  const idOffset = 8 + numBytes * countLow;
  const ids = new Array<string>(countLow);
  for (let i = 0; i < countLow; ++i) {
    ids[i] = dv
      .getBigUint64(idOffset + i * 8, /*littleEndian=*/ true)
      .toString();
  }
  const geometryData = new AnnotationGeometryData();
  const origData = new Uint8Array(buffer, 8, numBytes * countLow);
  let data: Uint8Array<ArrayBuffer>;
  const { propertyGroupBytes } = propertySerializer;
  if (propertyGroupBytes.length > 1) {
    // Need to transpose the property data.
    data = new Uint8Array(origData.length);

    let origOffset = 0;
    let groupOffset = 0;
    for (
      let groupIndex = 0;
      groupIndex < propertyGroupBytes.length;
      ++groupIndex
    ) {
      const groupBytesPerAnnotation = propertyGroupBytes[groupIndex];
      for (
        let annotationIndex = 0;
        annotationIndex < countLow;
        ++annotationIndex
      ) {
        const origBase = origOffset + annotationIndex * numBytes;
        const newBase = groupOffset + annotationIndex * groupBytesPerAnnotation;
        for (let i = 0; i < groupBytesPerAnnotation; ++i) {
          data[newBase + i] = origData[origBase + i];
        }
      }
      origOffset += groupBytesPerAnnotation;
      groupOffset += groupBytesPerAnnotation * countLow;
    }
  } else {
    data = origData;
  }
  geometryData.data = data;
  // FIXME: convert endian in order to support big endian platforms
  const typeToOffset = (geometryData.typeToOffset = new Array<number>(
    annotationTypes.length,
  ));
  typeToOffset.fill(0);
  typeToOffset[parameters.type] = 0;
  const typeToIds = (geometryData.typeToIds = new Array<string[]>(
    annotationTypes.length,
  ));
  const typeToIdMaps = (geometryData.typeToIdMaps = new Array<
    Map<string, number>
  >(annotationTypes.length));
  typeToIds.fill([]);
  typeToIds[parameters.type] = ids;
  typeToIdMaps.fill(new Map());
  typeToIdMaps[parameters.type] = new Map(ids.map((id, i) => [id, i]));
  return geometryData;
}

function parseSingleAnnotation(
  buffer: ArrayBuffer,
  parameters: AnnotationSourceParameters,
  propertySerializer: AnnotationPropertySerializer,
  id: string,
): Annotation {
  const handler = annotationTypeHandlers[parameters.type];
  const baseNumBytes = propertySerializer.serializedBytes;
  const numRelationships = parameters.relationships.length;
  const minNumBytes = baseNumBytes + 4 * numRelationships;
  if (buffer.byteLength < minNumBytes) {
    throw new Error(
      `Expected at least ${minNumBytes} bytes, but received: ${buffer.byteLength}`,
    );
  }
  const dv = new DataView(buffer);
  const annotation = handler.deserialize(
    dv,
    0,
    /*isLittleEndian=*/ true,
    parameters.rank,
    id,
  );
  propertySerializer.deserialize(
    dv,
    /*offset=*/ 0,
    /*annotationIndex=*/ 0,
    /*annotationCount=*/ 1,
    /*isLittleEndian=*/ true,
    (annotation.properties = new Array(parameters.properties.length)),
  );
  let offset = baseNumBytes;
  const relatedSegments: BigUint64Array[] = (annotation.relatedSegments = []);
  relatedSegments.length = numRelationships;
  for (let i = 0; i < numRelationships; ++i) {
    const count = dv.getUint32(offset, /*littleEndian=*/ true);
    if (buffer.byteLength < minNumBytes + count * 8) {
      throw new Error(
        `Expected at least ${minNumBytes} bytes, but received: ${buffer.byteLength}`,
      );
    }
    offset += 4;
    const segments = (relatedSegments[i] = new BigUint64Array(count));
    for (let j = 0; j < count; ++j) {
      segments[j] = dv.getBigUint64(offset, /*littleEndian=*/ true);
      offset += 8;
    }
  }
  if (offset !== buffer.byteLength) {
    throw new Error(
      `Expected ${offset} bytes, but received: ${buffer.byteLength}`,
    );
  }
  return annotation;
}

@registerSharedObject() //
export class PrecomputedAnnotationSpatialIndexSourceBackend extends WithParameters(
  WithSharedKvStoreContextCounterpart(AnnotationGeometryChunkSourceBackend),
  AnnotationSpatialIndexSourceParameters,
) {
  kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.url,
  );
  shardedKvStore = getShardedKvStoreIfApplicable(
    this,
    this.kvStore,
    this.parameters.sharding,
  );
  declare parent: PrecomputedAnnotationSourceBackend;
  async download(chunk: AnnotationGeometryChunk, signal: AbortSignal) {
    const { shardedKvStore } = this;
    const { parent } = this;
    let response: ReadResponse | undefined;
    const { chunkGridPosition } = chunk;
    if (shardedKvStore === undefined) {
      const { kvStore } = this;
      const path = `${kvStore.path}${chunkGridPosition.join("_")}`;
      response = await kvStore.store.read(path, { signal });
    } else {
      const { upperChunkBound } = this.spec;
      const { chunkGridPosition } = chunk;
      const chunkIndex = encodeZIndexCompressed(
        chunkGridPosition,
        upperChunkBound,
      );
      response = await shardedKvStore.read(chunkIndex, { signal });
    }
    if (response !== undefined) {
      chunk.data = parseAnnotations(
        await response.response.arrayBuffer(),
        parent.parameters,
        parent.annotationPropertySerializer,
      );
    }
  }
}

@registerSharedObject() //
export class PrecomputedAnnotationSourceBackend extends WithParameters(
  WithSharedKvStoreContextCounterpart(AnnotationSource),
  AnnotationSourceParameters,
) {
  kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.byId.url,
  );
  shardedKvStore = getShardedKvStoreIfApplicable(
    this,
    this.kvStore,
    this.parameters.byId.sharding,
  );
  private relationshipIndexSource = this.parameters.relationships.map((x) => {
    const kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(x.url);
    const shardedKvStore = getShardedKvStoreIfApplicable(
      this,
      kvStore,
      x.sharding,
    );
    return { kvStore, shardedKvStore };
  });
  annotationPropertySerializer = new AnnotationPropertySerializer(
    this.parameters.rank,
    annotationTypeHandlers[this.parameters.type].serializedBytes(
      this.parameters.rank,
    ),
    this.parameters.properties,
  );

  async downloadSegmentFilteredGeometry(
    chunk: AnnotationSubsetGeometryChunk,
    relationshipIndex: number,
    signal: AbortSignal,
  ) {
    const response = await fetchByUint64(
      this.relationshipIndexSource[relationshipIndex],
      chunk.objectId,
      signal,
    );
    if (response !== undefined) {
      chunk.data = parseAnnotations(
        await response.response.arrayBuffer(),
        this.parameters,
        this.annotationPropertySerializer,
      );
    }
  }

  async downloadMetadata(chunk: AnnotationMetadataChunk, signal: AbortSignal) {
    const id = BigInt(chunk.key!);
    const response = await fetchByUint64(this, id, signal);
    if (response === undefined) {
      chunk.annotation = null;
    } else {
      chunk.annotation = parseSingleAnnotation(
        await response.response.arrayBuffer(),
        this.parameters,
        this.annotationPropertySerializer,
        chunk.key!,
      );
    }
  }
}
