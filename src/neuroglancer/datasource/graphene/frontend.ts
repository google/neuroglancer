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

import './graphene.css';

import {AnnotationReference, AnnotationType, LocalAnnotationSource, makeDataBoundsBoundingBoxAnnotationSet, Point} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {makeIdentityTransform} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {DataSource, DataSubsourceEntry, GetDataSourceOptions, RedirectError} from 'neuroglancer/datasource';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {Owned} from 'neuroglancer/util/disposable';
import {mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {HttpError, isNotFoundError, responseJson} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString, verifyNonnegativeInt, verify3dVec} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {getGrapheneFragmentKey, isBaseSegmentId, responseIdentity} from 'neuroglancer/datasource/graphene/base';
import {ChunkedGraphSourceParameters, MeshSourceParameters, MultiscaleMeshMetadata, PYCG_APP_VERSION} from 'neuroglancer/datasource/graphene/base';
import {DataEncoding, ShardingHashFunction, ShardingParameters} from 'neuroglancer/datasource/precomputed/base';
import {StatusMessage} from 'neuroglancer/status';
import { makeChunkedGraphChunkSpecification } from 'neuroglancer/datasource/graphene/base';
import { ComputedSplit, SegmentationGraphSource, SegmentationGraphSourceConnection, SegmentationGraphSourceTab, VisibleSegmentEquivalencePolicy } from 'neuroglancer/segmentation_graph/source';
import { TrackableValue, WatchableSet, WatchableValue, WatchableValueInterface } from 'neuroglancer/trackable_value';
import { getChunkPositionFromCombinedGlobalLocalPositions, RenderLayerTransformOrError } from 'neuroglancer/render_coordinate_transform';
import { RenderLayer, RenderLayerRole } from 'neuroglancer/renderlayer';
import { getSegmentPropertyMap, MultiscaleVolumeInfo, parseMultiscaleVolumeInfo, parseProviderUrl, PrecomputedDataSource, PrecomputedMultiscaleVolumeChunkSource, resolvePath } from 'neuroglancer/datasource/precomputed/frontend';
import {CHUNKED_GRAPH_LAYER_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification, CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID} from 'neuroglancer/datasource/graphene/base';
import {FrontendTransformedSource, getVolumetricTransformedSources, serializeAllTransformedSources, SliceViewChunkSource, SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {SliceViewPanelRenderLayer, SliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import { RefCounted } from 'neuroglancer/util/disposable';
import { LayerChunkProgressInfo } from 'neuroglancer/chunk_manager/base';
import { augmentSegmentId, makeSegmentWidget, resetTemporaryVisibleSegmentsState, SegmentationDisplayState3D, SegmentationLayerSharedObject, Uint64MapEntry } from 'neuroglancer/segmentation_display_state/frontend';
import { LayerView, MouseSelectionState, VisibleLayerInfo } from 'neuroglancer/layer';
import { ChunkTransformParameters, getChunkTransformParameters } from 'neuroglancer/render_coordinate_transform';
import { DisplayDimensionRenderInfo } from 'neuroglancer/navigation_state';
import { makeValueOrError, ValueOrError, valueOrThrow } from 'neuroglancer/util/error';
import { makeCachedLazyDerivedWatchableValue, NestedStateManager, registerNested } from 'neuroglancer/trackable_value';
import { SharedWatchableValue } from 'neuroglancer/shared_watchable_value';
import { CredentialsManager } from 'neuroglancer/credentials_provider';
import { makeToolActivationStatusMessageWithHeader, makeToolButton, registerLayerTool, Tool, ToolActivation } from 'neuroglancer/ui/tool';
import { SegmentationUserLayer } from 'neuroglancer/segmentation_user_layer';
import { DependentViewContext } from 'neuroglancer/widget/dependent_view_widget';
import { AnnotationLayerView, MergedAnnotationStates } from 'neuroglancer/ui/annotations';
import { AnnotationDisplayState, AnnotationLayerState } from 'neuroglancer/annotation/annotation_layer_state';
import { LoadedDataSubsource } from 'neuroglancer/layer_data_source';
import { NullarySignal } from 'neuroglancer/util/signal';
import { Trackable } from 'neuroglancer/util/trackable';
import { makeIcon } from 'neuroglancer/widget/icon';
import { EventActionMap } from 'neuroglancer/util/event_action_map';
import { packColor } from 'neuroglancer/util/color';
import { Uint64Set } from 'neuroglancer/uint64_set';

function vec4FromVec3(vec: vec3, alpha = 0) {
  const res = vec4.clone([...vec]);
  res[3] = alpha;
  return res;
}

const RED_COLOR = vec3.fromValues(1, 0, 0);
const BLUE_COLOR = vec3.fromValues(0, 0, 1);
const RED_COLOR_SEGMENT = vec4FromVec3(RED_COLOR, 0.5);
const BLUE_COLOR_SEGMENT = vec4FromVec3(BLUE_COLOR, 0.5);
const RED_COLOR_HIGHLIGHT = vec4FromVec3(RED_COLOR, 0.25);
const BLUE_COLOR_HIGHTLIGHT = vec4FromVec3(BLUE_COLOR, 0.25);
const TRANSPARENT_COLOR = vec4.fromValues(0.5, 0.5, 0.5, 0.01);
const RED_COLOR_SEGMENT_PACKED = new Uint64(packColor(RED_COLOR_SEGMENT));
const BLUE_COLOR_SEGMENT_PACKED = new Uint64(packColor(BLUE_COLOR_SEGMENT));
const TRANSPARENT_COLOR_PACKED = new Uint64(packColor(TRANSPARENT_COLOR));
const MULTICUT_OFF_COLOR = vec4.fromValues(0, 0, 0, 0.5);

class GrapheneMeshSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(MeshSource), MeshSourceParameters)) {
  getFragmentKey(objectKey: string|null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
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
      const redirectMsg = `This Neuroglancer branch requires Graph Server version ${
          PYCG_APP_VERSION}, but the server only supports version(s) ${
          this.supported_api_versions}.`;
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

interface GrapheneMultiscaleVolumeInfo extends MultiscaleVolumeInfo {
  dataUrl: string;
  app: AppInfo;
  graph: GraphInfo;
}

function parseGrapheneMultiscaleVolumeInfo(obj: unknown, url: string, credentialsManager: CredentialsManager): GrapheneMultiscaleVolumeInfo {
  const volumeInfo = parseMultiscaleVolumeInfo(obj);
  const dataUrl = verifyObjectProperty(obj, 'data_dir', x => parseSpecialUrl(x, credentialsManager)).url;
  const app = verifyObjectProperty(obj, 'app', x => new AppInfo(url, x));
  const graph = verifyObjectProperty(obj, 'graph', x => new GraphInfo(x));
  return {
    ...volumeInfo,
    app,
    graph,
    dataUrl,
  };
}

class GrapheneMultiscaleVolumeChunkSource extends PrecomputedMultiscaleVolumeChunkSource {
  constructor(
      chunkManager: ChunkManager, public chunkedGraphCredentialsProvider: SpecialProtocolCredentialsProvider,
      public info: GrapheneMultiscaleVolumeInfo) {
    super(chunkManager, undefined, info.dataUrl, info);
  }

  getChunkedGraphSource() {
    const {rank} = this;
    const scaleInfo = this.info.scales[0];

    const spec = makeChunkedGraphChunkSpecification({
      rank,
      dataType: this.info.dataType,
      upperVoxelBound: scaleInfo.size,
      chunkDataSize: Uint32Array.from(this.info.graph.chunkSize),
      baseVoxelOffset: scaleInfo.voxelOffset,
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
    return {
        chunkSource: this.chunkManager.getChunkSource(GrapheneChunkedGraphChunkSource, {
          spec,
          credentialsProvider: this.chunkedGraphCredentialsProvider,
          parameters: {url: `${this.info.app!.segmentationUrl}/node`}}),
        chunkToMultiscaleTransform,
        lowerClipBound,
        upperClipBound,
      };
  }
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

function getShardedMeshSource(chunkManager: ChunkManager, parameters: MeshSourceParameters, credentialsProvider: SpecialProtocolCredentialsProvider) {
  return chunkManager.getChunkSource(GrapheneMeshSource, {parameters, credentialsProvider});
}

async function getMeshSource(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, fragmentUrl: string, nBitsForLayerId: number) {
  const {metadata, segmentPropertyMap} =
      await getMeshMetadata(chunkManager, undefined, fragmentUrl);
  const parameters: MeshSourceParameters = {
    manifestUrl: url,
    fragmentUrl: fragmentUrl,
    lod: 0,
    sharding: metadata?.sharding,
    nBitsForLayerId,
  };
  const transform = metadata?.transform || mat4.create();
  return {
    source: getShardedMeshSource(chunkManager, parameters, credentialsProvider),
    transform,
    segmentPropertyMap,
  };
}

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
  const info = parseGrapheneMultiscaleVolumeInfo(metadata, url, options.credentialsManager);
  const volume = new GrapheneMultiscaleVolumeChunkSource(
      options.chunkManager, credentialsProvider, info);
  const state = new GrapheneState()
  if (options.state) {
    state.restoreState(options.state)
  }
  const segmentationGraph = new GrapheneGraphSource(info, credentialsProvider, volume, state);
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
          info.graph.nBitsForLayerId);
    const subsourceToModelSubspaceTransform = getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(subsourceToModelSubspaceTransform, subsourceToModelSubspaceTransform, transform);
    subsources.push({
      id: 'mesh',
      default: true,
      subsource: {mesh: meshSource},
      subsourceToModelSubspaceTransform,
    });
  }
  return {modelTransform: makeIdentityTransform(modelSpace), subsources, state};
}

export class GrapheneDataSource extends PrecomputedDataSource {
  get description() {
    return 'Graphene file-backed data source';
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
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
            case 'neuroglancer_multiscale_volume':
            case undefined:
              return await getVolumeDataSource(options, credentialsProvider, url, metadata);
            default:
              throw new Error(`Invalid type: ${JSON.stringify(t)}`);
          }
        });
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

function makeColoredAnnotationState(
    layer: SegmentationUserLayer, loadedSubsource: LoadedDataSubsource,
    subsubsourceId: string, color: vec3) {
  const {subsourceEntry} = loadedSubsource;
  const source = new LocalAnnotationSource(loadedSubsource.loadedDataSource.transform, [], []);
  
  const displayState = new AnnotationDisplayState();
  displayState.color.value.set(color);

  const state = new AnnotationLayerState({
      localPosition: layer.localPosition,
      transform: loadedSubsource.getRenderLayerTransform(),
      source,
      displayState,
      dataSource: loadedSubsource.loadedDataSource.layerDataSource,
      subsourceIndex: loadedSubsource.subsourceIndex,
      subsourceId: subsourceEntry.id,
      subsubsourceId,
      role: RenderLayerRole.ANNOTATION,
    });
  layer.addAnnotationLayerState(state, loadedSubsource);
  return state;
}

function restoreSegmentSelection(obj: any): SegmentSelection {
  function getUint64(key: string) {
    return verifyObjectProperty(obj, key, value => Uint64.parseString(String(value)));
  }
  const segmentId = getUint64(SEGMENT_ID_JSON_KEY);
  const rootId = getUint64(ROOT_ID_JSON_KEY);
  const position = verifyObjectProperty(
    obj, POSITION_JSON_KEY, value => {
      return verify3dVec(value);
    });
    return {
      segmentId,
      rootId,
      position,
    }
}

const MULTICUT_JSON_KEY = "multicut";
const FOCUS_SEGMENT_JSON_KEY = "focusSegment";
const SINKS_JSON_KEY = "sinks";
const SOURCES_JSON_KEY = "sources";

const SEGMENT_ID_JSON_KEY = "segmentId";
const ROOT_ID_JSON_KEY = "rootId";
const POSITION_JSON_KEY = "position";

class GrapheneState implements Trackable {
  changed = new NullarySignal();

