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

import debounce from 'lodash/debounce';

import {Annotation, AnnotationSource, AnnotationType, LocalAnnotationSource, makeDataBoundsBoundingBoxAnnotationSet, parseAnnotationPropertySpecs, Point} from 'neuroglancer/annotation';
import {AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {AnnotationGeometryChunkSource, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {BoundingBox, CoordinateSpace, coordinateSpaceFromJson, emptyValidCoordinateSpace, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox, WatchableCoordinateSpaceTransform} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompleteUrlOptions, ConvertLegacyUrlOptions, DataSource, DataSourceProvider, DataSubsourceEntry, GetDataSourceOptions, NormalizeUrlOptions, RedirectError} from 'neuroglancer/datasource';
// import {AnnotationSourceParameters, AnnotationSpatialIndexSourceParameters, DataEncoding, IndexedSegmentPropertySourceParameters, MeshSourceParameters, MultiscaleMeshMetadata, MultiscaleMeshSourceParameters, ShardingHashFunction, ShardingParameters, SkeletonMetadata, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/precomputed/base';
import {VertexPositionFormat} from 'neuroglancer/mesh/base';
import {MeshLayer, MeshSource, MultiscaleMeshLayer, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {IndexedSegmentPropertySource, InlineSegmentProperty, InlineSegmentPropertyMap, normalizeInlineSegmentPropertyMap, SegmentPropertyMap} from 'neuroglancer/segmentation_display_state/property_map';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {makeSliceViewChunkSpecification} from 'neuroglancer/sliceview/base';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {DATA_TYPE_ARRAY_CONSTRUCTOR, DataType} from 'neuroglancer/util/data_type';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {HttpError, isNotFoundError, responseJson} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseQueryStringParameters, unparseQueryStringParameters, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString, verifyStringArray, verifyNonnegativeInt} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {getObjectId} from 'neuroglancer/util/object_id';
import {parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {cancellableFetchSpecialOk, GRAPHENE_MANIFEST_REFRESH_PROMISE, isBaseSegmentId, responseIdentity} from 'neuroglancer/datasource/graphene/base';

import {ChunkedGraphSourceParameters, DataEncoding, MeshSourceParameters, MultiscaleMeshMetadata, PYCG_APP_VERSION, ShardingHashFunction, ShardingParameters, SkeletonMetadata, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/graphene/base';
import {IndexedSegmentPropertySourceParameters} from 'neuroglancer/datasource/graphene/base';
import {ChunkedGraphChunkSource, ChunkedGraphLayer} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {StatusMessage} from 'neuroglancer/status';

import {AnnotationSpatialIndexSourceParameters, AnnotationSourceParameters} from 'neuroglancer/datasource/graphene/base';
import { makeChunkedGraphChunkSpecification } from 'src/neuroglancer/sliceview/chunked_graph/base';
import { Uint64Set } from 'src/neuroglancer/uint64_set';
import { ComputedSplit, SegmentationGraphSource, SegmentationGraphSourceConnection, UNKNOWN_NEW_SEGMENT_ID } from 'src/neuroglancer/segmentation_graph/source';
import { VisibleSegmentsState } from 'src/neuroglancer/segmentation_display_state/base';
import { observeWatchable, TrackableValue, WatchableValue, WatchableValueInterface } from 'src/neuroglancer/trackable_value';
import { getChunkPositionFromCombinedGlobalLocalPositions, RenderLayerTransformOrError } from 'src/neuroglancer/render_coordinate_transform';
import { RenderLayer, RenderLayerRole } from 'src/neuroglancer/renderlayer';
import { getSegmentPropertyMap } from '../precomputed/frontend';
import { SegmentationUserLayer } from 'src/neuroglancer/segmentation_user_layer';
import { Tab } from 'src/neuroglancer/widget/tab_view';
import { DependentViewWidget } from 'src/neuroglancer/widget/dependent_view_widget';
import { makeToolActivationStatusMessageWithHeader, makeToolButton, registerLayerTool, Tool, ToolActivation } from 'src/neuroglancer/ui/tool';
import { ANNOTATE_MERGE_SEGMENTS_TOOL_ID } from 'src/neuroglancer/ui/segment_split_merge_tools';
import { EventActionMap } from 'src/neuroglancer/util/event_action_map';
import { addLayerControlToOptionsTab, LayerControlFactory, LayerControlTool, registerLayerControl } from 'src/neuroglancer/widget/layer_control';
import { TextInputWidget } from 'src/neuroglancer/widget/text_input';
import { DateTimeInputWidget } from 'src/neuroglancer/widget/datetime_input';
import { makeCloseButton } from 'src/neuroglancer/widget/close_button';
import { NullarySignal } from 'src/neuroglancer/util/signal';
import { packColor, TrackableRGB } from 'src/neuroglancer/util/color';
import { makeAddButton } from 'src/neuroglancer/widget/add_button';
import { AnnotationLayer, SliceViewAnnotationLayer } from 'src/neuroglancer/annotation/renderlayer';
import { AnnotationDisplayState, AnnotationLayerState } from 'src/neuroglancer/annotation/annotation_layer_state';
import { trackableAlphaValue } from 'src/neuroglancer/trackable_alpha';
import { MouseSelectionState } from 'src/neuroglancer/layer';
import { LayerDataSource, LoadedDataSubsource } from 'src/neuroglancer/layer_data_source';
import { makeIcon } from 'src/neuroglancer/widget/icon';
import { makeValueOrError, valueOrThrow } from 'src/neuroglancer/util/error';
import { resetTemporaryVisibleSegmentsState } from 'src/neuroglancer/segmentation_display_state/frontend';

class GrapheneVolumeChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

class GrapheneChunkedGraphChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(ChunkedGraphChunkSource), ChunkedGraphSourceParameters)) {}

class GrapheneMeshSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(MeshSource), MeshSourceParameters)) {}

class GrapheneSkeletonSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(SkeletonSource), SkeletonSourceParameters)) {
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

class AppInfo {
  segmentationUrl: string;
  meshingUrl: string;
  supported_api_versions: number[];
  constructor(infoUrl: string, obj: any) {
    // .../1.0/... is the legacy link style
    // .../table/... is the current, version agnostic link style (for retrieving the info file)
    const linkStyle = /^(https?:\/\/[.\w:\-\/]+)\/segmentation\/(?:1\.0|table)\/([^\/]+)\/?$/;
    let match = infoUrl.match(linkStyle);
    if (match === null) {
      throw Error(`Graph URL invalid: ${infoUrl}`);
    }
    this.segmentationUrl = `${match[1]}/segmentation/api/v${PYCG_APP_VERSION}/table/${match[2]}`;
    this.meshingUrl = `${match[1]}/meshing/api/v${PYCG_APP_VERSION}/table/${match[2]}`;

    try {
      verifyObject(obj);
      this.supported_api_versions = verifyObjectProperty(
          obj, 'supported_api_versions', x => parseArray(x, verifyNonnegativeInt));
    } catch (error) {
      // Dealing with a prehistoric graph server with no version information
      this.supported_api_versions = [0];
    }
    if (PYCG_APP_VERSION in this.supported_api_versions === false) {
      const redirectMsgBox = new StatusMessage();
      const redirectMsg = `This Neuroglancer branch requires Graph Server version ${
          PYCG_APP_VERSION}, but the server only supports version(s) ${
          this.supported_api_versions}.`;

      if (location.hostname.includes('neuromancer-seung-import.appspot.com')) {
        const redirectLoc = new URL(location.href);
        redirectLoc.hostname = `graphene-v${
            this.supported_api_versions.slice(-1)[0]}-dot-neuromancer-seung-import.appspot.com`;
        redirectMsgBox.setHTML(`Try <a href="${redirectLoc.href}">${redirectLoc.hostname}</a>?`);
      }
      throw new Error(redirectMsg);
    }
  }
}

const N_BITS_FOR_LAYER_ID_DEFAULT = 8;

class GraphInfo {
  chunkSize: vec3;
  nBitsForLayerId: number;
  constructor(obj: any) {
    verifyObject(obj);
    this.chunkSize = verifyObjectProperty(
        obj, 'chunk_size', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
    this.nBitsForLayerId = verifyOptionalObjectProperty(
        obj, 'n_bits_for_layer_id', verifyPositiveInt, N_BITS_FOR_LAYER_ID_DEFAULT);
  }
}

interface MultiscaleVolumeInfo {
  dataType: DataType;
  volumeType: VolumeType;
  mesh: string|undefined;
  skeletons: string|undefined;
  segmentPropertyMap: string|undefined;
  scales: ScaleInfo[];
  modelSpace: CoordinateSpace;
  dataUrl: string;
  app?: AppInfo;
  graph?: GraphInfo;
}

export function parseSpecialUrlOld(url: string): string { // TODO: brought back old parseSpecialUrl
  const urlProtocolPattern = /^([^:\/]+):\/\/([^\/]+)(\/.*)?$/;
  let match = url.match(urlProtocolPattern);
  if (match === null) {
    throw new Error(`Invalid URL: ${JSON.stringify(url)}`);
  }
  const protocol = match[1];
  if (protocol === 'gs') {
    const bucket = match[2];
    let path = match[3];
    if (path === undefined) path = '';
    return `https://storage.googleapis.com/${bucket}${path}`;
  } else if (protocol === 's3') {
    const bucket = match[2];
    let path = match[3];
    if (path === undefined) path = '';
    return `https://s3.amazonaws.com/${bucket}${path}`;
  }
  return url;
}

function parseMultiscaleVolumeInfo(obj: unknown, url: string): MultiscaleVolumeInfo {
  verifyObject(obj);
  const dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
  const numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
  let volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
  const mesh = verifyObjectProperty(obj, 'mesh', verifyOptionalString);
  const skeletons = verifyObjectProperty(obj, 'skeletons', verifyOptionalString);
  const segmentPropertyMap = verifyObjectProperty(obj, 'segment_properties', verifyOptionalString);
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

  let dataUrl = url;
  let app = undefined;
  let graph = undefined;

  if (volumeType !== VolumeType.IMAGE) {
    console.warn("THIS IS HAPPENING!!!!!")
    // volumeType = VolumeType.SEGMENTATION_WITH_GRAPH;
    dataUrl = verifyObjectProperty(obj, 'data_dir', x => parseSpecialUrlOld(x));
    app = verifyObjectProperty(obj, 'app', x => new AppInfo(url, x));
    graph = verifyObjectProperty(obj, 'graph', x => new GraphInfo(x));
  }

  

  

  return {
    dataType,
    volumeType,
    mesh,
    skeletons,
    segmentPropertyMap,
    scales: scaleInfos,
    modelSpace,
    app,
    graph,
    dataUrl,
  };
}

class GrapheneMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  // app: AppInfo;
  // graph: GraphInfo;

