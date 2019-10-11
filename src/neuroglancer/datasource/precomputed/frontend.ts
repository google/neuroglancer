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

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {BoundingBox, CoordinateSpace, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {CompleteUrlOptions, ConvertLegacyUrlOptions, DataSource, DataSourceProvider, DataSubsourceEntry, GetDataSourceOptions, NormalizeUrlOptions, RedirectError} from 'neuroglancer/datasource';
import {DataEncoding, MeshSourceParameters, MultiscaleMeshMetadata, MultiscaleMeshSourceParameters, ShardingHashFunction, ShardingParameters, SkeletonMetadata, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/precomputed/base';
import {VertexPositionFormat} from 'neuroglancer/mesh/base';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {fetchOk, HttpError, parseSpecialUrl} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseQueryStringParameters, unparseQueryStringParameters, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';

class PrecomputedVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {}

class PrecomputedMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {}

class PrecomputedMultiscaleMeshSource extends
(WithParameters(MultiscaleMeshSource, MultiscaleMeshSourceParameters)) {}

class PrecomputedSkeletonSource extends
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
  resolution: Float64Array;
  voxelOffset: Float32Array;
  size: Float32Array;
  chunkSizes: Uint32Array[];
  compressedSegmentationBlockSize: vec3|undefined;
  sharding: ShardingParameters|undefined;
  constructor(obj: any, numChannels: number) {
    verifyObject(obj);
    const rank = (numChannels === 1) ? 3 : 4;
    const resolution = this.resolution = new Float64Array(rank);
    const voxelOffset = this.voxelOffset = new Float32Array(rank);
    const size = this.size = new Float32Array(rank);
    if (rank === 4) {
      resolution[3] = 1;
      size[3] = numChannels;
    }
    verifyObjectProperty(
        obj, 'resolution',
        x => parseFixedLengthArray(resolution.subarray(0, 3), x, verifyFinitePositiveFloat));
    verifyOptionalObjectProperty(
        obj, 'voxel_offset', x => parseFixedLengthArray(voxelOffset.subarray(0, 3), x, verifyInt));
    verifyObjectProperty(
        obj, 'size', x => parseFixedLengthArray(size.subarray(0, 3), x, verifyPositiveInt));
    this.chunkSizes = verifyObjectProperty(
        obj, 'chunk_sizes', x => parseArray(x, y => {
                              const chunkSize = new Uint32Array(rank);
                              if (rank === 4) chunkSize[3] = numChannels;
                              parseFixedLengthArray(chunkSize.subarray(0, 3), y, verifyPositiveInt);
                              return chunkSize;
                            }));
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

interface MultiscaleVolumeInfo {
  dataType: DataType;
  volumeType: VolumeType;
  mesh: string|undefined;
  skeletons: string|undefined;
  scales: ScaleInfo[];
  modelSpace: CoordinateSpace;
}

function parseMultiscaleVolumeInfo(obj: unknown): MultiscaleVolumeInfo {
  verifyObject(obj);
  const dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
  const numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
  const volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
  const mesh = verifyObjectProperty(obj, 'mesh', verifyOptionalString);
  const skeletons = verifyObjectProperty(obj, 'skeletons', verifyOptionalString);
  const scaleInfos =
      verifyObjectProperty(obj, 'scales', x => parseArray(x, y => new ScaleInfo(y, numChannels)));
  if (scaleInfos.length === 0) throw new Error('Expected at least one scale');
  const baseScale = scaleInfos[0];
  const rank = (numChannels === 1) ? 3 : 4;
  const scales = new Float64Array(rank);
  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const names = ['x', 'y', 'z'];
  const units = ['m', 'm', 'm'];

  for (let i = 0; i < 3; ++i) {
    scales[i] = baseScale.resolution[i] / 1e9;
    lowerBounds[i] = baseScale.voxelOffset[i];
    upperBounds[i] = lowerBounds[i] + baseScale.size[i];
  }
  if (rank === 4) {
    scales[3] = 1;
    upperBounds[3] = numChannels;
    names[3] = 'c^';
    units[3] = '';
  }
  const box: BoundingBox = {lowerBounds, upperBounds};
  const modelSpace = makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });
  return {dataType, volumeType, mesh, skeletons, scales: scaleInfos, modelSpace};
}

class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  get dataType() {
    return this.info.dataType;
  }

  get volumeType() {
    return this.info.volumeType;
  }

  get rank() {
    return this.info.modelSpace.rank;
  }

  constructor(chunkManager: ChunkManager, public url: string, public info: MultiscaleVolumeInfo) {
    super(chunkManager);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const modelResolution = this.info.scales[0].resolution;
    const {rank} = this;
    return transposeNestedArrays(this.info.scales.map(scaleInfo => {
      const {resolution} = scaleInfo;
      const stride = rank + 1;
      const chunkToMultiscaleTransform = new Float32Array(stride * stride);
      chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
      for (let i = 0; i < 3; ++i) {
        const relativeScale = resolution[i] / modelResolution[i];
        chunkToMultiscaleTransform[stride * i + i] = relativeScale;
        chunkToMultiscaleTransform[stride * rank + i] = scaleInfo.voxelOffset[i] * relativeScale;
      }
      if (rank === 4) {
        chunkToMultiscaleTransform[stride * 3 + 3] = 1;
      }
      return makeDefaultVolumeChunkSpecifications({
               rank,
               dataType: this.dataType,
               chunkToMultiscaleTransform,
               upperVoxelBound: scaleInfo.size,
               volumeType: this.volumeType,
               chunkDataSizes: scaleInfo.chunkSizes,
               baseVoxelOffset: scaleInfo.voxelOffset,
               compressedSegmentationBlockSize: scaleInfo.compressedSegmentationBlockSize,
               volumeSourceOptions,
             })
          .map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                 chunkSource: this.chunkManager.getChunkSource(PrecomputedVolumeChunkSource, {
                   spec,
                   parameters: {
                     url: resolvePath(this.url, scaleInfo.key),
                     encoding: scaleInfo.encoding,
                     sharding: scaleInfo.sharding,
                   }
                 }),
                 chunkToMultiscaleTransform,
               }));
    }));
  }
}

