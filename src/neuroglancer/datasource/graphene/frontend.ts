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
import {makeIdentityTransform} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {DataSource, DataSubsourceEntry, GetDataSourceOptions, RedirectError} from 'neuroglancer/datasource';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {Owned} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {HttpError, isNotFoundError, responseJson} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString, verifyNonnegativeInt} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {getGrapheneFragmentKey, isBaseSegmentId, responseIdentity} from 'neuroglancer/datasource/graphene/base';
import {ChunkedGraphSourceParameters, MeshSourceParameters, MultiscaleMeshMetadata, PYCG_APP_VERSION} from 'neuroglancer/datasource/graphene/base';
import {DataEncoding, ShardingHashFunction, ShardingParameters} from 'neuroglancer/datasource/precomputed/base';
import {ChunkedGraphChunkSource, ChunkedGraphLayer} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {StatusMessage} from 'neuroglancer/status';
import { makeChunkedGraphChunkSpecification } from 'neuroglancer/sliceview/chunked_graph/base';
import { Uint64Set } from 'neuroglancer/uint64_set';
import { ComputedSplit, SegmentationGraphSource, SegmentationGraphSourceConnection, VISIBLE_SEGMENT_TYPE } from 'neuroglancer/segmentation_graph/source';
import { VisibleSegmentsState } from 'neuroglancer/segmentation_display_state/base';
import { WatchableValueInterface } from 'neuroglancer/trackable_value';
import { RenderLayerTransformOrError } from 'neuroglancer/render_coordinate_transform';
import { RenderLayer } from 'neuroglancer/renderlayer';
import { getSegmentPropertyMap, MultiscaleVolumeInfo, parseMultiscaleVolumeInfo, parseProviderUrl, PrecomputedDataSource, PrecomputedMultiscaleVolumeChunkSource } from 'neuroglancer/datasource/precomputed/frontend';

class GrapheneChunkedGraphChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(ChunkedGraphChunkSource), ChunkedGraphSourceParameters)) {}

class GrapheneMeshSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(MeshSource), MeshSourceParameters)) {
  getFragmentKey(objectKey: string|null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
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

interface GrapheneMultiscaleVolumeInfo extends MultiscaleVolumeInfo {
  dataUrl: string;
  app?: AppInfo;
  graph?: GraphInfo;
}

function parseSpecialUrlOld(url: string): string { // TODO: brought back old parseSpecialUrl
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

function parseGrapheneMultiscaleVolumeInfo(obj: unknown, url: string): GrapheneMultiscaleVolumeInfo {
  const volumeInfo = parseMultiscaleVolumeInfo(obj);
  let dataUrl = url;
  let app = undefined;
  let graph = undefined;

  if (volumeInfo.volumeType !== VolumeType.IMAGE) {
    dataUrl = verifyObjectProperty(obj, 'data_dir', x => parseSpecialUrlOld(x));
    app = verifyObjectProperty(obj, 'app', x => new AppInfo(url, x));
    graph = verifyObjectProperty(obj, 'graph', x => new GraphInfo(x));
  }

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

  getChunkedGraphSources(rootSegments: Uint64Set) {
    const {rank} = this;
    const scaleInfo = this.info.scales[0];

    const spec = makeChunkedGraphChunkSpecification({
      rank,
      dataType: this.info.dataType,
      upperVoxelBound: scaleInfo.size,
      chunkDataSize: Uint32Array.from(this.info.graph!.chunkSize),
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
    return [[
      {
        chunkSource: this.chunkManager.getChunkSource(GrapheneChunkedGraphChunkSource, {
          spec,
          credentialsProvider: this.chunkedGraphCredentialsProvider,
          rootSegments,
          parameters: {url: `${this.info.app!.segmentationUrl}/node`}}),
        chunkToMultiscaleTransform,
        lowerClipBound,
        upperClipBound,
      }
    ]];
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

function getShardedMeshSource(chunkManager: ChunkManager, parameters: MeshSourceParameters, credentialsProvider: SpecialProtocolCredentialsProvider) {
  return chunkManager.getChunkSource(GrapheneMeshSource, {parameters, credentialsProvider});
}

async function getMeshSource(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, fragmentUrl: string) {
  const {metadata, segmentPropertyMap} =
      await getMeshMetadata(chunkManager, credentialsProvider, fragmentUrl);
  if (metadata === undefined) {
    return {
      source: getLegacyMeshSource(chunkManager, credentialsProvider, {
        manifestUrl: url,
        fragmentUrl: fragmentUrl,
        lod: 0,
        sharding: undefined,
      }),
      transform: mat4.create(),
      segmentPropertyMap
    };
  }
  return {
    source: getShardedMeshSource(chunkManager, {
      manifestUrl: url,
      fragmentUrl: fragmentUrl,
      lod: 0,
      sharding: metadata.sharding,
    }, credentialsProvider),
    transform: metadata.transform,
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
  const info = parseGrapheneMultiscaleVolumeInfo(metadata, url);
  const volume = new GrapheneMultiscaleVolumeChunkSource(
      options.chunkManager, credentialsProvider, info);

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
          resolvePath(info.dataUrl, info.mesh));
    const subsourceToModelSubspaceTransform = getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(subsourceToModelSubspaceTransform, subsourceToModelSubspaceTransform, transform);
    subsources.push({
      id: 'mesh',
      default: true,
      subsource: {mesh: meshSource},
      subsourceToModelSubspaceTransform,
    });
  }
  return {modelTransform: makeIdentityTransform(modelSpace), subsources};
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

class GraphConnection extends SegmentationGraphSourceConnection {
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
    const {segmentsState} = this;

    if (segments === null) {
      const leafSegmentCount = this.segmentsState.visibleSegments.size;
      this.segmentsState.segmentEquivalences.clear();
      StatusMessage.showTemporaryMessage(`Deselected all ${leafSegmentCount} segments.`, 3000);
      return;
    }

    for (const segmentId of segments) {
      const isBaseSegment = isBaseSegmentId(segmentId, this.graph.info.graph!.nBitsForLayerId);

      const segmentConst = segmentId.clone();

      if (added) {
        if (isBaseSegment) {
          this.graph.getRoot(segmentConst).then(rootId => {
            if (segmentConst === rootId) {
              console.error('when does this happen?');
            }
            segmentsState.visibleSegments.delete(segmentConst);
            segmentsState.visibleSegments.add(rootId);
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
    include;
    exclude;
    return undefined;
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
}

class GrapheneGraphSource extends SegmentationGraphSource {
  private connections = new Set<GraphConnection>();
  public graphServer: GrapheneGraphServerInterface;

  constructor(public info: GrapheneMultiscaleVolumeInfo,
              credentialsProvider: SpecialProtocolCredentialsProvider,
              private chunkSource: GrapheneMultiscaleVolumeChunkSource) {
    super();
    this.graphServer = new GrapheneGraphServerInterface(info.app!.segmentationUrl, credentialsProvider);
  }

  connect(segmentsState: VisibleSegmentsState, transform: WatchableValueInterface<RenderLayerTransformOrError>): Owned<SegmentationGraphSourceConnection> {
    const connection = new GraphConnection(this, segmentsState, transform, this.chunkSource);
  
    this.connections.add(connection);
    connection.registerDisposer(() => {
      this.connections.delete(connection);
    });

    return connection;
  }

  get highBitRepresentative() {
    return VISIBLE_SEGMENT_TYPE.HIGH_BIT_REPRESENTATIVE_ONLY;
  }

  getRoot(segment: Uint64) {
    return this.graphServer.getRoot(segment);
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