  // dataUrl: string;
  // dataType: DataType;
  // numChannels: number;
  // volumeType: VolumeType;
  // mesh: string|undefined;
  // verifyMesh: boolean|undefined;
  // skeletons: string|undefined;
  // app: AppInfo;
  // graph: GraphInfo;
  // scales: ScaleInfo[];

  get dataType() {
    return this.info.dataType;
  }

  get volumeType() {
    return this.info.volumeType;
  }

  get rank() {
    return this.info.modelSpace.rank;
  }

  constructor(
      chunkManager: ChunkManager, public credentialsProvider: SpecialProtocolCredentialsProvider,
      public url: string, public info: MultiscaleVolumeInfo) {
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
      const x = makeDefaultVolumeChunkSpecifications({
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
                 chunkSource: this.chunkManager.getChunkSource(GrapheneVolumeChunkSource, {
                   credentialsProvider: this.credentialsProvider,
                   spec,
                   parameters: {
                     url: resolvePath(this.info.dataUrl, scaleInfo.key),
                     encoding: scaleInfo.encoding,
                     sharding: scaleInfo.sharding,
                   }
                 }),
                 chunkToMultiscaleTransform,
               }));

      return x;
    }));
  }

  getChunkedGraphSources(rootSegments: Uint64Set) {
    const {rank} = this;
    const scaleInfo = this.info.scales[0];

    const spec = makeChunkedGraphChunkSpecification({
      rank,
      dataType: this.info.dataType,
      upperVoxelBound: scaleInfo.size,
      chunkDataSize: Uint32Array.from(this.info.graph!.chunkSize),
      baseVoxelOffset: scaleInfo.voxelOffset,
      // compressedSegmentationBlockSize: scaleInfo.compressedSegmentationBlockSize,
    });

    const stride = rank + 1;
    const chunkToMultiscaleTransform = new Float32Array(stride * stride);
    chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
    const {lowerBounds: baseLowerBound, upperBounds: baseUpperBound} =
          this.info.modelSpace.boundingBoxes[0].box;
    const lowerClipBound = new Float32Array(rank);
    const upperClipBound = new Float32Array(rank);

    for (let i = 0; i < 3; ++i) {
      const relativeScale = 1;
      chunkToMultiscaleTransform[stride * i + i] = relativeScale;
      chunkToMultiscaleTransform[stride * rank + i] = scaleInfo.voxelOffset[i];
      lowerClipBound[i] = baseLowerBound[i];
      upperClipBound[i] = baseUpperBound[i];
    }
    return [[
      {
        chunkSource: this.chunkManager.getChunkSource(GrapheneChunkedGraphChunkSource, {
          spec,
          credentialsProvider: this.credentialsProvider,
          rootSegments,
          parameters: {url: `${this.info.app!.segmentationUrl}/node`}}),
        chunkToMultiscaleTransform,
        lowerClipBound,
        upperClipBound,
      }
    ]];
  }
}

const MultiscaleAnnotationSourceBase = (WithParameters(
    WithCredentialsProvider<SpecialProtocolCredentials>()(MultiscaleAnnotationSource),
    AnnotationSourceParameters));

class GrapheneAnnotationSpatialIndexSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(AnnotationGeometryChunkSource), AnnotationSpatialIndexSourceParameters)) {}

interface GrapheneAnnotationSourceOptions {
  metadata: AnnotationMetadata;
  parameters: AnnotationSourceParameters;
  credentialsProvider: SpecialProtocolCredentialsProvider;
}

export class GrapheneAnnotationSource extends MultiscaleAnnotationSourceBase {
  key: any;
  metadata: AnnotationMetadata;
  credentialsProvider: SpecialProtocolCredentialsProvider;
  OPTIONS: GrapheneAnnotationSourceOptions;
  constructor(chunkManager: ChunkManager, options: GrapheneAnnotationSourceOptions) {
    const {parameters} = options;
    super(chunkManager, {
      rank: parameters.rank,
      relationships: parameters.relationships.map(x => x.name),
      properties: parameters.properties,
      parameters,
    } as any);
    this.readonly = true;
    this.metadata = options.metadata;
    this.credentialsProvider = options.credentialsProvider;
  }

  getSources(): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    return [this.metadata.spatialIndices.map(spatialIndexLevel => {
      const {spec} = spatialIndexLevel;
      return {
        chunkSource: this.chunkManager.getChunkSource(GrapheneAnnotationSpatialIndexSource, {
          credentialsProvider: this.credentialsProvider,
          parent: this,
          spec,
          parameters: spatialIndexLevel.parameters,
        }),
        chunkToMultiscaleTransform: spec.chunkToMultiscaleTransform,
      };
    })];
  }
}

function getLegacyMeshSource(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    parameters: MeshSourceParameters) {
  return chunkManager.getChunkSource(GrapheneMeshSource, {parameters, credentialsProvider});
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

interface ParsedMeshMetadata {
  metadata: MultiscaleMeshMetadata|undefined;
  segmentPropertyMap?: string|undefined;
}

function parseMeshMetadata(data: any): ParsedMeshMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, '@type', verifyString);
  let metadata: MultiscaleMeshMetadata|undefined;
  if (t === 'neuroglancer_legacy_mesh') {
    const sharding = verifyObjectProperty(data, 'sharding', parseGrapheneShardingParameters);
    if (sharding === undefined) {
      metadata = undefined;
    } else {
      const lodScaleMultiplier = 0;
      const vertexQuantizationBits = 10;
      const transform = parseTransform(data);
      metadata = {lodScaleMultiplier, transform, sharding, vertexQuantizationBits};
    }
  } else if (t !== 'neuroglancer_multilod_draco') {
    throw new Error(`Unsupported mesh type: ${JSON.stringify(t)}`);
  } else {
    const lodScaleMultiplier =
        verifyObjectProperty(data, 'lod_scale_multiplier', verifyFinitePositiveFloat);
    const vertexQuantizationBits =
        verifyObjectProperty(data, 'vertex_quantization_bits', verifyPositiveInt);
    const transform = parseTransform(data);
    const sharding = verifyObjectProperty(data, 'sharding', parseGrapheneShardingParameters);
    metadata = {lodScaleMultiplier, transform, sharding, vertexQuantizationBits};
  }
  const segmentPropertyMap = verifyObjectProperty(data, 'segment_properties', verifyOptionalString);
  return {metadata, segmentPropertyMap};
}

