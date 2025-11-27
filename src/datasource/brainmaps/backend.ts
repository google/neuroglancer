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
  AnnotationGeometryChunkSourceBackend,
  AnnotationGeometryData,
  AnnotationSource,
} from "#src/annotation/backend.js";
import type { Annotation, AnnotationId } from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationType,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import type { ChunkSourceParametersConstructor } from "#src/chunk_manager/base.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import type {
  BatchMeshFragment,
  BatchMeshFragmentPayload,
  BrainmapsInstance,
  ChangeStackAwarePayload,
  OAuth2Credentials,
  SkeletonPayload,
  SubvolumePayload,
} from "#src/datasource/brainmaps/api.js";
import { makeRequest } from "#src/datasource/brainmaps/api.js";
import type { ChangeSpec } from "#src/datasource/brainmaps/base.js";
import {
  AnnotationSourceParameters,
  AnnotationSpatialIndexSourceParameters,
  MeshSourceParameters,
  MultiscaleMeshSourceParameters,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeSourceParameters,
} from "#src/datasource/brainmaps/base.js";
import type {
  FragmentChunk,
  ManifestChunk,
  MultiscaleFragmentChunk,
  MultiscaleManifestChunk,
} from "#src/mesh/backend.js";
import {
  assignMeshFragmentData,
  assignMultiscaleMeshFragmentData,
  generateHigherOctreeLevel,
  MeshSource,
  MultiscaleMeshSource,
} from "#src/mesh/backend.js";
import { VertexPositionFormat } from "#src/mesh/base.js";
import type { MultiscaleMeshManifest } from "#src/mesh/multiscale.js";
import type { SkeletonChunk } from "#src/skeleton/backend.js";
import {
  decodeSkeletonVertexPositionsAndIndices,
  SkeletonSource,
} from "#src/skeleton/backend.js";
import { decodeCompressedSegmentationChunk } from "#src/sliceview/backend_chunk_decoders/compressed_segmentation.js";
import { decodeJpegChunk } from "#src/sliceview/backend_chunk_decoders/jpeg.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { convertEndian32, Endianness } from "#src/util/endian.js";
import { kInfinityVec, kZeroVec, vec3, vec3Key } from "#src/util/geom.js";
import {
  parseArray,
  parseFixedLengthArray,
  parseUint64,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalString,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import { defaultStringCompare } from "#src/util/string.js";
import * as vector from "#src/util/vector.js";
import {
  decodeZIndexCompressed,
  encodeZIndexCompressed3d,
  getOctreeChildIndex,
  zorder3LessThan,
} from "#src/util/zorder.js";
import type { SharedObject } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

const CHUNK_DECODERS = new Map([
  [VolumeChunkEncoding.RAW, decodeRawChunk],
  [VolumeChunkEncoding.JPEG, decodeJpegChunk],
  [
    VolumeChunkEncoding.COMPRESSED_SEGMENTATION,
    decodeCompressedSegmentationChunk,
  ],
]);

function applyChangeStack(
  changeStack: ChangeSpec | undefined,
  payload: ChangeStackAwarePayload,
) {
  if (!changeStack) {
    return;
  }
  payload.change_spec = {
    change_stack_id: changeStack.changeStackId,
  };
  if (changeStack.timeStamp) {
    payload.change_spec.time_stamp = changeStack.timeStamp;
  }
  if (changeStack.skipEquivalences) {
    payload.change_spec.skip_equivalences = changeStack.skipEquivalences;
  }
}

function BrainmapsSource<
  Parameters,
  TBase extends { new (...args: any[]): SharedObject },
>(
  Base: TBase,
  parametersConstructor: ChunkSourceParametersConstructor<Parameters>,
) {
  return WithParameters(
    WithSharedCredentialsProviderCounterpart<OAuth2Credentials>()(Base),
    parametersConstructor,
  );
}

@registerSharedObject()
export class BrainmapsVolumeChunkSource extends BrainmapsSource(
  VolumeChunkSource,
  VolumeSourceParameters,
) {
  chunkDecoder = CHUNK_DECODERS.get(this.parameters.encoding)!;

  private applyEncodingParams(payload: SubvolumePayload) {
    const { encoding } = this.parameters;
    switch (encoding) {
      case VolumeChunkEncoding.RAW:
        payload.subvolume_format = "RAW";
        break;
      case VolumeChunkEncoding.JPEG:
        payload.subvolume_format = "SINGLE_IMAGE";
        payload.image_format_options = {
          image_format: "JPEG",
          jpeg_quality: this.parameters.jpegQuality!,
        };
        return;
      case VolumeChunkEncoding.COMPRESSED_SEGMENTATION:
        payload.subvolume_format = "RAW";
        payload.image_format_options = {
          compressed_segmentation_block_size: vec3Key(
            this.spec.compressedSegmentationBlockSize!,
          ),
        };
        break;
      default:
        throw new Error(`Invalid encoding: ${encoding}`);
    }
  }

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    const { parameters } = this;

    // chunkPosition must not be captured, since it will be invalidated by the next call to
    // computeChunkBounds.
    const chunkPosition = this.computeChunkBounds(chunk);
    const chunkDataSize = chunk.chunkDataSize!;
    const path = `/v1/volumes/${parameters.volumeId}/subvolume:binary`;

    const payload: SubvolumePayload = {
      geometry: {
        corner: vec3Key(chunkPosition),
        size: vec3Key(chunkDataSize),
        scale: parameters.scaleIndex,
      },
    };

    this.applyEncodingParams(payload);
    applyChangeStack(parameters.changeSpec, payload);

    const response = await makeRequest(
      parameters.instance,
      this.credentialsProvider,
      path,
      {
        method: "POST",
        body: JSON.stringify(payload),
        signal: signal,
      },
    );
    await this.chunkDecoder(chunk, signal, await response.arrayBuffer());
  }
}

