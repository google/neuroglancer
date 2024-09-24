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
import { decodeGzip } from "#src/async_computation/decode_gzip_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import type { Chunk, ChunkManager } from "#src/chunk_manager/backend.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import { GenericSharedDataSource } from "#src/chunk_manager/generic_file_source.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import type { ShardingParameters } from "#src/datasource/precomputed/base.js";
import {
  AnnotationSourceParameters,
  AnnotationSpatialIndexSourceParameters,
  DataEncoding,
  IndexedSegmentPropertySourceParameters,
  MeshSourceParameters,
  MultiscaleMeshSourceParameters,
  ShardingHashFunction,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/precomputed/base.js";
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
import { IndexedSegmentPropertySourceBackend } from "#src/segmentation_display_state/backend.js";
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
import { fetchSpecialHttpByteRange } from "#src/util/byte_range_http_requests.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import type { Borrowed } from "#src/util/disposable.js";
import { convertEndian32, Endianness } from "#src/util/endian.js";
import { vec3 } from "#src/util/geom.js";
import { murmurHash3_x86_128Hash64Bits } from "#src/util/hash.js";
import {
  isNotFoundError,
  responseArrayBuffer,
  responseJson,
} from "#src/util/http_request.js";
import { stableStringify } from "#src/util/json.js";
import { getObjectId } from "#src/util/object_id.js";
import type {
  SpecialProtocolCredentials,
  SpecialProtocolCredentialsProvider,
} from "#src/util/special_protocol_request.js";
import { cancellableFetchSpecialOk } from "#src/util/special_protocol_request.js";
import { Uint64 } from "#src/util/uint64.js";
import {
  encodeZIndexCompressed,
  encodeZIndexCompressed3d,
  zorder3LessThan,
} from "#src/util/zorder.js";
import { registerSharedObject } from "#src/worker_rpc.js";

// Set to true to validate the multiscale index.
const DEBUG_MULTISCALE_INDEX = false;

const shardingHashFunctions: Map<ShardingHashFunction, (out: Uint64) => void> =
  new Map([
    [
      ShardingHashFunction.MURMURHASH3_X86_128,
      (out) => {
        murmurHash3_x86_128Hash64Bits(out, 0, out.low, out.high);
      },
    ],
    [ShardingHashFunction.IDENTITY, (_out) => {}],
  ]);

interface ShardInfo {
  shardUrl: string;
  offset: Uint64;
}

interface DecodedMinishardIndex {
  data: Uint32Array;
  shardUrl: string;
}

interface MinishardIndexSource
  extends GenericSharedDataSource<Uint64, DecodedMinishardIndex | undefined> {
  sharding: ShardingParameters;
  credentialsProvider: SpecialProtocolCredentialsProvider;
}

function getMinishardIndexDataSource(
  chunkManager: Borrowed<ChunkManager>,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  parameters: { url: string; sharding: ShardingParameters | undefined },
): MinishardIndexSource | undefined {
  const { url, sharding } = parameters;
  if (sharding === undefined) return undefined;
  const source = GenericSharedDataSource.get<
    Uint64,
    DecodedMinishardIndex | undefined
  >(
    chunkManager,
    stableStringify({
      type: "precomputed:shardedDataSource",
      url,
      sharding,
      credentialsProvider: getObjectId(credentialsProvider),
    }),
    {
      download: async (
        shardAndMinishard: Uint64,
        cancellationToken: CancellationToken,
      ) => {
        const minishard = Uint64.lowMask(new Uint64(), sharding.minishardBits);
        Uint64.and(minishard, minishard, shardAndMinishard);
        const shard = Uint64.lowMask(new Uint64(), sharding.shardBits);
        const temp = new Uint64();
        Uint64.rshift(temp, shardAndMinishard, sharding.minishardBits);
        Uint64.and(shard, shard, temp);
        const shardUrl = `${url}/${shard
          .toString(16)
          .padStart(Math.ceil(sharding.shardBits / 4), "0")}.shard`;
        // Retrive minishard index start/end offsets.
        const shardIndexSize = new Uint64(16);
        Uint64.lshift(shardIndexSize, shardIndexSize, sharding.minishardBits);

        // Multiply minishard by 16.
        const shardIndexStart = Uint64.lshift(new Uint64(), minishard, 4);
        const shardIndexEnd = Uint64.addUint32(
          new Uint64(),
          shardIndexStart,
          16,
        );
        let shardIndexResponse: ArrayBuffer;
        try {
          shardIndexResponse = await fetchSpecialHttpByteRange(
            credentialsProvider,
            shardUrl,
            shardIndexStart,
            shardIndexEnd,
            cancellationToken,
          );
        } catch (e) {
          if (isNotFoundError(e)) return { data: undefined, size: 0 };
          throw e;
        }
        if (shardIndexResponse.byteLength !== 16) {
          throw new Error("Failed to retrieve minishard offset");
        }
        const shardIndexDv = new DataView(shardIndexResponse);
        const minishardStartOffset = new Uint64(
          shardIndexDv.getUint32(0, /*littleEndian=*/ true),
          shardIndexDv.getUint32(4, /*littleEndian=*/ true),
        );
        const minishardEndOffset = new Uint64(
          shardIndexDv.getUint32(8, /*littleEndian=*/ true),
          shardIndexDv.getUint32(12, /*littleEndian=*/ true),
        );
        if (Uint64.equal(minishardStartOffset, minishardEndOffset)) {
          return { data: undefined, size: 0 };
        }
        // The start/end offsets in the shard index are relative to the end of the shard
        // index.
        Uint64.add(minishardStartOffset, minishardStartOffset, shardIndexSize);
        Uint64.add(minishardEndOffset, minishardEndOffset, shardIndexSize);

        let minishardIndexResponse = await fetchSpecialHttpByteRange(
          credentialsProvider,
          shardUrl,
          minishardStartOffset,
          minishardEndOffset,
          cancellationToken,
        );
        if (sharding.minishardIndexEncoding === DataEncoding.GZIP) {
          minishardIndexResponse = (
            await requestAsyncComputation(
              decodeGzip,
              cancellationToken,
              [minishardIndexResponse],
              new Uint8Array(minishardIndexResponse),
            )
          ).buffer;
        }
        if (minishardIndexResponse.byteLength % 24 !== 0) {
          throw new Error(
            `Invalid minishard index length: ${minishardIndexResponse.byteLength}`,
          );
        }
        const minishardIndex = new Uint32Array(minishardIndexResponse);
        convertEndian32(minishardIndex, Endianness.LITTLE);

        const minishardIndexSize = minishardIndex.byteLength / 24;
        let prevEntryKeyLow = 0;
        let prevEntryKeyHigh = 0;
        // Offsets in the minishard index are relative to the end of the shard index.
        let prevStartLow = shardIndexSize.low;
        let prevStartHigh = shardIndexSize.high;
        for (let i = 0; i < minishardIndexSize; ++i) {
          let entryKeyLow = prevEntryKeyLow + minishardIndex[i * 2];
          let entryKeyHigh = prevEntryKeyHigh + minishardIndex[i * 2 + 1];
          if (entryKeyLow >= 4294967296) {
            entryKeyLow -= 4294967296;
            entryKeyHigh += 1;
          }
          prevEntryKeyLow = minishardIndex[i * 2] = entryKeyLow;
          prevEntryKeyHigh = minishardIndex[i * 2 + 1] = entryKeyHigh;
          let startLow =
            prevStartLow + minishardIndex[(minishardIndexSize + i) * 2];
          let startHigh =
            prevStartHigh + minishardIndex[(minishardIndexSize + i) * 2 + 1];
          if (startLow >= 4294967296) {
            startLow -= 4294967296;
            startHigh += 1;
          }
          minishardIndex[(minishardIndexSize + i) * 2] = startLow;
          minishardIndex[(minishardIndexSize + i) * 2 + 1] = startHigh;
          const sizeLow = minishardIndex[(2 * minishardIndexSize + i) * 2];
          const sizeHigh = minishardIndex[(2 * minishardIndexSize + i) * 2 + 1];
          let endLow = startLow + sizeLow;
          let endHigh = startHigh + sizeHigh;
          if (endLow >= 4294967296) {
            endLow -= 4294967296;
            endHigh += 1;
          }
          prevStartLow = endLow;
          prevStartHigh = endHigh;
          minishardIndex[(2 * minishardIndexSize + i) * 2] = endLow;
          minishardIndex[(2 * minishardIndexSize + i) * 2 + 1] = endHigh;
        }
        return {
          data: { data: minishardIndex, shardUrl },
          size: minishardIndex.byteLength,
        };
      },
      encodeKey: (key: Uint64) => key.toString(),
      sourceQueueLevel: 1,
    },
  ) as MinishardIndexSource;
  source.sharding = sharding;
  source.credentialsProvider = credentialsProvider;
  return source;
}

function findMinishardEntry(
  minishardIndex: DecodedMinishardIndex,
  key: Uint64,
): { startOffset: Uint64; endOffset: Uint64 } | undefined {
  const minishardIndexData = minishardIndex.data;
  const minishardIndexSize = minishardIndexData.length / 6;
  const keyLow = key.low;
  const keyHigh = key.high;
  for (let i = 0; i < minishardIndexSize; ++i) {
    if (
      minishardIndexData[i * 2] !== keyLow ||
      minishardIndexData[i * 2 + 1] !== keyHigh
    ) {
      continue;
    }
    const startOffset = new Uint64(
      minishardIndexData[(minishardIndexSize + i) * 2],
      minishardIndexData[(minishardIndexSize + i) * 2 + 1],
    );
    const endOffset = new Uint64(
      minishardIndexData[(2 * minishardIndexSize + i) * 2],
      minishardIndexData[(2 * minishardIndexSize + i) * 2 + 1],
    );
    return { startOffset, endOffset };
  }
  return undefined;
}

async function getShardedData(
  minishardIndexSource: MinishardIndexSource,
  chunk: Chunk,
  key: Uint64,
  cancellationToken: CancellationToken,
): Promise<{ shardInfo: ShardInfo; data: ArrayBuffer } | undefined> {
  const { sharding } = minishardIndexSource;
  const hashFunction = shardingHashFunctions.get(sharding.hash)!;
  const hashCode = Uint64.rshift(new Uint64(), key, sharding.preshiftBits);
  hashFunction(hashCode);
  const shardAndMinishard = Uint64.lowMask(
    new Uint64(),
    sharding.minishardBits + sharding.shardBits,
  );
  Uint64.and(shardAndMinishard, shardAndMinishard, hashCode);
  const getPriority = () => ({
    priorityTier: chunk.priorityTier,
    priority: chunk.priority,
  });
  const minishardIndex = await minishardIndexSource.getData(
    shardAndMinishard,
    getPriority,
    cancellationToken,
  );
  if (minishardIndex === undefined) return undefined;
  const minishardEntry = findMinishardEntry(minishardIndex, key);
  if (minishardEntry === undefined) return undefined;
  const { startOffset, endOffset } = minishardEntry;
  let data = await fetchSpecialHttpByteRange(
    minishardIndexSource.credentialsProvider,
    minishardIndex.shardUrl,
    startOffset,
    endOffset,
    cancellationToken,
  );
  if (minishardIndexSource.sharding.dataEncoding === DataEncoding.GZIP) {
    data = (
      await requestAsyncComputation(
        decodeGzip,
        cancellationToken,
        [data],
        new Uint8Array(data),
      )
    ).buffer;
  }
  return {
    data,
    shardInfo: { shardUrl: minishardIndex.shardUrl, offset: startOffset },
  };
}

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
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    VolumeChunkSource,
  ),
  VolumeChunkSourceParameters,
) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;
  private minishardIndexSource = getMinishardIndexDataSource(
    this.chunkManager,
    this.credentialsProvider,
    this.parameters,
  );

  gridShape = (() => {
    const gridShape = new Uint32Array(3);
    const { upperVoxelBound, chunkDataSize } = this.spec;
    for (let i = 0; i < 3; ++i) {
      gridShape[i] = Math.ceil(upperVoxelBound[i] / chunkDataSize[i]);
    }
    return gridShape;
  })();

  async download(
    chunk: VolumeChunk,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    const { parameters } = this;

    const { minishardIndexSource } = this;
    let response: ArrayBuffer | undefined;
    if (minishardIndexSource === undefined) {
      let url: string;
      {
        // chunkPosition must not be captured, since it will be invalidated by the next call to
        // computeChunkBounds.
        const chunkPosition = this.computeChunkBounds(chunk);
        const chunkDataSize = chunk.chunkDataSize!;
        url =
          `${parameters.url}/${chunkPosition[0]}-${
            chunkPosition[0] + chunkDataSize[0]
          }_` +
          `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
          `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
      }
      try {
        response = await cancellableFetchSpecialOk(
          this.credentialsProvider,
          url,
          {},
          responseArrayBuffer,
          cancellationToken,
        );
      } catch (e) {
        if (isNotFoundError(e)) {
          response = undefined;
        } else {
          throw e;
        }
      }
    } else {
      this.computeChunkBounds(chunk);
      const { gridShape } = this;
      const { chunkGridPosition } = chunk;
      const xBits = Math.ceil(Math.log2(gridShape[0]));
      const yBits = Math.ceil(Math.log2(gridShape[1]));
      const zBits = Math.ceil(Math.log2(gridShape[2]));
      const chunkIndex = encodeZIndexCompressed3d(
        new Uint64(),
        xBits,
        yBits,
        zBits,
        chunkGridPosition[0],
        chunkGridPosition[1],
        chunkGridPosition[2],
      );
      response = (
        await getShardedData(
          minishardIndexSource,
          chunk,
          chunkIndex,
          cancellationToken,
        )
      )?.data;
    }
    if (response !== undefined) {
      await this.chunkDecoder(chunk, cancellationToken, response);
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
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    MeshSource,
  ),
  MeshSourceParameters,
) {
  async download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    const { parameters } = this;
    const response = await cancellableFetchSpecialOk(
      this.credentialsProvider,
      `${parameters.url}/${chunk.objectId}:${parameters.lod}`,
      {},
      responseJson,
      cancellationToken,
    );
    decodeManifestChunk(chunk, response);
  }

  async downloadFragment(
    chunk: FragmentChunk,
    cancellationToken: CancellationToken,
  ) {
    const { parameters } = this;
    const response = await cancellableFetchSpecialOk(
      this.credentialsProvider,
      `${parameters.url}/${chunk.fragmentId}`,
      {},
      responseArrayBuffer,
      cancellationToken,
    );
    decodeFragmentChunk(chunk, response);
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
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    MultiscaleMeshSource,
  ),
  MultiscaleMeshSourceParameters,
) {
  private minishardIndexSource = getMinishardIndexDataSource(
    this.chunkManager,
    this.credentialsProvider,
    { url: this.parameters.url, sharding: this.parameters.metadata.sharding },
  );

  async download(
    chunk: PrecomputedMultiscaleManifestChunk,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    const { parameters, minishardIndexSource } = this;
    let data: ArrayBuffer;
    if (minishardIndexSource === undefined) {
      data = await cancellableFetchSpecialOk(
        this.credentialsProvider,
        `${parameters.url}/${chunk.objectId}.index`,
        {},
        responseArrayBuffer,
        cancellationToken,
      );
    } else {
      ({ data, shardInfo: chunk.shardInfo } = getOrNotFoundError(
        await getShardedData(
          minishardIndexSource,
          chunk,
          chunk.objectId,
          cancellationToken,
        ),
      ));
    }
    decodeMultiscaleManifestChunk(chunk, data);
  }

  async downloadFragment(
    chunk: MultiscaleFragmentChunk,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    const { parameters } = this;
    const manifestChunk =
      chunk.manifestChunk! as PrecomputedMultiscaleManifestChunk;
    const chunkIndex = chunk.chunkIndex;
    const { shardInfo, offsets } = manifestChunk;
    const startOffset = offsets[chunkIndex];
    const endOffset = offsets[chunkIndex + 1];
    let requestUrl: string;
    let adjustedStartOffset: Uint64 | number;
    let adjustedEndOffset: Uint64 | number;
    if (shardInfo !== undefined) {
      requestUrl = shardInfo.shardUrl;
      const fullDataSize = offsets[offsets.length - 1];
      let startLow = shardInfo.offset.low - fullDataSize + startOffset;
      let startHigh = shardInfo.offset.high;
      let endLow = startLow + endOffset - startOffset;
      let endHigh = startHigh;
      while (startLow < 0) {
        startLow += 4294967296;
        startHigh -= 1;
      }
      while (endLow < 0) {
        endLow += 4294967296;
        endHigh -= 1;
      }
      while (endLow > 4294967296) {
        endLow -= 4294967296;
        endHigh += 1;
      }
      adjustedStartOffset = new Uint64(startLow, startHigh);
      adjustedEndOffset = new Uint64(endLow, endHigh);
    } else {
      requestUrl = `${parameters.url}/${manifestChunk.objectId}`;
      adjustedStartOffset = startOffset;
      adjustedEndOffset = endOffset;
    }
    const response = await fetchSpecialHttpByteRange(
      this.credentialsProvider,
      requestUrl,
      adjustedStartOffset,
      adjustedEndOffset,
      cancellationToken,
    );
    await decodeMultiscaleFragmentChunk(chunk, response);
  }
}