async function getMeshMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<ParsedMeshMetadata> {
  let metadata: any;
  try {
    metadata = await getJsonMetadata(chunkManager, credentialsProvider, url);
  } catch (e) {
    if (isNotFoundError(e)) {
      // If we fail to fetch the info file, assume it is the legacy
      // single-resolution mesh format.
      return {metadata: undefined};
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

function parseGrapheneShardingParameters(shardingData: any): Array<ShardingParameters>|undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  let grapheneShardingParameters = new Array<ShardingParameters>();
  for (const layer in shardingData) {
     let index = Number(layer);
     grapheneShardingParameters[index] = parseShardingParameters(shardingData[index])!;
  }
  return grapheneShardingParameters;
}

interface ParsedSkeletonMetadata {
  metadata: SkeletonMetadata;
  segmentPropertyMap: string|undefined;
}

function parseSkeletonMetadata(data: any): ParsedSkeletonMetadata {
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

  if (data.sharding === null) { /* our info file is returning null for this */
    data.sharding = undefined;
  }

  const sharding = verifyObjectProperty(data, 'sharding', parseShardingParameters);
  const segmentPropertyMap = verifyObjectProperty(data, 'segment_properties', verifyOptionalString);
  return {
    metadata: {transform, vertexAttributes, sharding} as SkeletonMetadata,
    segmentPropertyMap
  };
}

async function getSkeletonMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<ParsedSkeletonMetadata> {
  const metadata = await getJsonMetadata(chunkManager, credentialsProvider, url);
  return parseSkeletonMetadata(metadata);
}

function getDefaultCoordinateSpace() {
  return makeCoordinateSpace(
      {names: ['x', 'y', 'z'], units: ['m', 'm', 'm'], scales: Float64Array.of(1e-9, 1e-9, 1e-9)});
}

export function getShardedMeshSource(chunkManager: ChunkManager, parameters: MeshSourceParameters, credentialsProvider: SpecialProtocolCredentialsProvider) {
  return chunkManager.getChunkSource(GrapheneMeshSource, {parameters, credentialsProvider});
}

async function getMeshSource(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, fragmentUrl: string, sharding: boolean) {
  const {metadata, segmentPropertyMap} =
      await getMeshMetadata(chunkManager, credentialsProvider, fragmentUrl);
  if (metadata === undefined) {
    return {
      source: getLegacyMeshSource(chunkManager, credentialsProvider, {
        manifestUrl: url,//parseSpecialUrl(url, credentialsProvider),
        fragmentUrl: fragmentUrl,//parseSpecialUrl(url, credentialsProvider),
        lod: 0,
        sharding: undefined,//sharding, TODO
        verifyMesh: false,
      }),
      transform: mat4.create(),
      segmentPropertyMap
    };
  }
  // TODO: what is this
  // let vertexPositionFormat: VertexPositionFormat;
  // const {vertexQuantizationBits} = metadata;
  // if (vertexQuantizationBits === 10) {
  //   vertexPositionFormat = VertexPositionFormat.uint10;
  // } else if (vertexQuantizationBits === 16) {
  //   vertexPositionFormat = VertexPositionFormat.uint16;
  // } else {
  //   throw new Error(`Invalid vertex quantization bits: ${vertexQuantizationBits}`);
  // }
  return {
    source: getShardedMeshSource(chunkManager, {
      manifestUrl: url,//parseSpecialUrl(url, credentialsProvider),
      fragmentUrl: fragmentUrl,//parseSpecialUrl(url, credentialsProvider),
      lod: 0,
      sharding: metadata.sharding,
      verifyMesh: false,
    }, credentialsProvider)
    /*chunkManager.getChunkSource(MultiscaleMeshSource, {
      credentialsProvider,
      parameters: {url, metadata},
      format: {
        fragmentRelativeVertices: true,
        vertexPositionFormat,
      }
    })*/,
    transform: metadata.transform,
    segmentPropertyMap,
  };
}

// async function getSkeletonSource(
//     chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
//     url: string) {
//   const {metadata, segmentPropertyMap} =
//       await getSkeletonMetadata(chunkManager, undefined/*credentialsProvider*/, url);
//   return {
//     source: chunkManager.getChunkSource(GrapheneSkeletonSource, {
//       credentialsProvider,
//       parameters: {
//         url,
//         metadata,
//       },
//     }),
//     transform: metadata.transform,
//     segmentPropertyMap,
//   };
// }

function getJsonMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<any> {
  return chunkManager.memoize.getUncounted(
      {'type': 'graphene:metadata', url, credentialsProvider: getObjectId(credentialsProvider)},
      async () => {
        return await cancellableFetchSpecialOk(
            credentialsProvider, `${url}/info`, {}, responseJson);
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
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, metadata: any): Promise<DataSource> {
      console.log('getVolumeDataSource', metadata);
  const info = parseMultiscaleVolumeInfo(metadata, url);
  const volume = new GrapheneMultiscaleVolumeChunkSource(
      options.chunkManager, credentialsProvider, url, info);
  console.log('created GrapheneGraphSource');
  const segmentationGraph = new GrapheneGraphSource(info, credentialsProvider, volume);
  const {modelSpace} = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: 'default',
      default: true,
      subsource: {volume},
    },
    {
      id: 'graph',
      default: true,
      subsource: {segmentationGraph},
    },
    {
      id: 'bounds',
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(modelSpace.bounds),
      },
    },
  ];
  if (info.segmentPropertyMap !== undefined) {
    const mapUrl = resolvePath(url, info.segmentPropertyMap);
    const metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, mapUrl);
    const segmentPropertyMap =
        getSegmentPropertyMap(options.chunkManager, credentialsProvider, metadata, mapUrl);
    subsources.push({
      id: 'properties',
      default: true,
      subsource: {segmentPropertyMap},
    });
  }
  if (info.mesh !== undefined) {
    const {source: meshSource, transform} =
        await getMeshSource(options.chunkManager, credentialsProvider,
          info.app!.meshingUrl,
          resolvePath(info.dataUrl, info.mesh),
          true); // TEMP TODO sharding  = true
    const subsourceToModelSubspaceTransform = getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(subsourceToModelSubspaceTransform, subsourceToModelSubspaceTransform, transform);
    subsources.push({
      id: 'mesh',
      default: true,
      subsource: {mesh: meshSource},
      subsourceToModelSubspaceTransform,
    });
  }
  if (info.skeletons !== undefined && false) {/*
    const skeletonsUrl = resolvePath(info.dataUrl, info.skeletons);
    const {source: skeletonSource, transform} =
        await getSkeletonSource(options.chunkManager, credentialsProvider, skeletonsUrl);
    const subsourceToModelSubspaceTransform = getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(subsourceToModelSubspaceTransform, subsourceToModelSubspaceTransform, transform);
    subsources.push({
      id: 'skeletons',
      default: true,
      subsource: {mesh: skeletonSource},
      subsourceToModelSubspaceTransform,
    });
  */}
  return {modelTransform: makeIdentityTransform(modelSpace), subsources};
}

// async function getSkeletonsDataSource(
//     options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
//     url: string): Promise<DataSource> {
//   const {source: skeletons, transform, segmentPropertyMap} =
//       await getSkeletonSource(options.chunkManager, credentialsProvider, url);
//   const subsources: DataSubsourceEntry[] = [
//     {
//       id: 'default',
//       default: true,
//       subsource: {mesh: skeletons},
//       subsourceToModelSubspaceTransform: transform,
//     },
//   ];
//   if (segmentPropertyMap !== undefined) {
//     const mapUrl = resolvePath(url, segmentPropertyMap);
//     const metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, mapUrl);
//     const segmentPropertyMapData =
//         getSegmentPropertyMap(options.chunkManager, credentialsProvider, metadata, mapUrl);
//     subsources.push({
//       id: 'properties',
//       default: true,
//       subsource: {segmentPropertyMap: segmentPropertyMapData},
//     });
//   }
//   return {
//     modelTransform: makeIdentityTransform(getDefaultCoordinateSpace()),
//     subsources,
//   };
// }

function parseKeyAndShardingSpec(url: string, obj: any) {
  verifyObject(obj);
  return {
    url: resolvePath(url, verifyObjectProperty(obj, 'key', verifyString)),
    sharding: verifyObjectProperty(obj, 'sharding', parseShardingParameters),
  };
}

interface AnnotationSpatialIndexLevelMetadata {
  parameters: AnnotationSpatialIndexSourceParameters;
  limit: number;
  spec: AnnotationGeometryChunkSpecification;
}