function getFragmentCorner(
  fragmentId: string,
  xBits: number,
  yBits: number,
  zBits: number,
): Uint32Array {
  const value = parseUint64(BigInt("0x" + fragmentId));
  return decodeZIndexCompressed(value, xBits, yBits, zBits);
}

interface BrainmapsMultiscaleManifestChunk extends MultiscaleManifestChunk {
  fragmentSupervoxelIds: { fragmentId: string; supervoxelIds: string[] }[];
}

function decodeMultiscaleManifestChunk(
  chunk: BrainmapsMultiscaleManifestChunk,
  response: any,
) {
  verifyObject(response);
  const source = chunk.source as BrainmapsMultiscaleMeshSource;
  const fragmentKeys = verifyObjectProperty(
    response,
    "fragmentKey",
    verifyStringArray,
  );
  const supervoxelIds = verifyObjectProperty(
    response,
    "supervoxelId",
    verifyStringArray,
  );
  const length = fragmentKeys.length;
  if (length !== supervoxelIds.length) {
    throw new Error(
      "Expected fragmentKey and supervoxelId arrays to have the same length.",
    );
  }
  const fragmentSupervoxelIds = new Map<string, string[]>();
  fragmentKeys.forEach((fragmentId, i) => {
    let ids = fragmentSupervoxelIds.get(fragmentId);
    if (ids === undefined) {
      ids = [];
      fragmentSupervoxelIds.set(fragmentId, ids);
    }
    ids.push(supervoxelIds[i]);
  });
  const { chunkShape } = source.parameters.info;
  const gridShape = source.parameters.info.lods[0].gridShape;
  const xBits = Math.ceil(Math.log2(gridShape[0]));
  const yBits = Math.ceil(Math.log2(gridShape[1]));
  const zBits = Math.ceil(Math.log2(gridShape[2]));
  const fragmentIdAndCorners = Array.from(fragmentSupervoxelIds.entries()).map(
    ([id, supervoxelIds]) => ({
      fragmentId: id,
      corner: getFragmentCorner(id, xBits, yBits, zBits),
      supervoxelIds,
    }),
  );
  fragmentIdAndCorners.sort((a, b) => {
    return zorder3LessThan(
      a.corner[0],
      a.corner[1],
      a.corner[2],
      b.corner[0],
      b.corner[1],
      b.corner[2],
    )
      ? -1
      : 1;
  });
  let clipLowerBound: vec3;
  let clipUpperBound: vec3;
  let minNumLods = 0;
  let octree: Uint32Array;
  if (length === 0) {
    clipLowerBound = clipUpperBound = kZeroVec;
    octree = Uint32Array.of(0, 0, 0, 0, 0x80000000);
  } else {
    const minCoord = vec3.clone(kInfinityVec);
    const maxCoord = vec3.clone(kZeroVec);
    fragmentIdAndCorners.forEach((x) => {
      const { corner } = x;
      for (let i = 0; i < 3; ++i) {
        minCoord[i] = Math.min(minCoord[i], corner[i]);
        maxCoord[i] = Math.max(maxCoord[i], corner[i]);
      }
    });
    minNumLods = 1;
    while (
      maxCoord[0] >>> (minNumLods - 1) !== minCoord[0] >>> (minNumLods - 1) ||
      maxCoord[1] >>> (minNumLods - 1) !== minCoord[1] >>> (minNumLods - 1) ||
      maxCoord[2] >>> (minNumLods - 1) !== minCoord[2] >>> (minNumLods - 1)
    ) {
      ++minNumLods;
    }
    clipLowerBound = vec3.multiply(minCoord, minCoord, chunkShape);
    clipUpperBound = vec3.add(
      maxCoord,
      vec3.multiply(maxCoord, maxCoord, chunkShape),
      chunkShape,
    );
  }
  const { lods } = source.parameters.info;
  const lodScales = new Float32Array(Math.max(lods.length, minNumLods));
  for (let lodIndex = 0; lodIndex < lods.length; ++lodIndex) {
    lodScales[lodIndex] = lods[lodIndex].scale;
  }

  if (length !== 0) {
    const octreeTemp = new Uint32Array(
      fragmentIdAndCorners.length * lodScales.length * 5,
    );
    fragmentIdAndCorners.forEach((x, i) => {
      octreeTemp.set(x.corner, i * 5);
      octreeTemp[i * 5] = x.corner[0];
    });
    let priorStart = 0;
    let priorEnd = fragmentIdAndCorners.length;
    for (let lod = 1; lod < lodScales.length; ++lod) {
      const curEnd = generateHigherOctreeLevel(
        octreeTemp,
        priorStart,
        priorEnd,
      );
      priorStart = priorEnd;
      priorEnd = curEnd;
    }
    octree = octreeTemp.slice(0, priorEnd * 5);
  }

  const manifest: MultiscaleMeshManifest = {
    chunkShape,
    chunkGridSpatialOrigin: kZeroVec,
    clipLowerBound,
    clipUpperBound,
    octree: octree!,
    lodScales: lodScales,
    vertexOffsets: new Float32Array(lodScales.length * 3),
  };
  chunk.manifest = manifest;
  chunk.fragmentSupervoxelIds = fragmentIdAndCorners;
}