function getLegacyMeshSource(chunkManager: ChunkManager, parameters: MeshSourceParameters) {
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

async function getMeshMetadata(
    chunkManager: ChunkManager, url: string): Promise<MultiscaleMeshMetadata|undefined> {
  let metadata: any;
  try {
    metadata = await getJsonMetadata(chunkManager, url);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      // If we fail to fetch the info file, assume it is the legacy
      // single-resolution mesh format.
      return undefined;
    }
    throw e;
  }
  return parseMeshMetadata(metadata);
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

async function getSkeletonMetadata(
    chunkManager: ChunkManager, url: string): Promise<SkeletonMetadata> {
  const metadata = await getJsonMetadata(chunkManager, url);
  return parseSkeletonMetadata(metadata);
}

function getDefaultCoordinateSpace() {
  return makeCoordinateSpace(
      {names: ['x', 'y', 'z'], units: ['m', 'm', 'm'], scales: Float64Array.of(1e-9, 1e-9, 1e-9)});
}

async function getMeshSource(chunkManager: ChunkManager, url: string) {
  const metadata = await getMeshMetadata(chunkManager, url);
  if (metadata === undefined) {
    return {source: getLegacyMeshSource(chunkManager, {url, lod: 0}), transform: mat4.create()};
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
  return {
    source: chunkManager.getChunkSource(PrecomputedMultiscaleMeshSource, {
      parameters: {url, metadata},
      format: {
        fragmentRelativeVertices: true,
        vertexPositionFormat,
      }
    }),
    transform: metadata.transform
  };
}

async function getSkeletonSource(chunkManager: ChunkManager, url: string) {
  const metadata = await getSkeletonMetadata(chunkManager, url);
  return {
    source: chunkManager.getChunkSource(PrecomputedSkeletonSource, {
      parameters: {
        url,
        metadata,
      },
    }),
    transform: metadata.transform
  };
}

function getJsonMetadata(chunkManager: ChunkManager, url: string): Promise<any> {
  url = parseSpecialUrl(url);
  return chunkManager.memoize.getUncounted({'type': 'precomputed:metadata', url}, async () => {
    const response = await fetchOk(`${url}/info`);
    return response.json();
  });
}

function getSubsourceToModelSubspaceTransform(info: MultiscaleVolumeInfo) {
  const m = mat4.create();
  const resolution = info.scales[0].resolution;
  for (let i = 0; i < 3; ++i) {
    m[5 * i] = 1 / resolution[i];
  }
  return m;
}

async function getVolumeDataSource(
    options: GetDataSourceOptions, url: string, normalizedUrl: string,
    metadata: any): Promise<DataSource> {
  const info = parseMultiscaleVolumeInfo(metadata);
  const volume = new MultiscaleVolumeChunkSource(options.chunkManager, normalizedUrl, info);
  const {modelSpace} = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: 'default',
      default: true,
      subsource: {volume},
    },
    {
      id: 'bounds',
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(modelSpace.bounds),
      },
    },
  ];
  if (info.mesh !== undefined) {
    const meshUrl = resolvePath(url, info.mesh);
    const {source: meshSource, transform} =
        await getMeshSource(options.chunkManager, parseSpecialUrl(meshUrl));
    const subsourceToModelSubspaceTransform = getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(subsourceToModelSubspaceTransform, subsourceToModelSubspaceTransform, transform);
    subsources.push({
      id: 'mesh',
      default: true,
      subsource: {mesh: meshSource},
      subsourceToModelSubspaceTransform,
    });
  }
  if (info.skeletons !== undefined) {
    const skeletonsUrl = resolvePath(url, info.skeletons);
    const {source: skeletonSource, transform} =
        await getSkeletonSource(options.chunkManager, parseSpecialUrl(skeletonsUrl));
    const subsourceToModelSubspaceTransform = getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(subsourceToModelSubspaceTransform, subsourceToModelSubspaceTransform, transform);
    subsources.push({
      id: 'skeletons',
      default: true,
      subsource: {mesh: skeletonSource},
      subsourceToModelSubspaceTransform,
    });
  }
  return {modelTransform: makeIdentityTransform(modelSpace), subsources};
}