class AnnotationMetadata {
  coordinateSpace: CoordinateSpace;
  parameters: AnnotationSourceParameters;
  spatialIndices: AnnotationSpatialIndexLevelMetadata[];
  constructor(public url: string, metadata: any) {
    verifyObject(metadata);
    const baseCoordinateSpace =
        verifyObjectProperty(metadata, 'dimensions', coordinateSpaceFromJson);
    const {rank} = baseCoordinateSpace;
    const lowerBounds = verifyObjectProperty(
        metadata, 'lower_bound',
        boundJson => parseFixedLengthArray(new Float64Array(rank), boundJson, verifyFiniteFloat));
    const upperBounds = verifyObjectProperty(
        metadata, 'upper_bound',
        boundJson => parseFixedLengthArray(new Float64Array(rank), boundJson, verifyFiniteFloat));
    this.coordinateSpace = makeCoordinateSpace({
      rank,
      names: baseCoordinateSpace.names,
      units: baseCoordinateSpace.units,
      scales: baseCoordinateSpace.scales,
      boundingBoxes: [makeIdentityTransformedBoundingBox({lowerBounds, upperBounds})],
    });
    this.parameters = {
      type: verifyObjectProperty(
          metadata, 'annotation_type', typeObj => verifyEnumString(typeObj, AnnotationType)),
      rank,
      relationships: verifyObjectProperty(
          metadata, 'relationships',
          relsObj => parseArray(
              relsObj,
              relObj => {
                const common = parseKeyAndShardingSpec(url, relObj);
                const name = verifyObjectProperty(relObj, 'id', verifyString);
                return {...common, name};
              })),
      properties: verifyObjectProperty(metadata, 'properties', parseAnnotationPropertySpecs),
      byId: verifyObjectProperty(metadata, 'by_id', obj => parseKeyAndShardingSpec(url, obj)),
    };
    this.spatialIndices = verifyObjectProperty(
        metadata, 'spatial',
        spatialObj => parseArray(spatialObj, levelObj => {
          const common: AnnotationSpatialIndexSourceParameters =
              parseKeyAndShardingSpec(url, levelObj);
          const gridShape = verifyObjectProperty(
              levelObj, 'grid_shape',
              j => parseFixedLengthArray(new Float32Array(rank), j, verifyPositiveInt));
          const chunkShape = verifyObjectProperty(
              levelObj, 'chunk_size',
              j => parseFixedLengthArray(new Float32Array(rank), j, verifyFinitePositiveFloat));
          const limit = verifyObjectProperty(levelObj, 'limit', verifyPositiveInt);
          const gridShapeInVoxels = new Float32Array(rank);
          for (let i = 0; i < rank; ++i) {
            gridShapeInVoxels[i] = gridShape[i] * chunkShape[i];
          }
          const chunkToMultiscaleTransform = matrix.createIdentity(Float32Array, rank + 1);
          for (let i = 0; i < rank; ++i) {
            chunkToMultiscaleTransform[(rank + 1) * rank + i] = lowerBounds[i];
          }
          const spec: AnnotationGeometryChunkSpecification = {
            limit,
            chunkToMultiscaleTransform,
            ...makeSliceViewChunkSpecification({
              rank,
              chunkDataSize: chunkShape,
              upperVoxelBound: gridShapeInVoxels,
            })
          };
          spec.upperChunkBound = gridShape;
          return {
            parameters: common,
            spec,
            limit,
          };
        }));
    this.spatialIndices.reverse();
  }
}

// async function getAnnotationDataSource(
//     options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
//     url: string, metadata: any): Promise<DataSource> {
//   const info = new AnnotationMetadata(url, metadata);
//   const dataSource: DataSource = {
//     modelTransform: makeIdentityTransform(info.coordinateSpace),
//     subsources: [
//       {
//         id: 'default',
//         default: true,
//         subsource: {
//           annotation: options.chunkManager.getChunkSource(GrapheneAnnotationSource, {
//             credentialsProvider,
//             metadata: info,
//             parameters: info.parameters,
//           }),
//         }
//       },
//     ],
//   };
//   return dataSource;
// }

// async function getMeshDataSource(
//     options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
//     url: string): Promise<DataSource> {
//   const {source: mesh, transform, segmentPropertyMap} =
//       await getMeshSource(options.chunkManager, credentialsProvider, url, url, false); // this is wrong 'url, url'
//   const subsources: DataSubsourceEntry[] = [
//     {
//       id: 'default',
//       default: true,
//       subsource: {mesh},
//       subsourceToModelSubspaceTransform: transform,
//     },
//   ];
//   if (segmentPropertyMap !== undefined) {
//     const mapUrl = resolvePath(url, segmentPropertyMap);
//     const metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, mapUrl);
//     const segmentPropertyMapData =
//         getSegmentPropertyMap(options.chunkManager, credentialsProvider, metadata, mapUrl);
//     subsources.push({
//       id: 'properties',
//       default: true,
//       subsource: {segmentPropertyMap: segmentPropertyMapData},
//     });
//   }

//   return {
//     modelTransform: makeIdentityTransform(getDefaultCoordinateSpace()),
//     subsources,
//   };
// }

export const GrapheneIndexedSegmentPropertySource = WithParameters(
    WithCredentialsProvider<SpecialProtocolCredentials>()(IndexedSegmentPropertySource),
    IndexedSegmentPropertySourceParameters);

// function parseIndexedPropertyMap(data: unknown): {
//   sharding: ShardingParameters|undefined,
//   properties: readonly Readonly<IndexedSegmentProperty>[]
// } {
//   verifyObject(data);
//   const sharding = verifyObjectProperty(data, 'sharding', parseShardingParameters);
//   const properties = verifyObjectProperty(
//       data, 'properties',
//       propertiesObj => parseArray(propertiesObj, (propertyObj): IndexedSegmentProperty => {
//         const id = verifyObjectProperty(propertyObj, 'id', verifyString);
//         const description = verifyOptionalObjectProperty(propertyObj, 'description', verifyString);
//         const type = verifyObjectProperty(propertyObj, 'type', type => {
//           if (type !== 'string') {
//             throw new Error(`Invalid property type: ${JSON.stringify(type)}`);
//           }
//           return type;
//         });
//         return {id, description, type};
//       }));
//   return {sharding, properties};
// }

// async function getSegmentPropertyMapDataSource(
//     options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
//     url: string, metadata: unknown): Promise<DataSource> {
//   options;
//   return {
//     modelTransform: makeIdentityTransform(emptyValidCoordinateSpace),
//     subsources: [
//       {
//         id: 'default',
//         default: true,
//         subsource: {
//           segmentPropertyMap:
//               getSegmentPropertyMap(options.chunkManager, credentialsProvider, metadata, url)
//         },
//       },
//     ],
//   };
// }

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

export class GrapheneDataSource extends DataSourceProvider {
  get description() {
    return 'Graphene file-backed data source';
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
    console.log('GrapheneDataSource get');
    const {url: providerUrl, parameters} = parseProviderUrl(options.providerUrl);
    return options.chunkManager.memoize.getUncounted(
        {'type': 'graphene:get', providerUrl, parameters}, async(): Promise<DataSource> => {
          const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);
          let metadata: any;
          try {
            metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, url);
          } catch (e) {
            if (isNotFoundError(e)) {
              if (parameters['type'] === 'mesh') {
                console.log('does this happen?');
                // return await getMeshDataSource(options, credentialsProvider, url);
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
          console.log('GrapheneDataSource get case', t);
          switch (t) {
            // TODO: are these used for graphene?
            // case 'neuroglancer_skeletons':
            //   return await getSkeletonsDataSource(options, credentialsProvider, url);
            // case 'neuroglancer_multilod_draco':
            // case 'neuroglancer_legacy_mesh':
            //   return await getMeshDataSource(options, credentialsProvider, url);
            // case 'neuroglancer_annotations_v1':
            //   return await getAnnotationDataSource(options, credentialsProvider, url, metadata);
            // case 'neuroglancer_segment_properties':
            //   return await getSegmentPropertyMapDataSource(
            //       options, credentialsProvider, url, metadata);
            // case 'neuroglancer_multiscale_volume':
            case undefined:
              return await getVolumeDataSource(options, credentialsProvider, url, metadata);
            default:
              throw new Error(`Invalid type: ${JSON.stringify(t)}`);
          }
        });
  }
  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}

function getGraphLoadedSubsource(layer: SegmentationUserLayer) {
  for (const dataSource of layer.dataSources) {
    const {loadState} = dataSource;
    if (loadState === undefined || loadState.error !== undefined) continue;
    for (const subsource of loadState.subsources) {
      if (subsource.enabled) {
        if (subsource.subsourceEntry.id === 'graph') {
          return subsource;
        }
      }
    }
  }
  return undefined;
}

function makeColoredAnnotationState(layer: SegmentationUserLayer, loadedSubsource: LoadedDataSubsource, r: number, g: number, b: number) {  
  const {subsourceEntry} = loadedSubsource;
  const source = new LocalAnnotationSource(loadedSubsource.loadedDataSource.transform, [], []);
  
  const displayState = new AnnotationDisplayState();
  displayState.color.value.set([r, g, b]);

  const state = new AnnotationLayerState({
      localPosition: layer.localPosition,
      transform: loadedSubsource.getRenderLayerTransform(),
      source,
      displayState,
      dataSource: loadedSubsource.loadedDataSource.layerDataSource,
      subsourceIndex: loadedSubsource.subsourceIndex,
      subsourceId: subsourceEntry.id,
      role: RenderLayerRole.ANNOTATION,
    });
  layer.addAnnotationLayerState(state, loadedSubsource);
  return state;
}

class MulticutState extends RefCounted {
  changed = new NullarySignal();

  private redGroupAnnotationState: AnnotationLayerState;
  private blueGroupAnnotationState: AnnotationLayerState;

  private annotationToNanometers: Float64Array;

  constructor(layer: SegmentationUserLayer,
      public focusSegment = new TrackableValue<Uint64|undefined>(undefined, x => x),
      public blueGroup = false,
    ) {
    super();
    const loadedSubsource = getGraphLoadedSubsource(layer)!;

    this.redGroupAnnotationState = makeColoredAnnotationState(layer, loadedSubsource, 1, 0, 0);
    this.blueGroupAnnotationState = makeColoredAnnotationState(layer, loadedSubsource, 0, 0, 1);

    this.annotationToNanometers = loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(x => x / 1e-9);

    this.redGroupAnnotationState.source.changed.add(this.changed.dispatch);
    this.blueGroupAnnotationState.source.changed.add(this.changed.dispatch);

    this.registerDisposer(focusSegment.changed.add(this.changed.dispatch));
  }
  