const maxMeshBatchSize = 255;

interface BatchMeshResponseFragment {
  fullKey: string;
  buffer: ArrayBuffer;
  verticesOffset: number;
  indicesOffset: number;
  numVertices: number;
  numIndices: number;
}

function decodeBatchMeshResponse(
  response: ArrayBuffer,
  callback: (fragment: BatchMeshResponseFragment) => void,
) {
  const length = response.byteLength;
  let index = 0;
  const dataView = new DataView(response);
  const headerSize =
    /*object id*/ 8 +
    /*fragment key length*/ 8 +
    /*num vertices*/ 8 +
    /*num triangles*/ 8;
  while (index < length) {
    if (index + headerSize > length) {
      throw new Error("Invalid batch mesh fragment response.");
    }
    const objectId = dataView.getBigUint64(index, /*littleEndian=*/ true);
    const objectIdString = objectId.toString();
    const prefix = objectIdString + "\0";
    index += 8;
    const fragmentKeyLength = dataView.getUint32(index, /*littleEndian=*/ true);
    const fragmentKeyLengthHigh = dataView.getUint32(
      index + 4,
      /*littleEndian=*/ true,
    );
    index += 8;
    if (fragmentKeyLengthHigh !== 0) {
      throw new Error("Invalid batch mesh fragment response.");
    }
    if (
      index + fragmentKeyLength + /* num vertices */ 8 + /*num indices*/ 8 >
      length
    ) {
      throw new Error("Invalid batch mesh fragment response.");
    }
    const fragmentKey = new TextDecoder().decode(
      new Uint8Array(response, index, fragmentKeyLength),
    );
    const fullKey = prefix + fragmentKey;
    index += fragmentKeyLength;
    const numVertices = dataView.getUint32(index, /*littleEndian=*/ true);
    const numVerticesHigh = dataView.getUint32(
      index + 4,
      /*littleEndian=*/ true,
    );
    index += 8;
    const numTriangles = dataView.getUint32(index, /*littleEndian=*/ true);
    const numTrianglesHigh = dataView.getUint32(
      index + 4,
      /*littleEndian=*/ true,
    );
    index += 8;
    if (numVerticesHigh !== 0 || numTrianglesHigh !== 0) {
      throw new Error("Invalid batch mesh fragment response.");
    }
    const endOffset = index + numTriangles * 12 + numVertices * 12;
    if (endOffset > length) {
      throw new Error("Invalid batch mesh fragment response.");
    }
    callback({
      fullKey,
      buffer: response,
      verticesOffset: index,
      numVertices,
      indicesOffset: index + 12 * numVertices,
      numIndices: numTriangles * 3,
    });
    index = endOffset;
  }
}

function combineBatchMeshFragments(fragments: BatchMeshResponseFragment[]) {
  let totalVertices = 0;
  let totalIndices = 0;
  for (const fragment of fragments) {
    totalVertices += fragment.numVertices;
    totalIndices += fragment.numIndices;
  }
  const vertexBuffer = new Float32Array(totalVertices * 3);
  const indexBuffer = new Uint32Array(totalIndices);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const fragment of fragments) {
    vertexBuffer.set(
      new Float32Array(
        fragment.buffer,
        fragment.verticesOffset,
        fragment.numVertices * 3,
      ),
      vertexOffset * 3,
    );
    const { numIndices } = fragment;
    const sourceIndices = new Uint32Array(
      fragment.buffer,
      fragment.indicesOffset,
      numIndices,
    );
    convertEndian32(sourceIndices, Endianness.LITTLE);
    for (let i = 0; i < numIndices; ++i) {
      indexBuffer[indexOffset++] = sourceIndices[i] + vertexOffset;
    }
    vertexOffset += fragment.numVertices;
  }
  convertEndian32(vertexBuffer, Endianness.LITTLE);
  return { vertexPositions: vertexBuffer, indices: indexBuffer };
}

