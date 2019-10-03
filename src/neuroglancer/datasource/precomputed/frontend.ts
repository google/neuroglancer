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

import {AnnotationSource, makeDataBoundsBoundingBox} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {DataSource} from 'neuroglancer/datasource';
import {DataEncoding, MeshSourceParameters, MultiscaleMeshMetadata, MultiscaleMeshSourceParameters, ShardingHashFunction, ShardingParameters, SkeletonMetadata, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/precomputed/base';
import {VertexPositionFormat} from 'neuroglancer/mesh/base';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {fetchOk, parseSpecialUrl} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseIntVec, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';

class PrecomputedVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {}

class PrecomputedMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {}

class PrecomputedMultiscaleMeshSource extends
(WithParameters(MultiscaleMeshSource, MultiscaleMeshSourceParameters)) {}

export class PrecomputedSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {
  get skeletonVertexCoordinatesInVoxels() {
    return false;
  }
  get vertexAttributes() {
    return this.parameters.metadata.vertexAttributes;
  }
}

function resolvePath(a: string, b: string) {
  const outputParts = a.split('/');
  for (const part of b.split('/')) {
    if (part === '..') {
      if (outputParts.length !== 0) {
        outputParts.length = outputParts.length - 1;
        continue;
      }
    }
    outputParts.push(part);
  }
  return outputParts.join('/');
}

class ScaleInfo {
  key: string;
  encoding: VolumeChunkEncoding;
  resolution: vec3;
  voxelOffset: vec3;
  size: vec3;
  chunkSizes: vec3[];
  compressedSegmentationBlockSize: vec3|undefined;
  sharding: ShardingParameters|undefined;
  constructor(obj: any) {
    verifyObject(obj);
    this.resolution = verifyObjectProperty(
        obj, 'resolution', x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.voxelOffset = verifyObjectProperty(
        obj, 'voxel_offset', x => x === undefined ? vec3.create() : parseIntVec(vec3.create(), x));
    this.size = verifyObjectProperty(
        obj, 'size', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
    this.chunkSizes = verifyObjectProperty(
        obj, 'chunk_sizes',
        x => parseArray(x, y => parseFixedLengthArray(vec3.create(), y, verifyPositiveInt)));
    if (this.chunkSizes.length === 0) {
      throw new Error('No chunk sizes specified.');
    }
    this.sharding = verifyObjectProperty(obj, 'sharding', parseShardingParameters);
    if (this.sharding !== undefined && this.chunkSizes.length !== 1) {
      throw new Error('Sharding requires a single chunk size per scale');
    }
    let encoding = this.encoding =
        verifyObjectProperty(obj, 'encoding', x => verifyEnumString(x, VolumeChunkEncoding));
    if (encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION) {
      this.compressedSegmentationBlockSize = verifyObjectProperty(
          obj, 'compressed_segmentation_block_size',
          x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
    }
    this.key = verifyObjectProperty(obj, 'key', verifyString);
  }
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  numChannels: number;
  volumeType: VolumeType;
  mesh: string|undefined;
  skeletons: string|undefined;
  scales: ScaleInfo[];

  getMeshSource() {
    const {mesh} = this;
    if (mesh !== undefined) {
      return getMeshSource(this.chunkManager, resolvePath(this.url, mesh));
    }
    const {skeletons} = this;
    if (skeletons !== undefined) {
      return getSkeletonSource(this.chunkManager, resolvePath(this.url, skeletons));
    }
    return null;
  }

  constructor(public chunkManager: ChunkManager, public url: string, obj: any) {
    verifyObject(obj);
    const t = verifyObjectProperty(obj, '@type', verifyOptionalString);
    if (t !== undefined && t !== 'neuroglancer_multiscale_volume') {
      throw new Error(`Invalid type: ${JSON.stringify(t)}`);
    }
    this.dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
    this.numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
    this.volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
    this.mesh = verifyObjectProperty(obj, 'mesh', verifyOptionalString);
    this.skeletons = verifyObjectProperty(obj, 'skeletons', verifyOptionalString);
    this.scales = verifyObjectProperty(obj, 'scales', x => parseArray(x, y => new ScaleInfo(y)));
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.scales.map(scaleInfo => {
      return VolumeChunkSpecification
          .getDefaults({
            voxelSize: scaleInfo.resolution,
            dataType: this.dataType,
            numChannels: this.numChannels,
            transform: mat4.fromTranslation(
                mat4.create(),
                vec3.multiply(vec3.create(), scaleInfo.resolution, scaleInfo.voxelOffset)),
            upperVoxelBound: scaleInfo.size,
            volumeType: this.volumeType,
            chunkDataSizes: scaleInfo.chunkSizes,
            baseVoxelOffset: scaleInfo.voxelOffset,
            compressedSegmentationBlockSize: scaleInfo.compressedSegmentationBlockSize,
            volumeSourceOptions,
          })
          .map(spec => this.chunkManager.getChunkSource(PrecomputedVolumeChunkSource, {
            spec,
            parameters: {
              url: resolvePath(this.url, scaleInfo.key),
              encoding: scaleInfo.encoding,
              sharding: scaleInfo.sharding,
            }
          }));
    });
  }

  getStaticAnnotations() {
    const baseScale = this.scales[0];
    const annotationSet =
        new AnnotationSource(mat4.fromScaling(mat4.create(), baseScale.resolution));
    annotationSet.readonly = true;
    annotationSet.add(makeDataBoundsBoundingBox(
        baseScale.voxelOffset, vec3.add(vec3.create(), baseScale.voxelOffset, baseScale.size)));
    return annotationSet;
  }
}

export function getShardedMeshSource(chunkManager: ChunkManager, parameters: MeshSourceParameters) {
  return chunkManager.getChunkSource(PrecomputedMeshSource, {parameters});
}

function parseTransform(data: any): mat4 {
  return verifyObjectProperty(data, 'transform', value => {
    const transform = mat4.create();
    if (value !== undefined) {
      parseFixedLengthArray(transform.subarray(0, 12), value, verifyFiniteFloat);
    }
    mat4.transpose(transform, transform);
    return transform;
  });
}

function parseMeshMetadata(data: any): MultiscaleMeshMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, '@type', verifyString);
  if (t !== 'neuroglancer_multilod_draco') {
    throw new Error(`Unsupported mesh type: ${JSON.stringify(t)}`);
  }
  const lodScaleMultiplier =
      verifyObjectProperty(data, 'lod_scale_multiplier', verifyFinitePositiveFloat);
  const vertexQuantizationBits =
      verifyObjectProperty(data, 'vertex_quantization_bits', verifyPositiveInt);
  const transform = parseTransform(data);
  const sharding = verifyObjectProperty(data, 'sharding', parseShardingParameters);
  return {lodScaleMultiplier, transform, sharding, vertexQuantizationBits};
}

function getMeshMetadata(
    chunkManager: ChunkManager, url: string): Promise<MultiscaleMeshMetadata|undefined> {
  return chunkManager.memoize.getUncounted(
      {'type': 'precomputed:MeshSource', url},
      () => fetchOk(`${url}/info`)
                .then(
                    response => {
                      return response.json().then(value => parseMeshMetadata(value));
                    },
                    // If we fail to fetch the info file, assume it is the legacy
                    // single-resolution mesh format.
                    () => undefined));
}

function parseShardingEncoding(y: any): DataEncoding {
  if (y === undefined) return DataEncoding.RAW;
  return verifyEnumString(y, DataEncoding);
}

function parseShardingParameters(shardingData: any): ShardingParameters|undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  const t = verifyObjectProperty(shardingData, '@type', verifyString);
  if (t !== 'neuroglancer_uint64_sharded_v1') {
    throw new Error(`Unsupported sharding format: ${JSON.stringify(t)}`);
  }
  const hash =
      verifyObjectProperty(shardingData, 'hash', y => verifyEnumString(y, ShardingHashFunction));
  const preshiftBits = verifyObjectProperty(shardingData, 'preshift_bits', verifyInt);
  const shardBits = verifyObjectProperty(shardingData, 'shard_bits', verifyInt);
  const minishardBits = verifyObjectProperty(shardingData, 'minishard_bits', verifyInt);
  const minishardIndexEncoding =
      verifyObjectProperty(shardingData, 'minishard_index_encoding', parseShardingEncoding);
  const dataEncoding = verifyObjectProperty(shardingData, 'data_encoding', parseShardingEncoding);
  return {hash, preshiftBits, shardBits, minishardBits, minishardIndexEncoding, dataEncoding};
}

function parseSkeletonMetadata(data: any): SkeletonMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, '@type', verifyString);
  if (t !== 'neuroglancer_skeletons') {
    throw new Error(`Unsupported skeleton type: ${JSON.stringify(t)}`);
  }
  const transform = parseTransform(data);
  const vertexAttributes = new Map<string, VertexAttributeInfo>();
  verifyObjectProperty(data, 'vertex_attributes', attributes => {
    if (attributes === undefined) return;
    parseArray(attributes, attributeData => {
      verifyObject(attributeData);
      const id = verifyObjectProperty(attributeData, 'id', verifyString);
      if (id === '') throw new Error('vertex attribute id must not be empty');
      if (vertexAttributes.has(id)) {
        throw new Error(`duplicate vertex attribute id ${JSON.stringify(id)}`);
      }
      const dataType =
          verifyObjectProperty(attributeData, 'data_type', y => verifyEnumString(y, DataType));
      const numComponents =
          verifyObjectProperty(attributeData, 'num_components', verifyPositiveInt);
      vertexAttributes.set(id, {dataType, numComponents});
    });
  });
  const sharding = verifyObjectProperty(data, 'sharding', parseShardingParameters);
  return {transform, vertexAttributes, sharding};
}