  private pointToSegmentSelection(point: Point): SegmentSelection {
    return {
      position: point.point.map((p, i) => p * this.annotationToNanometers[i]),
      segmentId: point.relatedSegments![0][0],
      rootId: point.relatedSegments![0][1],
    }
  }

  get annotationState() {
    return this.blueGroup ? this.blueGroupAnnotationState : this.redGroupAnnotationState;
  }

  get segments() {
    return [...this.redSegments, ...this.blueSegments];
  }

  get redSegments() {
    return this.sinks.filter(x => x.segmentId !== x.rootId).map(x => x.segmentId);
  }

  get blueSegments() {
    return this.sources.filter(x => x.segmentId !== x.rootId).map(x => x.segmentId);
  }

  get sinks(): SegmentSelection[] {
    return ([...this.redGroupAnnotationState.source] as Point[]).map((x) => this.pointToSegmentSelection(x));
  }

  get sources(): SegmentSelection[] {
    return ([...this.blueGroupAnnotationState.source] as Point[]).map((x) => this.pointToSegmentSelection(x));
  }

  swapGroup() {
    this.blueGroup = !this.blueGroup;
  }

  addPoint(selection: SegmentSelection) {
    const activeGroup = this.blueGroup ? this.blueGroupAnnotationState : this.redGroupAnnotationState;
    const annotations = activeGroup.source;

    const annotation: Point = {
      id: '',
      point: selection.position,
      type: AnnotationType.POINT,
      properties: [],
      relatedSegments: [[selection.segmentId, selection.rootId]],
    };

    annotations.add(annotation);
  }

  clear() {
    this.focusSegment.value = undefined;
    this.blueGroup = false;
    (this.blueGroupAnnotationState.source as LocalAnnotationSource).clear();
    (this.redGroupAnnotationState.source as LocalAnnotationSource).clear();
  }
}

class GraphConnection extends SegmentationGraphSourceConnection {
  multicutState?: MulticutState;


  constructor(
      public graph: GrapheneGraphSource,
      segmentsState: VisibleSegmentsState,
      public transform: WatchableValueInterface<RenderLayerTransformOrError>,
      private chunkSource: GrapheneMultiscaleVolumeChunkSource) {
    super(graph, segmentsState);

    segmentsState.visibleSegments.changed.add((segmentIds: Uint64[]|Uint64|null, add: boolean) => {
      if (segmentIds !== null) {
        segmentIds = Array<Uint64>().concat(segmentIds);
      }
      this.visibleSegmentsChanged(segmentIds, add);
    });
  }

  initializeMulticutState(layer: SegmentationUserLayer) {
    if (this.multicutState) return;
    this.multicutState = new MulticutState(layer);
  }

  createRenderLayers(
      transform: WatchableValueInterface<RenderLayerTransformOrError>,
      localPosition: WatchableValueInterface<Float32Array>,
      multiscaleSource: MultiscaleVolumeChunkSource): RenderLayer[] {

    return [new ChunkedGraphLayer(
      this.chunkSource.info.app!.segmentationUrl,
      this.chunkSource.getChunkedGraphSources(this.segmentsState.visibleSegments),
      multiscaleSource,
      {
        ...this.segmentsState,
        localPosition,
        transform,
      }),];
  };

  private lastDeselectionMessage: StatusMessage|undefined;
  private lastDeselectionMessageExists = false;

  private visibleSegmentsChanged(segments: Uint64[]|null, added: boolean) {
    console.log('visibleSegmentsChanged, added: ', added, segments?.toString());
    const {segmentsState} = this;

    if (segments === null) {
      const leafSegmentCount = this.segmentsState.visibleSegments.size;
      this.segmentsState.segmentEquivalences.clear();
      StatusMessage.showTemporaryMessage(`Deselected all ${leafSegmentCount} segments.`, 3000);

      if (added) {
        console.error("does this actually happen?");
      }
      return;
    }

    for (const segmentId of segments) {
      const isBaseSegment = isBaseSegmentId(segmentId, this.graph.info.graph!.nBitsForLayerId);

      const segmentConst = segmentId.clone();

      if (added) {
        if (isBaseSegment) {
          console.log('doing something');
          this.graph.getRoot(segmentConst).then(rootId => {
            if (segmentConst === rootId) {
              console.error('when does this happen?');
            }
            segmentsState.visibleSegments.delete(segmentConst);
            segmentsState.visibleSegments.add(rootId);

            if (!Uint64.equal(segmentConst, segmentId)) {
              console.log('hello sven', segmentConst.toJSON(), segmentId.toJSON());
            }

            console.log('replacing', segmentConst.toJSON(), 'with', rootId.toJSON());

            console.log('added now', segmentsState.visibleSegments.toJSON());
          });
        }
      } else if (!isBaseSegment) {
        // removed and not a base segment
        const segmentCount = [...segmentsState.segmentEquivalences.setElements(segmentId)].length; // Approximation

        segmentsState.segmentEquivalences.deleteSet(segmentId);

        if (this.lastDeselectionMessage && this.lastDeselectionMessageExists) {
          this.lastDeselectionMessage.dispose();
          this.lastDeselectionMessageExists = false;
        }
        this.lastDeselectionMessage =
            StatusMessage.showMessage(`Deselected ${segmentCount} segments.`);
        this.lastDeselectionMessageExists = true;
        setTimeout(() => {
          if (this.lastDeselectionMessageExists) {
            this.lastDeselectionMessage!.dispose();
            this.lastDeselectionMessageExists = false;
          }
        }, 2000);
      }
    }
  }
    
  computeSplit(include: Uint64, exclude: Uint64): ComputedSplit|undefined {
    console.log("GraphConnection.computeSplit");
    return undefined;
  }

  async submitMulticut(): Promise<void> {
    if (this.multicutState) {
      const {sinks, sources} = this.multicutState;
      if (sinks.length === 0 || sources.length === 0) {
        StatusMessage.showTemporaryMessage('Must select both red and blue groups to perform a multi-cut.', 7000);
      } else if (this.graph.safeToSubmit('Multicut')) {
        const splitRoots = await this.graph.graphServer.splitSegments(sinks, sources);
        if (splitRoots.length === 0) {
          StatusMessage.showTemporaryMessage(`No split found.`, 3000);
        } else {
          const {segmentsState} = this;

          for (const segment of [...sinks, ...sources]) {
            segmentsState.visibleSegments.delete(segment.rootId);
          }

          segmentsState.rootSegmentsAfterEdit!.clear();
          segmentsState.visibleSegments.add(splitRoots);
          segmentsState.rootSegmentsAfterEdit!.add(splitRoots);

          // TODO: Merge unsupported with edits
          // const view = (<any>window)['viewer'];
          // view.differ.purgeHistory();
          // view.differ.ignoreChanges();
        }
      }
    }
  }
}

export interface SegmentSelection {
  segmentId: Uint64;
  rootId: Uint64;
  position: Float32Array;
}

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

async function withErrorMessageHTTP(promise: Promise<Response>, options: {
    initialMessage: string,
    errorPrefix: string
  }): Promise<Response> {
    const status = new StatusMessage(true);
    status.setText(options.initialMessage);
    const dispose = status.dispose.bind(status);
    try {
      const response = await promise;
      dispose();
      return response;
    } catch (e) {
      if (e instanceof HttpError && e.response) {
        let msg: string;
        if (e.response.headers.get('content-type') === 'application/json') {
          msg = (await e.response.json())['message'];
        } else {
          msg = await e.response.text();
        }

        const {errorPrefix = ''} = options;
        status.setErrorMessage(errorPrefix + msg);
        status.setVisible(true);
        throw new Error(`[${e.response.status}] ${errorPrefix}${msg}`);
      }
      throw e;
    }
  }

class GrapheneGraphServerInterface {
  constructor(private url: string, private credentialsProvider: SpecialProtocolCredentialsProvider) {}