async function makeBatchMeshRequest<T>(
  credentialsProvider: CredentialsProvider<OAuth2Credentials>,
  parameters: {
    instance: BrainmapsInstance;
    volumeId: string;
    meshName: string;
  },
  ids: Map<string, T>,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const path = "/v1/objects/meshes:batch";
  const batches: BatchMeshFragment[] = [];
  let prevObjectId: string | undefined;
  let batchSize = 0;
  const pendingIds = new Map<string, T>();
  for (const [id, idData] of ids) {
    pendingIds.set(id, idData);
    ids.delete(id);
    const splitIndex = id.indexOf("\0");
    const objectId = id.substring(0, splitIndex);
    const fragmentId = id.substring(splitIndex + 1);
    if (objectId !== prevObjectId) {
      prevObjectId = objectId;
      batches.push({ object_id: objectId, fragment_keys: [] });
    }
    batches[batches.length - 1].fragment_keys.push(fragmentId);
    if (++batchSize === maxMeshBatchSize) break;
  }
  const payload: BatchMeshFragmentPayload = {
    volume_id: parameters.volumeId,
    mesh_name: parameters.meshName,
    batches: batches,
  };
  try {
    return await (
      await makeRequest(parameters.instance, credentialsProvider, path, {
        method: "POST",
        body: JSON.stringify(payload),
        signal: signal,
      })
    ).arrayBuffer();
  } finally {
    for (const [id, idData] of pendingIds) {
      ids.set(id, idData);
    }
  }
}