function getSkeletonMetadata(
    chunkManager: ChunkManager, url: string): Promise<SkeletonMetadata> {
  return chunkManager.memoize.getUncounted(
      {'type': 'precomputed:SkeletonSource', url}, async () => {
        const response = await fetchOk(`${url}/info`);
        const value = await response.json();
        return parseSkeletonMetadata(value);
      });
}

async function getMeshSource(chunkManager: ChunkManager, url: string) {
  const metadata = await getMeshMetadata(chunkManager, url);
  if (metadata === undefined) {
    return getShardedMeshSource(chunkManager, {url, lod: 0});
  }
  let vertexPositionFormat: VertexPositionFormat;
  const {vertexQuantizationBits} = metadata;
  if (vertexQuantizationBits === 10) {
    vertexPositionFormat = VertexPositionFormat.uint10;
  } else if (vertexQuantizationBits === 16) {
    vertexPositionFormat = VertexPositionFormat.uint16;
  } else {
    throw new Error(`Invalid vertex quantization bits: ${vertexQuantizationBits}`);
  }
  return chunkManager.getChunkSource(PrecomputedMultiscaleMeshSource, {
    parameters: {url, metadata},
    format: {
      fragmentRelativeVertices: true,
      vertexPositionFormat,
      transform: metadata.transform,
    }
  });
}

export async function getSkeletonSource(chunkManager: ChunkManager, url: string) {
  const metadata = await getSkeletonMetadata(chunkManager, url);
  return chunkManager.getChunkSource(PrecomputedSkeletonSource, {
    parameters: {
      url,
      metadata,
    },
    transform: metadata.transform,
  });
}

export function getVolume(chunkManager: ChunkManager, url: string) {
  url = parseSpecialUrl(url);
  return chunkManager.memoize.getUncounted(
      {'type': 'precomputed:MultiscaleVolumeChunkSource', url},
      () => fetchOk(`${url}/info`)
                .then(response => response.json())
                .then(response => new MultiscaleVolumeChunkSource(chunkManager, url, response)));
}

export class PrecomputedDataSource extends DataSource {
  get description() {
    return 'Precomputed file-backed data source';
  }
  getVolume(chunkManager: ChunkManager, url: string) {
    return getVolume(chunkManager, url);
  }
  getMeshSource(chunkManager: ChunkManager, url: string) {
    return getMeshSource(chunkManager, parseSpecialUrl(url));
  }
  getSkeletonSource(chunkManager: ChunkManager, url: string) {
    return getSkeletonSource(chunkManager, parseSpecialUrl(url));
  }
}