  async getRoot(segment: Uint64, timestamp = '') {
    const timestampEpoch = (new Date(timestamp)).valueOf() / 1000;

    const url = `${this.url}/node/${String(segment)}/root?int64_as_str=1${
      Number.isNaN(timestampEpoch) ? '' : `&timestamp=${timestampEpoch}`}`

    const promise = cancellableFetchSpecialOk(
      this.credentialsProvider,
      url,
      {}, responseIdentity);

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Retrieving root for segment ${segment}`,
      errorPrefix: `Could not fetch root: `
    });
    const jsonResp = await response.json();
    return Uint64.parseString(jsonResp['root_id']);
  }

  async mergeSegments(first: SegmentSelection, second: SegmentSelection): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const url2 = `${url}/merge?int64_as_str=1`;

    const promise = cancellableFetchSpecialOk(this.credentialsProvider, url2, {
      method: 'POST',
      body: JSON.stringify([
        [String(first.segmentId), ...first.position.values()],
        [String(second.segmentId), ...second.position.values()]
      ])
    }, responseIdentity);

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Merging ${first.segmentId} and ${second.segmentId}`,
      errorPrefix: 'Merge failed: '
    });
    const jsonResp = await response.json();
    return Uint64.parseString(jsonResp['new_root_ids'][0]);
  }

  async splitSegments(first: SegmentSelection[], second: SegmentSelection[]): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const url2 = `${url}/split?int64_as_str=1`;

    const promise = cancellableFetchSpecialOk(this.credentialsProvider, url2, {
      method: 'POST',
      body: JSON.stringify({
        'sources': first.map(x => [String(x.segmentId), ...x.position.values()]),
        'sinks': second.map(x => [String(x.segmentId), ...x.position.values()])
      })
    }, responseIdentity);

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Splitting ${first.length} sources from ${second.length} sinks`,
      errorPrefix: 'Split failed: '
    });
    const jsonResp = await response.json();
    const final: Uint64[] = new Array(jsonResp['new_root_ids'].length);
    for (let i = 0; i < final.length; ++i) {
      final[i] = Uint64.parseString(jsonResp['new_root_ids'][i]);
    }
    return final;
  }

  async splitPreview(first: SegmentSelection[], second: SegmentSelection[]):
      Promise<{supervoxelConnectedComponents: Uint64Set[], isSplitIllegal: boolean}> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const url2 = `${url}/graph/split_preview?int64_as_str=1`;

    const promise = cancellableFetchSpecialOk(this.credentialsProvider, url2, {
      method: 'POST',
      body: JSON.stringify({
        'sources': first.map(x => [String(x.segmentId), ...x.position.values()]),
        'sinks': second.map(x => [String(x.segmentId), ...x.position.values()])
      })
    }, responseIdentity);

    const response = await withErrorMessageHTTP(promise, {
      initialMessage:
          `Calculating split preview: ${first.length} sources, and ${second.length} sinks`,
      errorPrefix: 'Split preview failed: '
    });
    const jsonResp = await response.json();
    const jsonCCKey = 'supervoxel_connected_components';
    const supervoxelConnectedComponents: Uint64Set[] = new Array(jsonResp[jsonCCKey].length);
    for (let i = 0; i < supervoxelConnectedComponents.length; i++) {
      const connectedComponent = new Array(jsonResp[jsonCCKey][i].length);
      for (let j = 0; j < jsonResp[jsonCCKey][i].length; j++) {
        connectedComponent[j] = Uint64.parseString(jsonResp[jsonCCKey][i][j], 10);
      }
      const connectedComponentSet = new Uint64Set();
      connectedComponentSet.add(connectedComponent);
      supervoxelConnectedComponents[i] = connectedComponentSet;
    }
    const jsonIllegalSplitKey = 'illegal_split';
    return {supervoxelConnectedComponents, isSplitIllegal: jsonResp[jsonIllegalSplitKey]};
  }

  async findPath(first: SegmentSelection, second: SegmentSelection, precisionMode: boolean):
      Promise<number[][]> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const url2 = `${url}/graph/find_path?int64_as_str=1&precision_mode=${Number(precisionMode)}`;

    const promise = cancellableFetchSpecialOk(this.credentialsProvider, url2, {
      method: 'POST',
      body: JSON.stringify([
        [String(first.segmentId), ...first.position.values()],
        [String(second.segmentId), ...second.position.values()]
      ])
    }, responseIdentity);

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Finding path between ${first.segmentId} and ${second.segmentId}`,
      errorPrefix: 'Path finding failed: '
    });
    const jsonResponse = await response.json();
    const supervoxelCentroidsKey = 'centroids_list';
    const centroids = jsonResponse[supervoxelCentroidsKey];
    const missingL2IdsKey = 'failed_l2_ids';
    const missingL2Ids = jsonResponse[missingL2IdsKey];
    if (missingL2Ids && missingL2Ids.length > 0) {
      StatusMessage.showTemporaryMessage(
          'Some level 2 meshes are missing, so the path shown may have a poor level of detail.');
    }
    return centroids;
  }

  async getTimestampLimit() {
    const response = await cancellableFetchSpecialOk(
      this.credentialsProvider, `${this.url}/oldest_timestamp`, {}, responseJson);

    return verifyObjectProperty(response, 'iso', verifyString);
  }
}

class GrapheneGraphSource extends SegmentationGraphSource {
  private connections = new Set<GraphConnection>();
  public graphServer: GrapheneGraphServerInterface;
  public timestamp: TrackableValue<string> = new TrackableValue('', date => {
    console.log('timestamp changed', date);
    return date;
  });
  public timestampLimit: TrackableValue<string> = new TrackableValue(
    '',
    date => {
      let limit = new Date(date).valueOf().toString();
      console.log('timestamplimit', date, limit);
      return limit === 'NaN' ? '' : limit;
    },
    '');

  constructor(public info: MultiscaleVolumeInfo, credentialsProvider: SpecialProtocolCredentialsProvider, private chunkSource: GrapheneMultiscaleVolumeChunkSource) {
    super();
    this.graphServer = new GrapheneGraphServerInterface(info.app!.segmentationUrl, credentialsProvider);

    this.graphServer.getTimestampLimit().then((limit) => {
      this.timestampLimit.value = limit;
    });
  }

  tab(layer: SegmentationUserLayer) {
    return new GrapheneTab(layer);
  }

  connect(segmentsState: VisibleSegmentsState, transform: WatchableValueInterface<RenderLayerTransformOrError>): Owned<SegmentationGraphSourceConnection> {
    const connection = new GraphConnection(this, segmentsState, transform, this.chunkSource);
  
    this.connections.add(connection);
    connection.registerDisposer(() => {
      this.connections.delete(connection);
    });

    return connection;
  }

  getRoot(segment: Uint64) {
    return this.graphServer.getRoot(segment, this.timestamp.value);
  }

  safeToSubmit(action: string) {
    if (this.timestamp.value !== '') {
      StatusMessage.showTemporaryMessage(
          `${action} can not be performed with a segmentation at an older state.`);
      return false;
    }
    return true;
  }

  get highBitRepresentative(): boolean {
    return true;
  }





  // following not used

  async merge(a: Uint64, b: Uint64): Promise<Uint64> {
    return  new Uint64();
  }

  async split(include: Uint64, exclude: Uint64): Promise<{include: Uint64, exclude: Uint64}> {
    console.log('MGS splitting', include, 'and', exclude);
    return {include, exclude};
  }

  trackSegment(id: Uint64, callback: (id: Uint64|null) => void): () => void {
    return () => {
      console.log('trackSegment... do nothing', id, callback);
    }
  }
}

const ANNOTATE_MULTICUT_SEGMENTS_TOOL_ID = 'multicutSegments';
const REFRESH_MESH_TOOL_ID = 'refreshMesh';
const GRAPHENE_MERGE_SEGMENTS_TOOL_ID = 'grapheneMergeSegments';
const GRAPHENE_SPLIT_SEGMENTS_TOOL_ID = 'grapheneSplitSegments';

export class GrapheneTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-graphene-tab');
    element.appendChild(addLayerControlToOptionsTab(this, layer, this.visibility, timeControl));
    element.appendChild(
    this.registerDisposer(new DependentViewWidget(
                              layer.displayState.segmentationGroupState.value.graph,
                              (graph, parent, context) => {
                                if (graph === undefined) return;
                                if (!(graph instanceof GrapheneGraphSource)) return;
                                const toolbox = document.createElement('div');
                                toolbox.className = 'neuroglancer-segmentation-toolbox';
                                toolbox.appendChild(makeToolButton(context, layer, {
                                  toolJson: GRAPHENE_MERGE_SEGMENTS_TOOL_ID,
                                  label: 'Merge',
                                  title: 'Merge segments'
                                }));
                                toolbox.appendChild(makeToolButton(context, layer, {
                                  toolJson: GRAPHENE_SPLIT_SEGMENTS_TOOL_ID,
                                  label: 'Split',
                                  title: 'Split segments'
                                }));
                                parent.appendChild(toolbox);
                                  }))
            .element);
    element.appendChild(
        this.registerDisposer(new DependentViewWidget(
                                  layer.displayState.segmentationGroupState.value.graph,
                                  (graph, parent, context) => {
                                    if (graph === undefined) return;
                                    if (!(graph instanceof GrapheneGraphSource)) return;
                                    const toolbox = document.createElement('div');
                                    toolbox.className = 'neuroglancer-segmentation-toolbox';
                                    toolbox.appendChild(makeToolButton(context, layer, {
                                      toolJson: ANNOTATE_MULTICUT_SEGMENTS_TOOL_ID,
                                      label: 'Multicut',
                                      title: 'Multicut segments'
                                    }));
                                    toolbox.appendChild(makeIcon({
                                      text: 'Swap',
                                      title: 'Swap group',
                                      onClick: () => {
                                        if (!(layer.graphConnection instanceof GraphConnection)) return;
                                        layer.graphConnection.multicutState?.swapGroup();
                                      }}));
                                    toolbox.appendChild(makeIcon({
                                      text: 'Submit',
                                      title: 'Submit multicut',
                                      onClick: () => {
                                        console.log('submit multicut');
                                        if (!(layer.graphConnection instanceof GraphConnection)) return;
                                        layer.graphConnection.submitMulticut();
                                      }}));
                                    toolbox.appendChild(makeCloseButton({
                                      title: 'Unlink layer',
                                      onClick: () => {
                                        console.log('clear multicut');
                                        if (!(layer.graphConnection instanceof GraphConnection)) return;
                                        layer.graphConnection.multicutState?.clear();
                                      }}));
                                    parent.appendChild(toolbox);
                                  }))
            .element);
        element.appendChild(
        this.registerDisposer(new DependentViewWidget(
                                  layer.displayState.segmentationGroupState,
                                  (graph, parent, context) => {
                                    // if (graph === undefined) return;
                                    // if (!(graph instanceof GrapheneGraphSource)) return;
                                    const toolbox = document.createElement('div');
                                    // toolbox.className = 'neuroglancer-segmentation-toolbox';
                                    toolbox.appendChild(makeToolButton(context, layer, {
                                      toolJson: REFRESH_MESH_TOOL_ID,
                                      label: 'Refresh Mesh',
                                      title: 'Refresh Meshes'
                                    }));
                                    parent.appendChild(toolbox);
                                  }))
            .element);
  }
}