@registerSharedObject()
export class BrainmapsMultiscaleMeshSource extends BrainmapsSource(
  MultiscaleMeshSource,
  MultiscaleMeshSourceParameters,
) {
  private listFragmentsParams = (() => {
    const { parameters } = this;
    const { changeSpec } = parameters;
    if (changeSpec !== undefined) {
      return `&header.changeStackId=${changeSpec.changeStackId}`;
    }
    return "";
  })();

  download(chunk: BrainmapsMultiscaleManifestChunk, signal: AbortSignal) {
    const { parameters } = this;
    const path =
      `/v1/objects/${parameters.volumeId}/meshes/` +
      `${parameters.info.lods[0].info.name}:listfragments?` +
      `object_id=${chunk.objectId}&return_supervoxel_ids=true` +
      this.listFragmentsParams;
    return makeRequest(parameters.instance, this.credentialsProvider, path, {
      signal: signal,
    })
      .then((response) => response.json())
      .then((response) => decodeMultiscaleManifestChunk(chunk, response));
  }

  async downloadFragment(chunk: MultiscaleFragmentChunk, signal: AbortSignal) {
    const { parameters } = this;

    const manifestChunk =
      chunk.manifestChunk! as BrainmapsMultiscaleManifestChunk;
    const { fragmentSupervoxelIds } = manifestChunk;
    const manifest = manifestChunk.manifest!;
    const { lod } = chunk;
    const { octree } = manifest;
    const numBaseChunks = fragmentSupervoxelIds.length;
    const row = chunk.chunkIndex;
    let startChunkIndex = row;
    while (startChunkIndex >= numBaseChunks) {
      startChunkIndex = octree[startChunkIndex * 5 + 3];
    }
    let endChunkIndex = row + 1;
    while (endChunkIndex > numBaseChunks) {
      endChunkIndex = octree[endChunkIndex * 5 - 1] & 0x7fffffff;
    }
    const { relativeBlockShape, gridShape } = parameters.info.lods[lod];
    const xBits = Math.ceil(Math.log2(gridShape[0]));
    const yBits = Math.ceil(Math.log2(gridShape[1]));
    const zBits = Math.ceil(Math.log2(gridShape[2]));

    let ids = new Map<string, number>();
    for (
      let chunkIndex = startChunkIndex;
      chunkIndex < endChunkIndex;
      ++chunkIndex
    ) {
      // Determine number of x, y, and z bits to skip.
      const gridX = Math.floor(octree[chunkIndex * 5] / relativeBlockShape[0]);
      const gridY = Math.floor(
        octree[chunkIndex * 5 + 1] / relativeBlockShape[1],
      );
      const gridZ = Math.floor(
        octree[chunkIndex * 5 + 2] / relativeBlockShape[2],
      );
      const fragmentKey = encodeZIndexCompressed3d(
        xBits,
        yBits,
        zBits,
        gridX,
        gridY,
        gridZ,
      )
        .toString(16)
        .padStart(16, "0");
      const entry = fragmentSupervoxelIds[chunkIndex];
      for (const supervoxelId of entry.supervoxelIds) {
        ids.set(supervoxelId + "\0" + fragmentKey, chunkIndex);
      }
    }

    const prevLod = Math.max(0, lod - 1);

    const fragments: (BatchMeshResponseFragment & { chunkIndex: number })[] =
      [];

    const idArray = Array.from(ids);
    idArray.sort((a, b) => defaultStringCompare(a[0], b[0]));
    ids = new Map(idArray);

    const meshName = parameters.info.lods[lod].info.name;

    const parallelRequests = true;

    await new Promise((resolve, reject) => {
      let requestsInProgress = 0;
      let error = false;
      const maybeIssueMoreRequests = () => {
        if (error) return;
        while (ids.size !== 0) {
          ++requestsInProgress;
          makeBatchMeshRequest(
            this.credentialsProvider,
            {
              instance: parameters.instance,
              volumeId: parameters.volumeId,
              meshName,
            },
            ids,
            signal,
          )
            .then((response) => {
              --requestsInProgress;
              decodeBatchMeshResponse(
                response,
                (
                  fragment: BatchMeshResponseFragment & { chunkIndex: number },
                ) => {
                  const chunkIndex = ids.get(fragment.fullKey)!;
                  if (!ids.delete(fragment.fullKey)) {
                    throw new Error(
                      `Received unexpected fragment key: ${JSON.stringify(
                        fragment.fullKey,
                      )}.`,
                    );
                  }
                  fragment.chunkIndex = chunkIndex;
                  fragments.push(fragment);
                },
              );
              maybeIssueMoreRequests();
            })
            .catch((e) => {
              error = true;
              reject(e);
            });
          if (!parallelRequests) break;
        }
        // Notify the chunk queue of the number of download slots being used.  This partially limits
        // parallelism by maximum number of concurrent downloads, and avoids fetch errors due to an
        // excessive number of concurrent requests.
        //
        // Note that the limit on the number of concurrent downloads is not enforced perfectly.  If
        // the new value of `downloadSlots` results in the total number of concurrent downloads
        // exceeding the maximum allowed, the concurrent requests are still issued.  However, no
        // additional lower-priority chunks will be promoted to `ChunkState.DOWNLOADING` until a
        // download slot is available.
        chunk.downloadSlots = Math.max(1, requestsInProgress);
        if (requestsInProgress === 0) {
          resolve(undefined);
          return;
        }
      };
      maybeIssueMoreRequests();
    });

    // Combine fragments
    fragments.sort((a, b) => a.chunkIndex - b.chunkIndex);
    let indexOffset = 0;
    const numSubChunks = 1 << (3 * (lod - prevLod));
    const subChunkOffsets = new Uint32Array(numSubChunks + 1);
    let prevSubChunkIndex = 0;
    for (const fragment of fragments) {
      const row = fragment.chunkIndex;
      const subChunkIndex =
        getOctreeChildIndex(
          octree[row * 5] >>> prevLod,
          octree[row * 5 + 1] >>> prevLod,
          octree[row * 5 + 2] >>> prevLod,
        ) &
        (numSubChunks - 1);
      subChunkOffsets.fill(
        indexOffset,
        prevSubChunkIndex + 1,
        subChunkIndex + 1,
      );
      prevSubChunkIndex = subChunkIndex;
      indexOffset += fragment.numIndices;
    }
    subChunkOffsets.fill(indexOffset, prevSubChunkIndex + 1, numSubChunks + 1);
    assignMultiscaleMeshFragmentData(
      chunk,
      { ...combineBatchMeshFragments(fragments), subChunkOffsets },
      VertexPositionFormat.float32,
    );
  }
}

function groupFragmentsIntoBatches(ids: string[]) {
  const batches = [];
  let index = 0;
  const length = ids.length;
  while (index < length) {
    batches.push(JSON.stringify(ids.slice(index, index + maxMeshBatchSize)));
    index += maxMeshBatchSize;
  }
  return batches;
}

function decodeManifestChunkWithSupervoxelIds(
  chunk: ManifestChunk,
  response: any,
) {
  verifyObject(response);
  const fragmentKeys = verifyObjectProperty(
    response,
    "fragmentKey",
    verifyStringArray,
  );
  const supervoxelIds = verifyObjectProperty(
    response,
    "supervoxelId",
    verifyStringArray,
  );
  const length = fragmentKeys.length;
  if (length !== supervoxelIds.length) {
    throw new Error(
      "Expected fragmentKey and supervoxelId arrays to have the same length.",
    );
  }
  const fragmentIds = supervoxelIds.map(
    (supervoxelId, index) => supervoxelId + "\0" + fragmentKeys[index],
  );
  chunk.fragmentIds = groupFragmentsIntoBatches(fragmentIds);
}