  public multicutState = new MulticutState();

  constructor() {
    this.multicutState.changed.add(() => {
      this.changed.dispatch();
    });
  }

  reset() {
    this.multicutState.reset();
  }

  toJSON() {
    return {
      [MULTICUT_JSON_KEY]: this.multicutState.toJSON(),
    }
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, MULTICUT_JSON_KEY, value => {
      this.multicutState.restoreState(value);
    });
  }
}

export interface SegmentSelection {
  segmentId: Uint64;
  rootId: Uint64;
  position: Float32Array;
  annotationReference?: AnnotationReference;
}

class MulticutState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  sinks = new WatchableSet<SegmentSelection>();
  sources = new WatchableSet<SegmentSelection>();

  constructor(
      public focusSegment = new TrackableValue<Uint64|undefined>(undefined, x => x),
      public blueGroup = new WatchableValue<boolean>(false)) {
    super();

    const maybeResetFocusSegemnt = () => {
      if (this.sinks.size === 0 && this.sources.size === 0) {
        this.focusSegment.value = undefined;
      }
    };

    this.registerDisposer(focusSegment.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sinks.changed.add(maybeResetFocusSegemnt));
    this.registerDisposer(this.sources.changed.add(maybeResetFocusSegemnt));

    this.registerDisposer(this.blueGroup.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sinks.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sources.changed.add(this.changed.dispatch));
  }

  reset() {
    this.focusSegment.value = undefined;
    this.blueGroup.value = false;
    this.sinks.clear();
    this.sources.clear();
  }

  toJSON() {
    const {focusSegment, sinks, sources} = this;

    const segmentSelectionToJSON = (x: SegmentSelection) => {
      return {
        [SEGMENT_ID_JSON_KEY]: x.segmentId.toJSON(),
        [ROOT_ID_JSON_KEY]: x.rootId.toJSON(),
        [POSITION_JSON_KEY]: [...x.position],
      }
    }

    return {
      [FOCUS_SEGMENT_JSON_KEY]: focusSegment.toJSON(),
      [SINKS_JSON_KEY]: [...sinks].map(segmentSelectionToJSON),
      [SOURCES_JSON_KEY]: [...sources].map(segmentSelectionToJSON),
    };
  }

  restoreState(x: any) {
    const segmentSelectionsValidator = (value: any) => {
      return parseArray(value, x => {
        return restoreSegmentSelection(x);
      });
    };

    verifyOptionalObjectProperty(
        x, FOCUS_SEGMENT_JSON_KEY, value => {
          this.focusSegment.restoreState(Uint64.parseString(String(value)));
        });
    const sinks = verifyObjectProperty(x, SINKS_JSON_KEY, segmentSelectionsValidator);
    const sources = verifyObjectProperty(x, SOURCES_JSON_KEY, segmentSelectionsValidator);

    for (const sink of sinks) {
      this.sinks.add(sink);
    }

    for (const source of sources) {
      this.sources.add(source);
    }
  }

  swapGroup() {
    this.blueGroup.value = !this.blueGroup.value;
  }

  get activeGroup() {
    return this.blueGroup.value ? this.sources : this.sinks;
  }

  // following three functions are used to render multicut supervoxels in 2d (color them red/blue)
  get segments() {
    return [...this.redSegments, ...this.blueSegments];
  }

  get redSegments() {
    return [...this.sinks].filter(x => !Uint64.equal(x.segmentId, x.rootId)).map(x => x.segmentId);
  }

  get blueSegments() {
    return [...this.sources].filter(x => !Uint64.equal(x.segmentId, x.rootId)).map(x => x.segmentId);
  }
}