function timeLayerControl(): LayerControlFactory<SegmentationUserLayer> {
  return {
    makeControl: (layer, context) => {
      const segmentationGroupState = layer.displayState.segmentationGroupState.value;
      const {graph: {value: graph}} = segmentationGroupState;

      const timestamp = graph instanceof GrapheneGraphSource ? graph.timestamp : new TrackableValue<string>('', x => x);

      const timestampLimit = graph instanceof GrapheneGraphSource ? graph.timestampLimit : new TrackableValue<string>('0', x => x);
      
      const controlElement = document.createElement('div');
      controlElement.classList.add('neuroglancer-time-control');
      const widget =
          context.registerDisposer(new DateTimeInputWidget(timestamp, new Date(timestampLimit.value), new Date()));

      timestampLimit.changed.add(() => {
        widget.setMin(new Date(timestampLimit.value));
      });

      timestamp.changed.add(() => {
        segmentationGroupState.visibleSegments.clear();
        segmentationGroupState.temporaryVisibleSegments.clear();
      });

      controlElement.appendChild(widget.element);

      context.registerDisposer(observeWatchable(value => {
        const isVisible = value === undefined;
        controlElement.style.visibility = isVisible ? '' : 'hidden';
        // checkbox.checked = isVisible;
      }, layer.displayState.segmentDefaultColor));
      return {controlElement, control: widget};
    },
    activateTool: activation => {
      // console.log('activate timeLayerControl');
      // const {layer} = activation.tool;
      // // chooseColorMode(layer, false);
      // // randomize(layer);
    },
  };
}

const REFRESH_MESH_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'refresh-mesh'},
});

class RefreshMeshTool extends Tool<SegmentationUserLayer> {
  activate(activation: ToolActivation<this>) {
    activation.bindInputEventMap(REFRESH_MESH_INPUT_EVENT_MAP);

    const someMeshLayer = (layer: SegmentationUserLayer) => {
      for (let x of layer.renderLayers) {
        if (x instanceof MeshLayer || x instanceof MultiscaleMeshLayer) {
          return x;
        }
      }
      return undefined;
    };

    activation.bindAction('refresh-mesh', event => {
      event.stopPropagation();
      console.log('refresh mesh');

      const {segmentSelectionState, segmentationGroupState} = this.layer.displayState;
      if (!segmentSelectionState.hasSelectedSegment) return;
      const segment = segmentSelectionState.selectedSegment;
      const {visibleSegments} = segmentationGroupState.value;
      if (!visibleSegments.has(segment)) return;
      const meshLayer = someMeshLayer(this.layer);
      if (!meshLayer) return;
      const meshSource = meshLayer.source;
      console.log('refresh mesh invoking promise');
      const promise = meshSource.rpc?.promiseInvoke<any>(
        GRAPHENE_MANIFEST_REFRESH_PROMISE,
        {'rpcId': meshSource.rpcId!, 'segment': segment.toString()});
      // let msgTail = 'if full mesh does not appear try again after this message disappears.';
      // this.chunkedGraphLayer!.withErrorMessage(promise, {
      //   initialMessage: `Reloading mesh for segment ${segment}, ${msgTail}`,
      //   errorPrefix: `Could not fetch mesh manifest: `
      // });
    });
  }

  toJSON() {
    return REFRESH_MESH_TOOL_ID;
  }

  get description() {
    return `refresh mesh`;
  }
}

const getMousePoisitionInNanometers = (mouseState: MouseSelectionState) => {
  const {position, coordinateSpace: {scales}} = mouseState;
  return position.map((x, i) => x * scales[i] * 1e9);
}

const maybeGetSelection = (tool: Tool<SegmentationUserLayer>, visibleSegments: Uint64Set): SegmentSelection|undefined => {
  const {mouseState} = tool;
  const {segmentSelectionState: {value, baseValue}} = tool.layer.displayState;
  if (!baseValue || !value) return; // could this happen or is this just for type checking
  if (!visibleSegments.has(value)) {
    // show error message
    return;
  }
  if (mouseState.updateUnconditionally()) {
    return {
      rootId: value.clone(),
      segmentId: baseValue.clone(),
      position: getMousePoisitionInNanometers(mouseState),
    };
  }
  return;
}

const MERGE_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'merge-segments'},
  'at:shift?+mousedown2': {action: 'set-anchor'},
});

class MergeSegmentsTool extends Tool<SegmentationUserLayer> {
  lastAnchorSelection = new WatchableValue<SegmentSelection|undefined>(undefined);

  activate(activation: ToolActivation<this>) {
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = this.layer.displayState.segmentationGroupState.value;

    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = 'Merge segments';
    body.classList.add('neuroglancer-merge-segments-status');

    activation.bindInputEventMap(MERGE_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
    });

    activation.bindAction('merge-segments', event => {
      event.stopPropagation();
      (async () => {
        const {graph: {value: graph}} = segmentationGroupState;
        if (graph === undefined) return;
        if (!(graph instanceof GrapheneGraphSource)) return;

        const lastSegmentSelection = this.lastAnchorSelection.value;

        if (lastSegmentSelection) {
          const currentSegmentSelection = maybeGetSelection(this, segmentationGroupState.visibleSegments);
          if (currentSegmentSelection) {
            StatusMessage.showTemporaryMessage(
              `Selected ${currentSegmentSelection.segmentId} as sink for merge.`, 3000);

            if (!graph.safeToSubmit('Merge')) return;

            const mergedRoot = await graph.graphServer.mergeSegments(lastSegmentSelection, currentSegmentSelection);

            const {visibleSegments, rootSegmentsAfterEdit} = segmentationGroupState;
            rootSegmentsAfterEdit!.clear();
            visibleSegments.delete(lastSegmentSelection.rootId);
            visibleSegments.delete(currentSegmentSelection.rootId);
            visibleSegments.add(mergedRoot);
            rootSegmentsAfterEdit!.add(mergedRoot);
            this.lastAnchorSelection.value = undefined;
            // TODO: Merge unsupported with edits
            // const view = (<any>window)['viewer'];
            // view.deactivateEditMode();
            // view.differ.purgeHistory();
            // view.differ.ignoreChanges();
          }
        }
      })()
    });
    activation.bindAction('set-anchor', event => {
      event.stopPropagation();
      const selection = maybeGetSelection(this, segmentationGroupState.visibleSegments);

      if (selection) {
        this.lastAnchorSelection.value = selection;
        StatusMessage.showTemporaryMessage(
          `Selected ${selection.segmentId} as source for merge. Pick a sink.`, 3000);
      }
    });
  }

  toJSON() {
    return GRAPHENE_MERGE_SEGMENTS_TOOL_ID;
  }

  get description() {
    return `merge segments`;
  }
}

const SPLIT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'split-segments'},
  'at:shift?+mousedown2': {action: 'set-anchor'},
});

class SplitSegmentsTool extends Tool<SegmentationUserLayer> {
  lastAnchorSelection = new WatchableValue<SegmentSelection|undefined>(undefined);

  activate(activation: ToolActivation<this>) {
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = this.layer.displayState.segmentationGroupState.value;

    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = 'Split segments';
    body.classList.add('neuroglancer-split-segments-status');

    activation.bindInputEventMap(SPLIT_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
    });

