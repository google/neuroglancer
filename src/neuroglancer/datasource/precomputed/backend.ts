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

import {decodeGzip} from 'neuroglancer/async_computation/decode_gzip_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {Chunk, ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/backend';
import {GenericSharedDataSource} from 'neuroglancer/chunk_manager/generic_file_source';
import {DataEncoding, MeshSourceParameters, MultiscaleMeshSourceParameters, ShardingHashFunction, ShardingParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/precomputed/base';
import {assignMeshFragmentData, assignMultiscaleMeshFragmentData, computeOctreeChildOffsets, decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, FragmentChunk, generateHigherOctreeLevel, ManifestChunk, MeshSource, MultiscaleFragmentChunk, MultiscaleManifestChunk, MultiscaleMeshSource} from 'neuroglancer/mesh/backend';
import {SkeletonChunk, SkeletonSource} from 'neuroglancer/skeleton/backend';
import {decodeSkeletonChunk} from 'neuroglancer/skeleton/decode_precomputed_skeleton';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {fetchHttpByteRange} from 'neuroglancer/util/byte_range_http_requests';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Borrowed} from 'neuroglancer/util/disposable';
import {convertEndian32, Endianness} from 'neuroglancer/util/endian';
import {vec3} from 'neuroglancer/util/geom';
import {murmurHash3_x86_128Hash64Bits} from 'neuroglancer/util/hash';
import {cancellableFetchOk, responseArrayBuffer, responseJson} from 'neuroglancer/util/http_request';
import {stableStringify} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {encodeZIndexCompressed} from 'neuroglancer/util/zorder';
import {registerSharedObject} from 'neuroglancer/worker_rpc';