async function fetchByUint64(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  chunk: Chunk,
  minishardIndexSource: MinishardIndexSource | undefined,
  id: Uint64,
  cancellationToken: CancellationToken,
) {
  if (minishardIndexSource === undefined) {
    try {
      return await cancellableFetchSpecialOk(
        credentialsProvider,
        `${url}/${id}`,
        {},
        responseArrayBuffer,
        cancellationToken,
      );
    } catch (e) {
      if (isNotFoundError(e)) return undefined;
      throw e;
    }
  }
  const result = await getShardedData(
    minishardIndexSource,
    chunk,
    id,
    cancellationToken,
  );
  if (result === undefined) return undefined;
  return result.data;
}

@registerSharedObject() //
export class PrecomputedSkeletonSource extends WithParameters(
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    SkeletonSource,
  ),
  SkeletonSourceParameters,
) {
  private minishardIndexSource = getMinishardIndexDataSource(
    this.chunkManager,
    this.credentialsProvider,
    { url: this.parameters.url, sharding: this.parameters.metadata.sharding },
  );
  async download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const { parameters } = this;
    const response = getOrNotFoundError(
      await fetchByUint64(
        this.credentialsProvider,
        parameters.url,
        chunk,
        this.minishardIndexSource,
        chunk.objectId,
        cancellationToken,
      ),
    );
    decodeSkeletonChunk(chunk, response, parameters.metadata.vertexAttributes);
  }
}