@registerSharedObject()
export class BrainmapsMeshSource extends BrainmapsSource(
  MeshSource,
  MeshSourceParameters,
) {
  private listFragmentsParams = (() => {
    const { parameters } = this;
    const { changeSpec } = parameters;
    if (changeSpec !== undefined) {
      return `&header.changeStackId=${changeSpec.changeStackId}`;
    }
    return "";
  })();

  download(chunk: ManifestChunk, signal: AbortSignal) {
    const { parameters } = this;
    const path =
      `/v1/objects/${parameters.volumeId}/meshes/` +
      `${parameters.meshName}:listfragments?` +
      `object_id=${chunk.objectId}&return_supervoxel_ids=true` +
      this.listFragmentsParams;
    return makeRequest(parameters.instance, this.credentialsProvider, path, {
      signal,
    })
      .then((response) => response.json())
      .then((response) =>
        decodeManifestChunkWithSupervoxelIds(chunk, response),
      );
  }

  async downloadFragment(chunk: FragmentChunk, signal: AbortSignal) {
    const { parameters } = this;

    const ids = new Map<string, null>();
    for (const id of JSON.parse(chunk.fragmentId!)) {
      ids.set(id, null);
    }

    const fragments: BatchMeshResponseFragment[] = [];

    const { credentialsProvider } = this;

    while (ids.size !== 0) {
      const response = await makeBatchMeshRequest(
        credentialsProvider,
        parameters,
        ids,
        signal,
      );
      decodeBatchMeshResponse(response, (fragment) => {
        if (!ids.delete(fragment.fullKey)) {
          throw new Error(
            `Received unexpected fragment key: ${JSON.stringify(
              fragment.fullKey,
            )}.`,
          );
        }
        fragments.push(fragment);
      });
    }
    assignMeshFragmentData(chunk, combineBatchMeshFragments(fragments));
  }
}

function decodeSkeletonChunk(chunk: SkeletonChunk, response: ArrayBuffer) {
  const dv = new DataView(response);
  const numVertices = dv.getUint32(0, true);
  const numVerticesHigh = dv.getUint32(4, true);
  if (numVerticesHigh !== 0) {
    throw new Error("The number of vertices should not exceed 2^32-1.");
  }
  const numEdges = dv.getUint32(8, true);
  const numEdgesHigh = dv.getUint32(12, true);
  if (numEdgesHigh !== 0) {
    throw new Error("The number of edges should not exceed 2^32-1.");
  }
  decodeSkeletonVertexPositionsAndIndices(
    chunk,
    response,
    Endianness.LITTLE,
    /*vertexByteOffset=*/ 16,
    numVertices,
    /*indexByteOffset=*/ undefined,
    /*numEdges=*/ numEdges,
  );
}

@registerSharedObject()
export class BrainmapsSkeletonSource extends BrainmapsSource(
  SkeletonSource,
  SkeletonSourceParameters,
) {
  download(chunk: SkeletonChunk, signal: AbortSignal) {
    const { parameters } = this;
    const payload: SkeletonPayload = {
      object_id: `${chunk.objectId}`,
    };
    const path =
      `/v1/objects/${parameters.volumeId}` +
      `/meshes/${parameters.meshName}` +
      "/skeleton:binary";
    applyChangeStack(parameters.changeSpec, payload);
    return makeRequest(parameters.instance, this.credentialsProvider, path, {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    })
      .then((response) => response.arrayBuffer())
      .then((response) => decodeSkeletonChunk(chunk, response));
  }
}

const spatialAnnotationTypes = ["LOCATION", "LINE", "VOLUME"];

function parseCommaSeparatedPoint(x: string) {
  const pattern = /(-?[0-9]+),(-?[0-9]+),(-?[0-9]+)/;
  const cornerParts = x.match(pattern);
  if (cornerParts === null) {
    throw new Error(`Error parsing number triplet: ${JSON.stringify(x)}.`);
  }
  return vec3.fromValues(
    parseFloat(cornerParts[1]),
    parseFloat(cornerParts[2]),
    parseFloat(cornerParts[3]),
  );
}

function getIdPrefix(parameters: AnnotationSourceParameters) {
  return parameters.volumeId + ":" + parameters.changestack + ":";
}

function parseBrainmapsAnnotationId(idPrefix: string, fullId: string) {
  if (!fullId.startsWith(idPrefix)) {
    throw new Error(
      `Received annotation id ${JSON.stringify(
        fullId,
      )} does not have expected prefix of ${JSON.stringify(idPrefix)}.`,
    );
  }
  const id = fullId.substring(idPrefix.length);
  return id;
}

function parseObjectLabels(obj: any): BigUint64Array[] | undefined {
  if (obj == null) {
    return undefined;
  }
  return [BigUint64Array.from(parseArray(obj, parseUint64))];
}