    activation.bindAction('split-segments', event => {
      event.stopPropagation();
      (async () => {
        const {graph: {value: graph}} = segmentationGroupState;
        if (graph === undefined) return;
        if (!(graph instanceof GrapheneGraphSource)) return;

        const lastSegmentSelection = this.lastAnchorSelection.value;

        if (lastSegmentSelection) {
          const currentSegmentSelection = maybeGetSelection(this, segmentationGroupState.visibleSegments);
          if (currentSegmentSelection) {
            StatusMessage.showTemporaryMessage(
              `Selected ${currentSegmentSelection.segmentId} as sink for split.`, 3000);
            
            if (!graph.safeToSubmit('Split')) return;

            const splitRoots = await graph.graphServer.splitSegments([lastSegmentSelection], [currentSegmentSelection]);

            if (splitRoots.length === 0) {
              StatusMessage.showTemporaryMessage(`No split found.`, 3000);
              return;
            }

            const {visibleSegments, rootSegmentsAfterEdit} = segmentationGroupState;
            rootSegmentsAfterEdit!.clear();
            visibleSegments.delete(currentSegmentSelection.rootId);
            visibleSegments.add(splitRoots);
            rootSegmentsAfterEdit!.add(splitRoots);
            this.lastAnchorSelection.value = undefined;
            // TODO: Merge unsupported with edits
            // const view = (<any>window)['viewer'];
            // view.deactivateEditMode();
            // view.differ.purgeHistory();
            // view.differ.ignoreChanges();
          }
        }
      })()
    });
    activation.bindAction('set-anchor', event => {
      event.stopPropagation();
      const selection = maybeGetSelection(this, segmentationGroupState.visibleSegments);

      if (selection) {
        this.lastAnchorSelection.value = selection;
        StatusMessage.showTemporaryMessage(
            `Selected ${selection.segmentId} as source for split. Pick a sink.`, 3000);
      }
    });
  }

  toJSON() {
    return GRAPHENE_SPLIT_SEGMENTS_TOOL_ID;
  }

  get description() {
    return `split segments`;
  }
}

function getMousePositionInAnnotationCoordinates(
    unsnappedPosition: Float32Array, annotationLayer: AnnotationLayerState): Float32Array|
    undefined {
  const chunkTransform = annotationLayer.chunkTransform.value;
  if (chunkTransform.error !== undefined) return undefined;
  const chunkPosition = new Float32Array(chunkTransform.modelTransform.unpaddedRank);
  if (!getChunkPositionFromCombinedGlobalLocalPositions(
          chunkPosition, unsnappedPosition, annotationLayer.localPosition.value,
          chunkTransform.layerRank, chunkTransform.combinedGlobalLocalToChunkTransform)) {
    return undefined;
  }
  return chunkPosition;
}

const MULTICUT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'set-anchor'},
  'at:shift?+mousedown2': {action: 'swap-group'},
});

class MulticutSegmentsTool extends Tool<SegmentationUserLayer> {
  grapheneConnection?: GraphConnection;

  constructor(public layer: SegmentationUserLayer, public toggle: boolean = false) {
    super(layer, toggle);

    console.log('MulticutSegmentsTool create', this.layer);

    const maybeCreateMulticutState = () => {
      if (this.grapheneConnection) return;
      const {graphConnection} = this.layer;

      if (graphConnection && graphConnection instanceof GraphConnection) {
        this.grapheneConnection = graphConnection;
        this.grapheneConnection.initializeMulticutState(this.layer);
      }
    };
    this.layer.dataSourcesChanged.add(() => {
      console.log('MulticutSegmentsTool this.layer.dataSourcesChanged');
    });
    this.layer.readyStateChanged.add(() => {
      console.log('MulticutSegmentsTool this.layer.readyStateChanged');
      maybeCreateMulticutState();
    });
    maybeCreateMulticutState();
  }

  toJSON() {
    return ANNOTATE_MULTICUT_SEGMENTS_TOOL_ID;
  }

  deactivate() {
    console.log('deactivate MulticutSegmentsTool');
  }

  activate(activation: ToolActivation<this>) {
    // Ensure we use the same segmentationGroupState while activated. // TODO why is this necessary rather than just accesing through this.layer?
    const segmentationGroupState = this.layer.displayState.segmentationGroupState.value;
    console.log('activate MulticutSegmentsTool', activation);

    const {displayState} = this.layer;

    if (!this.grapheneConnection) return;
    const {multicutState, segmentsState} = this.grapheneConnection;
    if (multicutState === undefined) return;

    const blueColor = new Uint64(packColor(vec3.fromValues(0, 0, 1)));
    const redColor = new Uint64(packColor(vec3.fromValues(1, 0, 0)));

    multicutState.changed.add(() => {
      const focusSegment = multicutState.focusSegment.value;

      resetTemporaryVisibleSegmentsState(segmentationGroupState);
      displayState.showFocusSegments.value = false;
      displayState.segmentStatedColors.value.clear(); // TODO, should only clear those that are in temp sets
      displayState.focusSegments.clear();
      
      if (focusSegment === undefined) return;

      segmentsState.useTemporaryVisibleSegments.value = true;
      segmentsState.useTemporarySegmentEquivalences.value = true;
      displayState.showFocusSegments.value = true;

      // add to focus segments and temporary sets
      displayState.focusSegments.add(focusSegment);
      segmentsState.temporaryVisibleSegments.add(focusSegment);

      for (const segment of multicutState.segments) {
        segmentsState.temporaryVisibleSegments.add(segment);
        displayState.focusSegments.add(segment);
      }

      // all other segments are added to the focus segment equivalences
      for (const equivalence of segmentsState.segmentEquivalences.setElements(focusSegment)) {
        if (!segmentsState.temporaryVisibleSegments.has(equivalence)) {
          segmentsState.temporarySegmentEquivalences.link(focusSegment, equivalence);
        }
      }

      // set colors
      for (const segment of multicutState.blueSegments) {
        displayState.segmentStatedColors.value.set(segment, blueColor);
      }

      for (const segment of multicutState.redSegments) {
        displayState.segmentStatedColors.value.set(segment, redColor);
      }
    });

    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = 'Multicut segments';
    body.classList.add('neuroglancer-merge-segments-status');
    activation.bindInputEventMap(MULTICUT_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
    });

    activation.bindAction('swap-group', event => {
      event.stopPropagation();
      if (this.grapheneConnection) {
        this.grapheneConnection.multicutState?.swapGroup();
      }
    });

    activation.bindAction('set-anchor', event => {
      event.stopPropagation();

      if (!this.grapheneConnection) return;
      const {multicutState} = this.grapheneConnection;
      if (!multicutState) return;
      
      const {segmentSelectionState: {baseValue, value}} = this.layer.displayState;
      if (!baseValue || !value) return; // could this happen or is this just for type checking

      if (!segmentationGroupState.visibleSegments.has(value)) {
        StatusMessage.showTemporaryMessage(
            'The selected supervoxel is of an unselected segment', 7000);
        return;
      }
      if (multicutState.focusSegment.value === undefined) {
        multicutState.focusSegment.value = value.clone();
      }

      if (!Uint64.equal(multicutState.focusSegment.value, value)) {
        StatusMessage.showTemporaryMessage(
            `The selected supervoxel has root segment ${
                value.toString()}, but the supervoxels already selected have root ${
                multicutState.focusSegment.value.toString()}`,
            12000);
        return;
      }
      const {mouseState} = this;

      const isRoot = Uint64.equal(baseValue, value);

      if (!isRoot) {
        for (const segment of multicutState.segments) {
          if (Uint64.equal(segment, baseValue)) {
            StatusMessage.showTemporaryMessage(
                `Supervoxel ${baseValue.toString()} has already been selected`, 7000);
            return;
          }
        }
      }

      if (mouseState.updateUnconditionally()) {
        const point = getMousePositionInAnnotationCoordinates(mouseState.unsnappedPosition, multicutState.annotationState);
        if (point === undefined) return;
        multicutState.addPoint({position: point, segmentId: baseValue.clone(), rootId: value.clone()});
      }
    });
  }

  get description() {
    return `multicut`;
  }
}

const TIME_JSON_KEY = 'graphTime';

const timeControl = {
  label: 'Time',
  title: 'View segmentation at earlier point of time',
  toolJson: TIME_JSON_KEY,
  ...timeLayerControl(),
};

registerLayerTool(SegmentationUserLayer, ANNOTATE_MULTICUT_SEGMENTS_TOOL_ID, layer => {
  console.log('creating MulticutSegmentsTool');
  return new MulticutSegmentsTool(layer, true);
});

registerLayerTool(SegmentationUserLayer, GRAPHENE_MERGE_SEGMENTS_TOOL_ID, layer => {
  console.log('creating MergeSegmentsTool');
  return new MergeSegmentsTool(layer, true);
});

registerLayerTool(SegmentationUserLayer, GRAPHENE_SPLIT_SEGMENTS_TOOL_ID, layer => {
  console.log('creating SplitSegmentsTool');
  return new SplitSegmentsTool(layer, true);
});

registerLayerTool(SegmentationUserLayer, REFRESH_MESH_TOOL_ID, layer => {
  console.log('creating RefreshMeshTool');
  return new RefreshMeshTool(layer);
});

registerLayerControl(SegmentationUserLayer, timeControl);  