class GraphConnection extends SegmentationGraphSourceConnection {
  public annotationLayerStates: AnnotationLayerState[] = [];

  constructor(
      public graph: GrapheneGraphSource,
      layer: SegmentationUserLayer,
      private chunkSource: GrapheneMultiscaleVolumeChunkSource,
      public state: GrapheneState) {
    super(graph, layer.displayState.segmentationGroupState.value);
    const segmentsState = layer.displayState.segmentationGroupState.value;
    segmentsState.visibleSegments.changed.add((segmentIds: Uint64[]|Uint64|null, add: boolean) => {
      if (segmentIds !== null) {
        segmentIds = Array<Uint64>().concat(segmentIds);
      }
      this.visibleSegmentsChanged(segmentIds, add);
    });

    const {annotationLayerStates, state: {multicutState}} = this;
    const loadedSubsource = getGraphLoadedSubsource(layer)!;
    const redGroup = makeColoredAnnotationState(layer, loadedSubsource, "sinks", RED_COLOR);
    const blueGroup = makeColoredAnnotationState(layer, loadedSubsource, "sources", BLUE_COLOR);
    synchronizeAnnotationSource(multicutState.sinks, redGroup);
    synchronizeAnnotationSource(multicutState.sources, blueGroup)
    annotationLayerStates.push(redGroup, blueGroup);
  }