function parseAnnotation(
  entry: any,
  idPrefix: string,
  expectedId?: string,
): Annotation {
  const corner = verifyObjectProperty(entry, "corner", (x) =>
    parseCommaSeparatedPoint(verifyString(x)),
  );
  const size = verifyObjectProperty(entry, "size", (x) =>
    parseCommaSeparatedPoint(verifyString(x)),
  );
  const description = verifyObjectProperty(
    entry,
    "payload",
    verifyOptionalString,
  );
  const spatialAnnotationType = verifyObjectProperty(
    entry,
    "type",
    verifyString,
  );
  const fullId = verifyObjectProperty(entry, "id", verifyString);
  const id = parseBrainmapsAnnotationId(idPrefix, fullId);
  const segments = verifyObjectProperty(
    entry,
    "objectLabels",
    parseObjectLabels,
  );
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error(
      `Received annotation has unexpected id ${JSON.stringify(fullId)}.`,
    );
  }
  switch (spatialAnnotationType) {
    case "LOCATION": {
      if (vec3.equals(size, kZeroVec)) {
        return {
          type: AnnotationType.POINT,
          id,
          point: corner,
          description,
          relatedSegments: segments,
          properties: [],
        };
      }
      const radii = vec3.scale(vec3.create(), size, 0.5);
      const center = vec3.add(vec3.create(), corner, radii);
      return {
        type: AnnotationType.ELLIPSOID,
        id,
        center,
        radii,
        description,
        relatedSegments: segments,
        properties: [],
      };
    }
    case "LINE":
      return {
        type: AnnotationType.LINE,
        id,
        pointA: corner,
        pointB: vec3.add(vec3.create(), corner, size),
        description,
        relatedSegments: segments,
        properties: [],
      };
    case "VOLUME":
      return {
        type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
        id,
        pointA: corner,
        pointB: vec3.add(vec3.create(), corner, size),
        description,
        relatedSegments: segments,
        properties: [],
      };
    default:
      throw new Error(
        `Unknown spatial annotation type: ${JSON.stringify(
          spatialAnnotationType,
        )}.`,
      );
  }
}

function parseAnnotationResponse(
  response: any,
  idPrefix: string,
  expectedId?: string,
): Annotation {
  verifyObject(response);
  const entry = verifyObjectProperty(response, "annotations", (x) =>
    parseFixedLengthArray(<any[]>[undefined], x, verifyObject),
  )[0];
  return parseAnnotation(entry, idPrefix, expectedId);
}

const annotationPropertySerializers = makeAnnotationPropertySerializers(
  /*rank=*/ 3,
  /*propertySpecs=*/ [],
);

function parseAnnotations(
  chunk: AnnotationGeometryChunk | AnnotationSubsetGeometryChunk,
  responses: any[],
) {
  const serializer = new AnnotationSerializer(annotationPropertySerializers);
  const source = <BrainmapsAnnotationSource>chunk.source.parent;
  const idPrefix = getIdPrefix(source.parameters);
  responses.forEach((response, responseIndex) => {
    try {
      verifyObject(response);
      const annotationsArray = verifyObjectProperty(
        response,
        "annotations",
        (x) => (x === undefined ? [] : x),
      );
      if (!Array.isArray(annotationsArray)) {
        throw new Error(
          `Expected array, but received ${JSON.stringify(
            typeof annotationsArray,
          )}.`,
        );
      }
      for (const entry of annotationsArray) {
        try {
          serializer.add(parseAnnotation(entry, idPrefix));
        } catch (e) {
          throw new Error(`Error parsing annotation: ${e.message}`);
        }
      }
    } catch (parseError) {
      throw new Error(
        `Error parsing ${spatialAnnotationTypes[responseIndex]} annotations: ${parseError.message}`,
      );
    }
  });
  chunk.data = Object.assign(
    new AnnotationGeometryData(),
    serializer.serialize(),
  );
}

function getSpatialAnnotationTypeFromId(id: string) {
  const index = id.indexOf(".");
  return id.substring(0, index);
}

function toCommaSeparated(v: vec3) {
  return `${Math.round(v[0])},${Math.round(v[1])},${Math.round(v[2])}`;
}

function getFullSpatialAnnotationId(
  parameters: AnnotationSourceParameters,
  id: string,
) {
  return `${parameters.volumeId}:${parameters.changestack}:${id}`;
}

function annotationToBrainmaps(annotation: Annotation): any {
  const payload = annotation.description || "";
  const objectLabels =
    annotation.relatedSegments === undefined
      ? undefined
      : Array.from(annotation.relatedSegments[0], (x) => x.toString());
  switch (annotation.type) {
    case AnnotationType.LINE: {
      const { pointA, pointB } = annotation;
      const size = vec3.subtract(vec3.create(), pointB as vec3, pointA as vec3);
      return {
        type: "LINE",
        corner: toCommaSeparated(pointA as vec3),
        size: toCommaSeparated(size),
        object_labels: objectLabels,
        payload,
      };
    }
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX: {
      const { pointA, pointB } = annotation;
      const minPoint = vector.min(vec3.create(), pointA, pointB);
      const maxPoint = vector.max(vec3.create(), pointA, pointB);
      const size = vec3.subtract(maxPoint, maxPoint, minPoint);
      return {
        type: "VOLUME",
        corner: toCommaSeparated(minPoint),
        size: toCommaSeparated(size),
        object_labels: objectLabels,
        payload,
      };
    }
    case AnnotationType.POINT: {
      return {
        type: "LOCATION",
        corner: toCommaSeparated(annotation.point as vec3),
        size: "0,0,0",
        object_labels: objectLabels,
        payload,
      };
    }
    case AnnotationType.ELLIPSOID: {
      const corner = vec3.subtract(
        vec3.create(),
        annotation.center as vec3,
        annotation.radii as vec3,
      );
      const size = vec3.scale(vec3.create(), annotation.radii as vec3, 2);
      return {
        type: "LOCATION",
        corner: toCommaSeparated(corner),
        size: toCommaSeparated(size),
        object_labels: objectLabels,
        payload,
      };
    }
  }
}