const shardingHashFunctions: Map<ShardingHashFunction, (out: Uint64) => void> = new Map([
  [
    ShardingHashFunction.MURMURHASH3_X86_128,
    (out) => {
      murmurHash3_x86_128Hash64Bits(out, 0, out.low, out.high);
    }
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

interface MinishardIndexSource extends GenericSharedDataSource<Uint64, DecodedMinishardIndex> {
  sharding: ShardingParameters;
}

function getMinishardIndexDataSource(
    chunkManager: Borrowed<ChunkManager>,
    parameters: {url: string, sharding: ShardingParameters|undefined}): MinishardIndexSource|
    undefined {
  const {url, sharding} = parameters;
  if (sharding === undefined) return undefined;
  const source =
      GenericSharedDataSource.get<Uint64, DecodedMinishardIndex>(
          chunkManager, stableStringify({type: 'precomputed:shardedDataSource', url, sharding}), {
            download: async function(
                shardAndMinishard: Uint64, cancellationToken: CancellationToken) {
              const minishard = Uint64.lowMask(new Uint64(), sharding.minishardBits);
              Uint64.and(minishard, minishard, shardAndMinishard);
              const shard = Uint64.lowMask(new Uint64(), sharding.shardBits);
              const temp = new Uint64();
              Uint64.rshift(temp, shardAndMinishard, sharding.minishardBits);
              Uint64.and(shard, shard, temp);
              const shardUrl =
                  `${url}/${shard.toString(16).padStart(Math.ceil(sharding.shardBits / 4), '0')}.shard`;
              // Retrive minishard index start/end offsets.

              const shardIndexSize = new Uint64(16);
              Uint64.lshift(shardIndexSize, shardIndexSize, sharding.minishardBits);

              // Multiply minishard by 16.
              const shardIndexStart = Uint64.lshift(new Uint64(), minishard, 4);
              const shardIndexEnd = Uint64.addUint32(new Uint64(), shardIndexStart, 16);
              const shardIndexResponse = await fetchHttpByteRange(
                  shardUrl, shardIndexStart, shardIndexEnd, cancellationToken);
              if (shardIndexResponse.byteLength !== 16) {
                throw new Error(`Failed to retrieve minishard offset`);
              }
              const shardIndexDv = new DataView(shardIndexResponse);
              const minishardStartOffset = new Uint64(
                  shardIndexDv.getUint32(0, /*littleEndian=*/ true),
                  shardIndexDv.getUint32(4, /*littleEndian=*/ true));
              const minishardEndOffset = new Uint64(
                  shardIndexDv.getUint32(8, /*littleEndian=*/ true),
                  shardIndexDv.getUint32(12, /*littleEndian=*/ true));
              if (Uint64.equal(minishardStartOffset, minishardEndOffset)) {
                throw new Error('Object not found')
              }
              // The start/end offsets in the shard index are relative to the end of the shard
              // index.
              Uint64.add(minishardStartOffset, minishardStartOffset, shardIndexSize);
              Uint64.add(minishardEndOffset, minishardEndOffset, shardIndexSize);

              let minishardIndexResponse = await fetchHttpByteRange(
                  shardUrl, minishardStartOffset, minishardEndOffset, cancellationToken);
              if (sharding.minishardIndexEncoding === DataEncoding.GZIP) {
                minishardIndexResponse =
                    (await requestAsyncComputation(
                         decodeGzip, cancellationToken, [minishardIndexResponse],
                         new Uint8Array(minishardIndexResponse)))
                        .buffer;
              }
              if ((minishardIndexResponse.byteLength % 24) !== 0) {
                throw new Error(
                    `Invalid minishard index length: ${minishardIndexResponse.byteLength}`);
              }
              const minishardIndex = new Uint32Array(minishardIndexResponse);
              convertEndian32(minishardIndex, Endianness.LITTLE);

              const minishardIndexSize = minishardIndex.byteLength / 24;
              let prevEntryKeyLow = 0, prevEntryKeyHigh = 0;
              // Offsets in the minishard index are relative to the end of the shard index.
              let prevStartLow = shardIndexSize.low, prevStartHigh = shardIndexSize.high;
              for (let i = 0; i < minishardIndexSize; ++i) {
                let entryKeyLow = prevEntryKeyLow + minishardIndex[i * 2];
                let entryKeyHigh = prevEntryKeyHigh + minishardIndex[i * 2 + 1];
                if (entryKeyLow >= 4294967296) {
                  entryKeyLow -= 4294967296;
                  entryKeyHigh += 1;
                }
                prevEntryKeyLow = minishardIndex[i * 2] = entryKeyLow;
                prevEntryKeyHigh = minishardIndex[i * 2 + 1] = entryKeyHigh;
                let startLow = prevStartLow + minishardIndex[(minishardIndexSize + i) * 2];
                let startHigh = prevStartHigh + minishardIndex[(minishardIndexSize + i) * 2 + 1];
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
              return {data: {data: minishardIndex, shardUrl}, size: minishardIndex.byteLength};
            },
            encodeKey: (key: Uint64) => key.toString(),
            sourceQueueLevel: 1,
          }) as MinishardIndexSource;
  source.sharding = sharding;
  return source;
}

function findMinishardEntry(minishardIndex: DecodedMinishardIndex, key: Uint64) {
  const minishardIndexData = minishardIndex.data;
  const minishardIndexSize = minishardIndexData.length / 6;
  const keyLow = key.low, keyHigh = key.high;
  for (let i = 0; i < minishardIndexSize; ++i) {
    if (minishardIndexData[i * 2] !== keyLow || minishardIndexData[i * 2 + 1] !== keyHigh) {
      continue;
    }
    const startOffset = new Uint64(
        minishardIndexData[(minishardIndexSize + i) * 2],
        minishardIndexData[(minishardIndexSize + i) * 2 + 1]);
    const endOffset = new Uint64(
        minishardIndexData[(2 * minishardIndexSize + i) * 2],
        minishardIndexData[(2 * minishardIndexSize + i) * 2 + 1]);
    return {startOffset, endOffset};
  }
  throw new Error(`Object not found in minishard: ${key}`);
}

async function getShardedData(
    minishardIndexSource: MinishardIndexSource, chunk: Chunk, key: Uint64,
    cancellationToken: CancellationToken): Promise<{shardInfo: ShardInfo, data: ArrayBuffer}> {
  const {sharding} = minishardIndexSource;
  const hashFunction = shardingHashFunctions.get(sharding.hash)!;
  const hashCode = Uint64.rshift(new Uint64(), key, sharding.preshiftBits);
  hashFunction(hashCode);
  const shardAndMinishard =
      Uint64.lowMask(new Uint64(), sharding.minishardBits + sharding.shardBits);
  Uint64.and(shardAndMinishard, shardAndMinishard, hashCode);
  const getPriority = () => ({priorityTier: chunk.priorityTier, priority: chunk.priority});
  const minishardIndex =
      await minishardIndexSource.getData(shardAndMinishard, getPriority, cancellationToken);
  const {startOffset, endOffset} = findMinishardEntry(minishardIndex, key);
  let data =
      await fetchHttpByteRange(minishardIndex.shardUrl, startOffset, endOffset, cancellationToken);
  if (minishardIndexSource.sharding.dataEncoding === DataEncoding.GZIP) {
    data =
        (await requestAsyncComputation(decodeGzip, cancellationToken, [data], new Uint8Array(data)))
            .buffer;
  }
  return {data, shardInfo: {shardUrl: minishardIndex.shardUrl, offset: startOffset}};
}


const chunkDecoders = new Map<VolumeChunkEncoding, ChunkDecoder>();
chunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);
chunkDecoders.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
chunkDecoders.set(VolumeChunkEncoding.COMPRESSED_SEGMENTATION, decodeCompressedSegmentationChunk);

@registerSharedObject() export class PrecomputedVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;
  private minishardIndexSource = getMinishardIndexDataSource(this.chunkManager, this.parameters);

  gridShape = (() => {
    const gridShape = new Uint32Array(3);
    const {upperVoxelBound, chunkDataSize} = this.spec;
    for (let i = 0; i < 3; ++i) {
      gridShape[i] = Math.ceil(upperVoxelBound[i] / chunkDataSize[i]);
    }
    return gridShape;
  })();

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken): Promise<void> {
    const {parameters} = this;

    const {minishardIndexSource} = this;
    let response: ArrayBuffer;
    if (minishardIndexSource === undefined) {
      let url: string;
      {
        // chunkPosition must not be captured, since it will be invalidated by the next call to
        // computeChunkBounds.
        let chunkPosition = this.computeChunkBounds(chunk);
        let chunkDataSize = chunk.chunkDataSize!;
        url = `${parameters.url}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
            `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
            `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
      }
      response = await cancellableFetchOk(url, {}, responseArrayBuffer, cancellationToken);
    } else {
      this.computeChunkBounds(chunk);
      const {gridShape} = this;
      const {chunkGridPosition} = chunk;
      const xBits = Math.ceil(Math.log2(gridShape[0])), yBits = Math.ceil(Math.log2(gridShape[1])),
            zBits = Math.ceil(Math.log2(gridShape[2]));
      const chunkIndex = encodeZIndexCompressed(
          new Uint64(), xBits, yBits, zBits, chunkGridPosition[0], chunkGridPosition[1],
          chunkGridPosition[2]);
      response =
          (await getShardedData(minishardIndexSource, chunk, chunkIndex, cancellationToken)).data;
    }
    await this.chunkDecoder(chunk, cancellationToken, response);
  }
}

export function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragments');
}

export function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
      chunk,
      decodeTriangleVertexPositionsAndIndices(
          response, Endianness.LITTLE, /*vertexByteOffset=*/ 4, numVertices));
}

@registerSharedObject() export class PrecomputedMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {
  download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    return cancellableFetchOk(
               `${parameters.url}/${chunk.objectId}:${parameters.lod}`, {}, responseJson,
               cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    return cancellableFetchOk(
               `${parameters.url}/${chunk.fragmentId}`, {}, responseArrayBuffer, cancellationToken)
        .then(response => decodeFragmentChunk(chunk, response));
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
    chunk: PrecomputedMultiscaleManifestChunk, response: ArrayBuffer) {
  if (response.byteLength < 28 || response.byteLength % 4 !== 0) {
    throw new Error(`Invalid index file size: ${response.byteLength}`);
  }
  const dv = new DataView(response);
  let offset = 0;
  const chunkShape = vec3.fromValues(
      dv.getFloat32(offset, /*littleEndian=*/ true),
      dv.getFloat32(offset + 4, /*littleEndian=*/ true),
      dv.getFloat32(offset + 8, /*littleEndian=*/ true));
  offset += 12;
  const gridOrigin = vec3.fromValues(
      dv.getFloat32(offset, /*littleEndian=*/ true),
      dv.getFloat32(offset + 4, /*littleEndian=*/ true),
      dv.getFloat32(offset + 8, /*littleEndian=*/ true));
  offset += 12;
  const numStoredLods = dv.getUint32(offset, /*littleEndian=*/ true);
  offset += 4
  if (response.byteLength < offset + (4 + 4 + 4 * 3) * numStoredLods) {
    throw new Error(`Invalid index file size for ${numStoredLods} lods: ${response.byteLength}`);
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
        `${totalFragments} total fragments: ${response.byteLength}`);
  }
  const fragmentInfo = new Uint32Array(response, offset);
  convertEndian32(fragmentInfo, Endianness.LITTLE);
  const clipUpperBound =
      vec3.fromValues(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const clipLowerBound =
      vec3.fromValues(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  let numLods = Math.max(1, storedLodScales.length);
  {
    let fragmentBase = 0;
    for (let lodIndex = 0; lodIndex < numStoredLods; ++lodIndex) {
      const numFragments = numFragmentsPerLod[lodIndex];
      for (let i = 0; i < 3; ++i) {
        let upperBoundValue = Number.NEGATIVE_INFINITY;
        let lowerBoundValue = Number.POSITIVE_INFINITY;
        const base = fragmentBase + numFragments * i;
        for (let j = 0; j < numFragments; ++j) {
          const v = fragmentInfo[base + j];
          upperBoundValue = Math.max(upperBoundValue, v);
          lowerBoundValue = Math.min(lowerBoundValue, v);
        }
        if (numFragments != 0) {
          while ((upperBoundValue >>> (numLods - lodIndex - 1)) !=
                 (lowerBoundValue >>> (numLods - lodIndex - 1))) {
            ++numLods;
          }
          if (lodIndex === 0) {
            clipLowerBound[i] = Math.min(clipLowerBound[i], (1 << lodIndex) * lowerBoundValue);
            clipUpperBound[i] =
                Math.max(clipUpperBound[i], (1 << lodIndex) * (upperBoundValue + 1));
          }
        }
      }
      fragmentBase += numFragments * 4;
    }
  }

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
          octreeTemp[5 * (baseRow + j) + i] = fragmentInfo[fragmentBase + j + i * numFragments];
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
        computeOctreeChildOffsets(octreeTemp, priorStart, baseRow, baseRow + numFragments);
      }

      priorStart = baseRow;
      baseRow += numFragments;
      while (lodIndex + 1 < numLods &&
             (lodIndex + 1 >= storedLodScales.length || storedLodScales[lodIndex + 1] === 0)) {
        const curEnd = generateHigherOctreeLevel(octreeTemp, priorStart, baseRow);
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
  const {lodScaleMultiplier} = source.parameters.metadata;
  const lodScales = new Float32Array(numLods);
  lodScales.set(storedLodScales, 0);
  for (let i = 0; i < storedLodScales.length; ++i) {
    lodScales[i] *= lodScaleMultiplier;
  }
  chunk.manifest = {
    chunkShape,
    chunkGridSpatialOrigin: gridOrigin,
    clipLowerBound: vec3.add(
        clipLowerBound, gridOrigin, vec3.multiply(clipLowerBound, clipLowerBound, chunkShape)),
    clipUpperBound: vec3.add(
        clipUpperBound, gridOrigin, vec3.multiply(clipUpperBound, clipUpperBound, chunkShape)),
    octree,
    lodScales,
    vertexOffsets,
  };
}

async function decodeMultiscaleFragmentChunk(
    chunk: MultiscaleFragmentChunk, response: ArrayBuffer) {
  const {lod} = chunk;
  const source = chunk.manifestChunk!.source! as PrecomputedMultiscaleMeshSource;
  const m = await import(/* webpackChunkName: "draco" */ 'neuroglancer/mesh/draco');
  const rawMesh = await m.decodeDracoPartitioned(
      new Uint8Array(response), source.parameters.metadata.vertexQuantizationBits, lod !== 0);
  assignMultiscaleMeshFragmentData(chunk, rawMesh, source.format.vertexPositionFormat);
}

@registerSharedObject() //
export class PrecomputedMultiscaleMeshSource extends
(WithParameters(MultiscaleMeshSource, MultiscaleMeshSourceParameters)) {
  private minishardIndexSource = getMinishardIndexDataSource(
      this.chunkManager, {url: this.parameters.url, sharding: this.parameters.metadata.sharding});

  async download(chunk: PrecomputedMultiscaleManifestChunk, cancellationToken: CancellationToken):
      Promise<void> {
    const {parameters, minishardIndexSource} = this;
    let data: ArrayBuffer;
    if (minishardIndexSource === undefined) {
      data = await cancellableFetchOk(
          `${parameters.url}/${chunk.objectId}.index`, {}, responseArrayBuffer, cancellationToken);
    } else {
      ({data, shardInfo: chunk.shardInfo} =
           await getShardedData(minishardIndexSource, chunk, chunk.objectId, cancellationToken));
    }
    await decodeMultiscaleManifestChunk(chunk, data);
  }

  async downloadFragment(
      chunk: MultiscaleFragmentChunk, cancellationToken: CancellationToken): Promise<void> {
    const {parameters} = this;
    const manifestChunk = chunk.manifestChunk! as PrecomputedMultiscaleManifestChunk;
    const chunkIndex = chunk.chunkIndex;
    const {shardInfo, offsets} = manifestChunk;
    const startOffset = offsets[chunkIndex];
    const endOffset = offsets[chunkIndex + 1];
    let requestUrl: string;
    let adjustedStartOffset: Uint64|number, adjustedEndOffset: Uint64|number;
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
    const response = await fetchHttpByteRange(
        requestUrl, adjustedStartOffset, adjustedEndOffset, cancellationToken);
    await decodeMultiscaleFragmentChunk(chunk, response);
  }
}

@registerSharedObject() //
export class PrecomputedSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {
  private minishardIndexSource = getMinishardIndexDataSource(
      this.chunkManager, {url: this.parameters.url, sharding: this.parameters.metadata.sharding});
  async download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
    const {minishardIndexSource, parameters} = this;
    let response: ArrayBuffer;
    if (minishardIndexSource === undefined) {
      response = await cancellableFetchOk(
          `${parameters.url}/${chunk.objectId}`, {}, responseArrayBuffer, cancellationToken);
    } else {
      response =
          (await getShardedData(minishardIndexSource, chunk, chunk.objectId, cancellationToken))
              .data;
    }
    decodeSkeletonChunk(chunk, response, parameters.metadata.vertexAttributes);
  }
}