async function getSkeletonsDataSource(
    options: GetDataSourceOptions, url: string): Promise<DataSource> {
  const {source: skeletons, transform} = await getSkeletonSource(options.chunkManager, url);
  return {
    modelTransform: makeIdentityTransform(getDefaultCoordinateSpace()),
    subsources: [
      {
        id: 'default',
        default: true,
        subsource: {mesh: skeletons},
        subsourceToModelSubspaceTransform: transform,
      },
    ],
  };
}

async function getMeshDataSource(options: GetDataSourceOptions, url: string): Promise<DataSource> {
  const {source: mesh, transform} = await getMeshSource(options.chunkManager, url);
  return {
    modelTransform: makeIdentityTransform(getDefaultCoordinateSpace()),
    subsources: [
      {
        id: 'default',
        default: true,
        subsource: {mesh},
        subsourceToModelSubspaceTransform: transform,
      },
    ],
  };
}

const urlPattern = /^([^#]*)(?:#(.*))?$/;

function parseProviderUrl(providerUrl: string) {
  let [, url, fragment] = providerUrl.match(urlPattern)!;
  if (url.endsWith('/')) {
    url = url.substring(0, url.length - 1);
  }
  const parameters = parseQueryStringParameters(fragment || '');
  return {url, parameters};
}

function unparseProviderUrl(url: string, parameters: any) {
  const fragment = unparseQueryStringParameters(parameters);
  if (fragment) {
    url += `#${fragment}`;
  }
  return url;
}

export class PrecomputedDataSource extends DataSourceProvider {
  get description() {
    return 'Precomputed file-backed data source';
  }

  normalizeUrl(options: NormalizeUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    if (options.type === 'mesh') {
      parameters['type'] = 'mesh';
    }
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    return options.chunkManager.memoize.getUncounted(
        {'type': 'precomputed:get', url}, async(): Promise<DataSource> => {
          const normalizedUrl = parseSpecialUrl(url);
          let metadata: any;
          try {
            metadata = await getJsonMetadata(options.chunkManager, normalizedUrl);
          } catch (e) {
            if (e instanceof HttpError && e.status === 404) {
              if (parameters['type'] === 'mesh') {
                return await getMeshDataSource(options, normalizedUrl);
              }
            }
            throw e;
          }
          verifyObject(metadata);
          const redirect = verifyOptionalObjectProperty(metadata, 'redirect', verifyString);
          if (redirect !== undefined) {
            throw new RedirectError(redirect);
          }
          const t = verifyOptionalObjectProperty(metadata, '@type', verifyString);
          switch (t) {
            case 'neuroglancer_skeletons':
              return await getSkeletonsDataSource(options, normalizedUrl);
            case 'neuroglancer_multilod_draco':
              return await getMeshDataSource(options, normalizedUrl);
            case 'neuroglancer_multiscale_volume':
            case undefined:
              return await getVolumeDataSource(options, url, normalizedUrl, metadata);
            default:
              throw new Error(`Invalid type: ${JSON.stringify(t)}`);
          }
        });
  }
  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(options.providerUrl, options.cancellationToken);
  }
}