@registerSharedObject() //
export class BrainmapsAnnotationGeometryChunkSource extends BrainmapsSource(
  AnnotationGeometryChunkSourceBackend,
  AnnotationSpatialIndexSourceParameters,
) {
  async download(chunk: AnnotationGeometryChunk, signal: AbortSignal) {
    const { parameters } = this;
    return Promise.all(
      spatialAnnotationTypes.map((spatialAnnotationType) =>
        makeRequest(
          parameters.instance,
          this.credentialsProvider,
          `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:get`,
          {
            signal,
            method: "POST",
            body: JSON.stringify({
              type: spatialAnnotationType,
              ignore_payload: true,
            }),
          },
        ).then((response) => response.json()),
      ),
    ).then((values) => {
      parseAnnotations(chunk, values);
    });
  }
}

@registerSharedObject()
export class BrainmapsAnnotationSource extends BrainmapsSource(
  AnnotationSource,
  AnnotationSourceParameters,
) {
  downloadSegmentFilteredGeometry(
    chunk: AnnotationSubsetGeometryChunk,
    _relationshipIndex: number,
    signal: AbortSignal,
  ) {
    const { parameters } = this;
    return Promise.all(
      spatialAnnotationTypes.map((spatialAnnotationType) =>
        makeRequest(
          parameters.instance,
          this.credentialsProvider,
          `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:get`,
          {
            signal,
            method: "POST",
            body: JSON.stringify({
              type: spatialAnnotationType,
              object_labels: [chunk.objectId.toString()],
              ignore_payload: true,
            }),
          },
        ).then((response) => response.json()),
      ),
    ).then((values) => {
      parseAnnotations(chunk, values);
    });
  }

  downloadMetadata(chunk: AnnotationMetadataChunk, signal: AbortSignal) {
    const { parameters } = this;
    const id = chunk.key!;
    return makeRequest(
      parameters.instance,
      this.credentialsProvider,
      `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:get`,
      {
        signal,
        method: "POST",
        body: JSON.stringify({
          type: getSpatialAnnotationTypeFromId(id),
          id: getFullSpatialAnnotationId(parameters, id),
        }),
      },
    )
      .then((response) => response.json())
      .then(
        (response) => {
          chunk.annotation = parseAnnotationResponse(
            response,
            getIdPrefix(parameters),
            id,
          );
        },
        () => {
          chunk.annotation = null;
        },
      );
  }

  add(annotation: Annotation) {
    const { parameters } = this;
    const brainmapsAnnotation = annotationToBrainmaps(annotation);
    return makeRequest(
      parameters.instance,
      this.credentialsProvider,
      `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:push`,
      {
        method: "POST",
        body: JSON.stringify({ annotations: [brainmapsAnnotation] }),
      },
    )
      .then((response) => response.json())
      .then((response) => {
        verifyObject(response);
        const ids = verifyObjectProperty(response, "ids", verifyStringArray);
        if (ids.length !== 1) {
          throw new Error(
            `Expected list of 1 id, but received ${JSON.stringify(ids)}.`,
          );
        }
        const idPrefix = getIdPrefix(this.parameters);
        return parseBrainmapsAnnotationId(idPrefix, ids[0]);
      });
  }

  update(id: AnnotationId, annotation: Annotation) {
    const { parameters } = this;
    const brainmapsAnnotation = annotationToBrainmaps(annotation);
    brainmapsAnnotation.id = getFullSpatialAnnotationId(parameters, id);
    return makeRequest(
      parameters.instance,
      this.credentialsProvider,
      `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:push`,
      {
        method: "POST",
        body: JSON.stringify({ annotations: [brainmapsAnnotation] }),
      },
    ).then((response) => response.json());
  }

  delete(id: AnnotationId) {
    const { parameters } = this;
    return makeRequest(
      parameters.instance,
      this.credentialsProvider,
      `/v1/changes/${parameters.volumeId}/${parameters.changestack}/spatials:delete`,
      {
        method: "POST",
        body: JSON.stringify({
          type: getSpatialAnnotationTypeFromId(id),
          ids: [getFullSpatialAnnotationId(parameters, id)],
        }),
      },
    ).then((response) => response.json());
  }
}