  createRenderLayers(
      chunkManager: ChunkManager,
      displayState: SegmentationDisplayState3D,
      localPosition: WatchableValueInterface<Float32Array>): RenderLayer[] {
    return [new SliceViewPanelChunkedGraphLayer(
      chunkManager,
      this.chunkSource.getChunkedGraphSource(),
      displayState, // FIXME will displayState always match this.segmentsState?
      localPosition,
      this.graph.info.graph.nBitsForLayerId,
    )];
  };

  private lastDeselectionMessage: StatusMessage|undefined;
  private lastDeselectionMessageExists = false;

  private visibleSegmentsChanged(segments: Uint64[]|null, added: boolean) {
    const {segmentsState} = this;

    if (segments === null) {
      const leafSegmentCount = this.segmentsState.visibleSegments.size;
      this.segmentsState.segmentEquivalences.clear();
      StatusMessage.showTemporaryMessage(`Deselected all ${leafSegmentCount} segments.`, 3000);
      return;
    }

    for (const segmentId of segments) {
      const isBaseSegment = isBaseSegmentId(segmentId, this.graph.info.graph.nBitsForLayerId);

      const segmentConst = segmentId.clone();

      if (added) {
        if (isBaseSegment) {
          this.graph.getRoot(segmentConst).then(rootId => {
            segmentsState.visibleSegments.delete(segmentConst);
            segmentsState.visibleSegments.add(rootId);
          });
        }
      } else if (!isBaseSegment) {
        const {focusSegment: {value: focusSegment}} = this.graph.state.multicutState;
        if (focusSegment && Uint64.equal(segmentId, focusSegment)) {
          segmentsState.visibleSegments.add(segmentId);
          StatusMessage.showTemporaryMessage(`Can't deselect active multicut segment.`, 3000);
          return;
        }

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
    include;
    exclude;
    return undefined;
  }

  async submitMulticut(annotationToNanometers: Float64Array): Promise<boolean> {
    const {state: {multicutState}} = this;
    const {sinks, sources} = multicutState;
    if (sinks.size === 0 || sources.size === 0) {
      StatusMessage.showTemporaryMessage('Must select both red and blue groups to perform a multi-cut.', 7000);
      return false;
    } else {
      const splitRoots = await this.graph.graphServer.splitSegments([...sinks], [...sources], annotationToNanometers);
      if (splitRoots.length === 0) {
        StatusMessage.showTemporaryMessage(`No split found.`, 3000);
        return false;
      } else {
        const focusSegment = multicutState.focusSegment.value!;
        multicutState.reset(); // need to clear the focus segment before deleting the multicut segment
        const {segmentsState} = this;
        segmentsState.visibleSegments.delete(focusSegment);
        segmentsState.visibleSegments.add(splitRoots);
        return true;
      }
    }
  }
}

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

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

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

  async mergeSegments(first: SegmentSelection, second: SegmentSelection, annotationToNanometers: Float64Array): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = cancellableFetchSpecialOk(this.credentialsProvider, `${url}/merge?int64_as_str=1`, {
      method: 'POST',
      body: JSON.stringify([
        [String(first.segmentId), ...first.position.map((val, i) => val * annotationToNanometers[i])],
        [String(second.segmentId), ...second.position.map((val, i) => val * annotationToNanometers[i])]
      ])
    }, responseIdentity);

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Merging ${first.segmentId} and ${second.segmentId}`,
      errorPrefix: 'Merge failed: '
    });
    const jsonResp = await response.json();
    return Uint64.parseString(jsonResp['new_root_ids'][0]);
  }

  async splitSegments(first: SegmentSelection[], second: SegmentSelection[], annotationToNanometers: Float64Array): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = cancellableFetchSpecialOk(this.credentialsProvider, `${url}/split?int64_as_str=1`, {
      method: 'POST',
      body: JSON.stringify({
        'sources': first.map(x => [String(x.segmentId), ...x.position.map((val, i) => val * annotationToNanometers[i])]),
        'sinks': second.map(x => [String(x.segmentId), ...x.position.map((val, i) => val * annotationToNanometers[i])])
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
}

class GrapheneGraphSource extends SegmentationGraphSource {
  private connections = new Set<GraphConnection>();
  public graphServer: GrapheneGraphServerInterface;

  constructor(public info: GrapheneMultiscaleVolumeInfo,
              credentialsProvider: SpecialProtocolCredentialsProvider,
              private chunkSource: GrapheneMultiscaleVolumeChunkSource,
              public state: GrapheneState) {
    super();
    this.graphServer = new GrapheneGraphServerInterface(info.app!.segmentationUrl, credentialsProvider);
  }

  connect(layer: SegmentationUserLayer): Owned<SegmentationGraphSourceConnection> {
    const connection = new GraphConnection(this, layer, this.chunkSource, this.state);
  
    this.connections.add(connection);
    connection.registerDisposer(() => {
      this.connections.delete(connection);
    });

    return connection;
  }

  get visibleSegmentEquivalencePolicy() {
    return VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE |
           VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED;
  }

  getRoot(segment: Uint64) {
    return this.graphServer.getRoot(segment);
  }

  tabContents(layer: SegmentationUserLayer, context: DependentViewContext, tab: SegmentationGraphSourceTab) {
    const parent = document.createElement('div');
    parent.style.display = 'contents';
    const toolbox = document.createElement('div');
    toolbox.className = 'neuroglancer-segmentation-toolbox';
    toolbox.appendChild(makeToolButton(context, layer, {
      toolJson: GRAPHENE_MULTICUT_SEGMENTS_TOOL_ID,
      label: 'Multicut',
      title: 'Multicut segments'
    }));
    toolbox.appendChild(makeToolButton(context, layer, {
      toolJson: GRAPHENE_MERGE_SEGMENTS_TOOL_ID,
      label: 'Merge',
      title: 'Merge segments'
    }));
    parent.appendChild(toolbox);
    parent.appendChild(
      context.registerDisposer(new MulticutAnnotationLayerView(layer, layer.annotationDisplayState))
        .element
    );
    const tabElement = tab.element;
    tabElement.classList.add('neuroglancer-annotations-tab');
    tabElement.classList.add('neuroglancer-graphene-tab');
    return parent;
  }


  // following not used

  async merge(a: Uint64, b: Uint64): Promise<Uint64> {
    a;
    b;
    return  new Uint64();
  }

  async split(include: Uint64, exclude: Uint64): Promise<{include: Uint64, exclude: Uint64}> {
    return {include, exclude};
  }

  trackSegment(id: Uint64, callback: (id: Uint64|null) => void): () => void {
    return () => {
      console.log('trackSegment... do nothing', id, callback);
    }
  }
}

class ChunkedGraphChunkSource extends SliceViewChunkSource implements
    ChunkedGraphChunkSourceInterface {
  spec: ChunkedGraphChunkSpecification;
  OPTIONS: {spec: ChunkedGraphChunkSpecification};

  constructor(chunkManager: ChunkManager, options: {
    spec: ChunkedGraphChunkSpecification,
  }) {
    super(chunkManager, options);
  }
}

class GrapheneChunkedGraphChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(ChunkedGraphChunkSource), ChunkedGraphSourceParameters)) {}

interface ChunkedGraphLayerDisplayState extends SegmentationDisplayState3D {}

interface TransformedChunkedGraphSource extends
    FrontendTransformedSource<SliceViewRenderLayer, ChunkedGraphChunkSource> {}

interface AttachmentState {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  source?: NestedStateManager<TransformedChunkedGraphSource>;
}

class SliceViewPanelChunkedGraphLayer extends SliceViewPanelRenderLayer {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  private sharedObject: SegmentationLayerSharedObject;
  readonly chunkTransform: WatchableValueInterface<ValueOrError<ChunkTransformParameters>>;

  private leafRequestsActive: SharedWatchableValue<boolean>;
  private leafRequestsStatusMessage: StatusMessage|undefined;

  constructor(public chunkManager: ChunkManager, public source: SliceViewSingleResolutionSource<ChunkedGraphChunkSource>,
      public displayState: ChunkedGraphLayerDisplayState,
      public localPosition: WatchableValueInterface<Float32Array>,
      nBitsForLayerId: number) {
    super();
    this.leafRequestsActive = this.registerDisposer(SharedWatchableValue.make(chunkManager.rpc!, true));
    this.chunkTransform = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
        modelTransform =>
            makeValueOrError(() => getChunkTransformParameters(valueOrThrow(modelTransform))),
        this.displayState.transform));
    let sharedObject = this.sharedObject = this.backend = this.registerDisposer(
        new SegmentationLayerSharedObject(chunkManager, displayState, this.layerChunkProgressInfo));
    sharedObject.RPC_TYPE_ID = CHUNKED_GRAPH_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      source: source.chunkSource.addCounterpartRef(),
      localPosition: this.registerDisposer(SharedWatchableValue.makeFromExisting(chunkManager.rpc!, this.localPosition))
                         .rpcId,
      leafRequestsActive: this.leafRequestsActive.rpcId,
      nBitsForLayerId: this.registerDisposer(SharedWatchableValue.make(chunkManager.rpc!, nBitsForLayerId)).rpcId,
    });
    this.registerDisposer(sharedObject.visibility.add(this.visibility));

    this.registerDisposer(this.leafRequestsActive.changed.add(() => {
      this.showOrHideMessage(this.leafRequestsActive.value);
    }));
  }

  attach(attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
    super.attach(attachment);
    const chunkTransform = this.chunkTransform.value;
    const displayDimensionRenderInfo = attachment.view.displayDimensionRenderInfo.value;
    attachment.state = {
      chunkTransform,
      displayDimensionRenderInfo,
    };
    attachment.state!.source = attachment.registerDisposer(registerNested(
        (context: RefCounted, transform: RenderLayerTransformOrError,
         displayDimensionRenderInfo: DisplayDimensionRenderInfo) => {
          const transformedSources =
              getVolumetricTransformedSources(
                  displayDimensionRenderInfo, transform,
                  _options =>
                      [[this.source]],
                  attachment.messages, this) as TransformedChunkedGraphSource[][];
          attachment.view.flushBackendProjectionParameters();
          this.sharedObject.rpc!.invoke(CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, {
            layer: this.sharedObject.rpcId,
            view: attachment.view.rpcId,
            displayDimensionRenderInfo,
            sources: serializeAllTransformedSources(transformedSources),
          });
          context;
          return transformedSources[0][0];
        },
        this.displayState.transform, attachment.view.displayDimensionRenderInfo));
  }

  isReady() {
    return true;
  }

  private showOrHideMessage(leafRequestsActive: boolean) {
    if (this.leafRequestsStatusMessage && leafRequestsActive) {
      this.leafRequestsStatusMessage.dispose();
      this.leafRequestsStatusMessage = undefined;
      StatusMessage.showTemporaryMessage('Loading chunked graph segmentation...', 3000);
    } else if ((!this.leafRequestsStatusMessage) && (!leafRequestsActive)) {
      this.leafRequestsStatusMessage = StatusMessage.showMessage(
          'At this zoom level, chunked graph segmentation will not be loaded. Please zoom in if you wish to load it.');
    }
  }
}

const GRAPHENE_MULTICUT_SEGMENTS_TOOL_ID = 'grapheneMulticutSegments';
const GRAPHENE_MERGE_SEGMENTS_TOOL_ID = 'grapheneMergeSegments';

class MulticutAnnotationLayerView extends AnnotationLayerView {
  private _annotationStates: MergedAnnotationStates;

  constructor(
      public layer: SegmentationUserLayer,
      public displayState: AnnotationDisplayState) {
    super(layer, displayState);

    const {graphConnection: {value: graphConnection}} = layer;
    if (graphConnection instanceof GraphConnection) {
      for (const state of graphConnection.annotationLayerStates) {
        this.annotationStates.add(state);
      }
    }
  }

  get annotationStates() {
    if (this._annotationStates === undefined) {
      this._annotationStates = this.registerDisposer(new MergedAnnotationStates());
    }
    return this._annotationStates;
  }
}

const synchronizeAnnotationSource = (source: WatchableSet<SegmentSelection>, state: AnnotationLayerState) => {
  const annotationSource = state.source;

  annotationSource.childDeleted.add(annotationId => {
    const selection = [...source].find(selection => selection.annotationReference?.id === annotationId)
    if (selection) source.delete(selection); 
  });

  const addSelection = (selection: SegmentSelection) => {
    const annotation: Point = {
      id: '',
      point: selection.position,
      type: AnnotationType.POINT,
      properties: [],
      relatedSegments: [[selection.segmentId, selection.rootId]],
    };
    const ref = annotationSource.add(annotation);
    selection.annotationReference = ref;
  }

  source.changed.add((x, add) => {
    if (x === null) {
      for (const annotation of annotationSource) {
        // using .clear does not remove annotations from the list
        // (this.blueGroupAnnotationState.source as LocalAnnotationSource).clear();
        annotationSource.delete(annotationSource.getReference(annotation.id));
      }
      return;
    }

    if (add) {
      addSelection(x);
    } else if (x.annotationReference) {
      annotationSource.delete(x.annotationReference);
    }
  });

  // load initial state
  for (const selection of source) {
    addSelection(selection);
  }
}

function getMousePositionInLayerCoordinates(
    unsnappedPosition: Float32Array, layer: SegmentationUserLayer): Float32Array|
    undefined {
  const loadedSubsource = getGraphLoadedSubsource(layer)!;
  const modelTransform = loadedSubsource.getRenderLayerTransform();
  const chunkTransform = makeValueOrError(() => getChunkTransformParameters(valueOrThrow(modelTransform.value)));
  if (chunkTransform.error !== undefined) return undefined;
  const chunkPosition = new Float32Array(chunkTransform.modelTransform.unpaddedRank);
  if (!getChunkPositionFromCombinedGlobalLocalPositions(
          chunkPosition, unsnappedPosition, layer.localPosition.value,
          chunkTransform.layerRank, chunkTransform.combinedGlobalLocalToChunkTransform)) {
    return undefined;
  }
  return chunkPosition;
}

const getPoint = (layer: SegmentationUserLayer, mouseState: MouseSelectionState) => {
  if (mouseState.updateUnconditionally()) {
    return getMousePositionInLayerCoordinates(mouseState.unsnappedPosition, layer);
  }
  return undefined;
}

const MULTICUT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+control+mousedown0': {action: 'set-anchor'},
  'at:shift?+keys': {action: 'swap-group'},
});

class MulticutSegmentsTool extends Tool<SegmentationUserLayer> {
  toJSON() {
    return GRAPHENE_MULTICUT_SEGMENTS_TOOL_ID;
  }

  activate(activation: ToolActivation<this>) {
    const {layer} = this;
    const {graphConnection: {value: graphConnection}} = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection)) return;
    const {state: {multicutState}, segmentsState} = graphConnection;
    if (multicutState === undefined) return;

    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = 'Multicut segments';
    body.classList.add('graphene-multicut-status');
    body.appendChild(makeIcon({
      text: 'Swap',
      title: 'Swap group',
      onClick: () => {
        multicutState.swapGroup();
      }}));
    body.appendChild(makeIcon({
      text: 'Clear',
      title: 'Clear multicut',
      onClick: () => {
        multicutState.reset();
      }}));
    body.appendChild(makeIcon({
      text: 'Submit',
      title: 'Submit multicut',
      onClick: () => {
        const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
        const annotationToNanometers = loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(x => x / 1e-9);
        graphConnection.submitMulticut(annotationToNanometers).then(success => {
          if (success) {
            activation.cancel();
          }
        });
      }}));
    const activeGroupIndicator = document.createElement('div');
    activeGroupIndicator.className = 'activeGroupIndicator';
    activeGroupIndicator.innerHTML = 'Active Group: ';
    body.appendChild(activeGroupIndicator);

    const {displayState} = this.layer;
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = displayState.segmentationGroupState.value;
    const priorBaseSegmentHighlighting = displayState.baseSegmentHighlighting.value;
    const priorHighlightColor = displayState.highlightColor.value;


    activation.bindInputEventMap(MULTICUT_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      resetMulticutDisplay();
      displayState.baseSegmentHighlighting.value = priorBaseSegmentHighlighting;
      displayState.highlightColor.value = priorHighlightColor;
    });

    const resetMulticutDisplay = () => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
      displayState.useTempSegmentStatedColors2d.value = false;
      displayState.tempSegmentStatedColors2d.value.clear(); // TODO, should only clear those that are in temp sets
      displayState.tempSegmentDefaultColor2d.value = undefined;
      displayState.highlightColor.value = undefined;
    };

    const updateMulticutDisplay = () => {
      resetMulticutDisplay();
      activeGroupIndicator.classList.toggle('blueGroup', multicutState.blueGroup.value);

      const focusSegment = multicutState.focusSegment.value;
      if (focusSegment === undefined) return;

      displayState.baseSegmentHighlighting.value = true;
      displayState.highlightColor.value = multicutState.blueGroup.value ? BLUE_COLOR_HIGHTLIGHT : RED_COLOR_HIGHLIGHT;
      segmentsState.useTemporaryVisibleSegments.value = true;
      segmentsState.useTemporarySegmentEquivalences.value = true;

      // add to focus segments and temporary sets
      segmentsState.temporaryVisibleSegments.add(focusSegment);

      for (const segment of multicutState.segments) {
        segmentsState.temporaryVisibleSegments.add(segment);
      }

      // all other segments are added to the focus segment equivalences
      for (const equivalence of segmentsState.segmentEquivalences.setElements(focusSegment)) {
        if (!segmentsState.temporaryVisibleSegments.has(equivalence)) {
          segmentsState.temporarySegmentEquivalences.link(focusSegment, equivalence);
        }
      }

      // set colors
      displayState.tempSegmentDefaultColor2d.value = MULTICUT_OFF_COLOR;
      displayState.tempSegmentStatedColors2d.value.set(focusSegment, TRANSPARENT_COLOR_PACKED);

      for (const segment of multicutState.redSegments) {
        displayState.tempSegmentStatedColors2d.value.set(segment, RED_COLOR_SEGMENT_PACKED);
      }
      for (const segment of multicutState.blueSegments) {
        displayState.tempSegmentStatedColors2d.value.set(segment, BLUE_COLOR_SEGMENT_PACKED);
      }

      displayState.useTempSegmentStatedColors2d.value = true;
    };

    updateMulticutDisplay();

    activation.registerDisposer(multicutState.changed.add(updateMulticutDisplay));

    activation.bindAction('swap-group', event => {
      event.stopPropagation();
      multicutState.swapGroup();
    });

    activation.bindAction('set-anchor', event => {
      event.stopPropagation();
      const currentSegmentSelection = maybeGetSelection(this, segmentationGroupState.visibleSegments);
      if (!currentSegmentSelection) return;
      const {rootId, segmentId} = currentSegmentSelection;
      const {focusSegment, segments} = multicutState;
      if (focusSegment.value === undefined) {
        focusSegment.value = rootId.clone();
      }
      if (!Uint64.equal(focusSegment.value, rootId)) {
        StatusMessage.showTemporaryMessage(
            `The selected supervoxel has root segment ${
                rootId.toString()}, but the supervoxels already selected have root ${
                focusSegment.value.toString()}`,
            12000);
        return;
      }
      const isRoot = Uint64.equal(rootId, segmentId);
      if (!isRoot) {
        for (const segment of segments) {
          if (Uint64.equal(segment, segmentId)) {
            StatusMessage.showTemporaryMessage(
                `Supervoxel ${segmentId.toString()} has already been selected`, 7000);
            return;
          }
        }
      }
      multicutState.activeGroup.add(currentSegmentSelection);
    });
  }

  get description() {
    return `multicut`;
  }
}

const maybeGetSelection = (tool: Tool<SegmentationUserLayer>, visibleSegments: Uint64Set): SegmentSelection|undefined => {
  const {layer, mouseState} = tool;
  const {segmentSelectionState: {value, baseValue}} = layer.displayState;
  if (!baseValue || !value) return;
  if (!visibleSegments.has(value)) {
    StatusMessage.showTemporaryMessage('The selected supervoxel is of an unselected segment', 7000);
    return;
  }
  const point = getPoint(layer, mouseState);
  if (point === undefined) return;
  return {
    rootId: value.clone(),
    segmentId: baseValue.clone(),
    position: point,
  };
}

const MERGE_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'merge-segments'},
});

class MergeSegmentsTool extends Tool<SegmentationUserLayer> {
  lastAnchorSelection = new WatchableValue<SegmentSelection|undefined>(undefined);

  activate(activation: ToolActivation<this>) {
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = this.layer.displayState.segmentationGroupState.value;

    const {graph: {value: graph}} = segmentationGroupState;
    if (!(graph instanceof GrapheneGraphSource)) return;

    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = 'Merge segments';
    body.classList.add('graphene-merge-segments-status');

    const points = document.createElement('div');
    points.style.display = 'contents';
    body.appendChild(points);

    const makeWidget = (id: Uint64MapEntry) => {
      const row = makeSegmentWidget(this.layer.displayState, id);
      row.classList.add('neuroglancer-segment-list-entry-double-line');
      return row;
    };

    const setPoint = (id: Uint64, text: string) => {
      const containerEl =  document.createElement('div');
      containerEl.classList.add('graphene-merge-segments-point')
      const labelEl = document.createElement('span');
      labelEl.textContent = text;
      containerEl.appendChild(labelEl);
      const widget = makeWidget(augmentSegmentId(this.layer.displayState, id));
      containerEl.appendChild(widget);
      points.appendChild(containerEl);
    }

    const cancelBtn = makeIcon({
      text: 'Clear',
      title: 'Clear selection',
      onClick: () => {
        this.lastAnchorSelection.value = undefined;
        while (points.firstChild) {
          points.removeChild(points.firstChild);
        }
        body.removeChild(cancelBtn);
      }});

    const setSink = (id: Uint64) => {
      setPoint(id, "Sink: ");
      body.appendChild(cancelBtn);
    }

    const setSource = (id: Uint64) => {
      body.removeChild(cancelBtn);
      setPoint(id, "Source: ");
    }

    activation.bindInputEventMap(MERGE_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      this.lastAnchorSelection.value = undefined;
    });

    let activeSubmission = false;

    activation.bindAction('merge-segments', event => {
      event.stopPropagation();
      (async () => {
        const lastSegmentSelection = this.lastAnchorSelection.value;
        if (!lastSegmentSelection) { // first selection
          const selection = maybeGetSelection(this, segmentationGroupState.visibleSegments);
          if (selection) {
            this.lastAnchorSelection.value = selection;
            setSink(selection.rootId);
          }
        } else if (!activeSubmission) {
          const selection = maybeGetSelection(this, segmentationGroupState.visibleSegments);
          if (selection) {
            activeSubmission = true;
            setSource(selection.rootId);
            const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
            const annotationToNanometers = loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(x => x / 1e-9);
            const mergedRoot = await graph.graphServer.mergeSegments(lastSegmentSelection, selection, annotationToNanometers);
            const {visibleSegments} = segmentationGroupState;
            visibleSegments.delete(lastSegmentSelection.rootId);
            visibleSegments.delete(selection.rootId);
            visibleSegments.add(mergedRoot);
            this.lastAnchorSelection.value = undefined;
            activation.cancel();
          }
        }
      })()
    });
  }

  toJSON() {
    return GRAPHENE_MERGE_SEGMENTS_TOOL_ID;
  }

  get description() {
    return `merge segments`;
  }
}

registerLayerTool(SegmentationUserLayer, GRAPHENE_MULTICUT_SEGMENTS_TOOL_ID, layer => {
  return new MulticutSegmentsTool(layer, true);
});

registerLayerTool(SegmentationUserLayer, GRAPHENE_MERGE_SEGMENTS_TOOL_ID, layer => {
  return new MergeSegmentsTool(layer, true);
});