function parseAnnotations(
  buffer: ArrayBuffer,
  parameters: AnnotationSourceParameters,
  propertySerializer: AnnotationPropertySerializer,
): AnnotationGeometryData {
  const dv = new DataView(buffer);
  if (buffer.byteLength <= 8) throw new Error("Expected at least 8 bytes");
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
  const id = new Uint64();
  const ids = new Array<string>(countLow);
  for (let i = 0; i < countLow; ++i) {
    id.low = dv.getUint32(idOffset + i * 8, /*littleEndian=*/ true);
    id.high = dv.getUint32(idOffset + i * 8 + 4, /*littleEndian=*/ true);
    ids[i] = id.toString();
  }
  const geometryData = new AnnotationGeometryData();
  const origData = new Uint8Array(buffer, 8, numBytes * countLow);
  let data: Uint8Array;
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
  const relatedSegments: Uint64[][] = (annotation.relatedSegments = []);
  relatedSegments.length = numRelationships;
  for (let i = 0; i < numRelationships; ++i) {
    const count = dv.getUint32(offset, /*littleEndian=*/ true);
    if (buffer.byteLength < minNumBytes + count * 8) {
      throw new Error(
        `Expected at least ${minNumBytes} bytes, but received: ${buffer.byteLength}`,
      );
    }
    offset += 4;
    const segments: Uint64[] = (relatedSegments[i] = []);
    for (let j = 0; j < count; ++j) {
      segments[j] = new Uint64(
        dv.getUint32(offset, /*littleEndian=*/ true),
        dv.getUint32(offset + 4, /*littleEndian=*/ true),
      );
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
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    AnnotationGeometryChunkSourceBackend,
  ),
  AnnotationSpatialIndexSourceParameters,
) {
  private minishardIndexSource = getMinishardIndexDataSource(
    this.chunkManager,
    this.credentialsProvider,
    this.parameters,
  );
  parent: PrecomputedAnnotationSourceBackend;
  async download(
    chunk: AnnotationGeometryChunk,
    cancellationToken: CancellationToken,
  ) {
    const { parameters } = this;

    const { minishardIndexSource } = this;
    const { parent } = this;
    let response: ArrayBuffer | undefined;
    const { chunkGridPosition } = chunk;
    if (minishardIndexSource === undefined) {
      const url = `${parameters.url}/${chunkGridPosition.join("_")}`;
      try {
        response = await cancellableFetchSpecialOk(
          this.credentialsProvider,
          url,
          {},
          responseArrayBuffer,
          cancellationToken,
        );
      } catch (e) {
        if (!isNotFoundError(e)) throw e;
      }
    } else {
      const { upperChunkBound } = this.spec;
      const { chunkGridPosition } = chunk;
      const chunkIndex = encodeZIndexCompressed(
        new Uint64(),
        chunkGridPosition,
        upperChunkBound,
      );
      const result = await getShardedData(
        minishardIndexSource,
        chunk,
        chunkIndex,
        cancellationToken,
      );
      if (result !== undefined) response = result.data;
    }
    if (response !== undefined) {
      chunk.data = parseAnnotations(
        response,
        parent.parameters,
        parent.annotationPropertySerializer,
      );
    }
  }
}

@registerSharedObject() //
export class PrecomputedAnnotationSourceBackend extends WithParameters(
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    AnnotationSource,
  ),
  AnnotationSourceParameters,
) {
  private byIdMinishardIndexSource = getMinishardIndexDataSource(
    this.chunkManager,
    this.credentialsProvider,
    this.parameters.byId,
  );
  private relationshipIndexSource = this.parameters.relationships.map((x) =>
    getMinishardIndexDataSource(this.chunkManager, this.credentialsProvider, x),
  );
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
    cancellationToken: CancellationToken,
  ) {
    const { parameters } = this;
    const response = await fetchByUint64(
      this.credentialsProvider,
      parameters.relationships[relationshipIndex].url,
      chunk,
      this.relationshipIndexSource[relationshipIndex],
      chunk.objectId,
      cancellationToken,
    );
    if (response !== undefined) {
      chunk.data = parseAnnotations(
        response,
        this.parameters,
        this.annotationPropertySerializer,
      );
    }
  }

  async downloadMetadata(
    chunk: AnnotationMetadataChunk,
    cancellationToken: CancellationToken,
  ) {
    const { parameters } = this;
    const id = Uint64.parseString(chunk.key!);
    const response = await fetchByUint64(
      this.credentialsProvider,
      parameters.byId.url,
      chunk,
      this.byIdMinishardIndexSource,
      id,
      cancellationToken,
    );
    if (response === undefined) {
      chunk.annotation = null;
    } else {
      chunk.annotation = parseSingleAnnotation(
        response,
        this.parameters,
        this.annotationPropertySerializer,
        chunk.key!,
      );
    }
  }
}

@registerSharedObject()
export class PrecomputedIndexedSegmentPropertySourceBackend extends WithParameters(
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    IndexedSegmentPropertySourceBackend,
  ),
  IndexedSegmentPropertySourceParameters,
) {
  minishardIndexSource = getMinishardIndexDataSource(
    this.chunkManager,
    this.credentialsProvider,
    this.parameters,
  );
}
