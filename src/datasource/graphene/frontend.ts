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

import "#src/datasource/graphene/graphene.css";
import {
  AnnotationDisplayState,
  AnnotationLayerState,
} from "#src/annotation/annotation_layer_state.js";
import type { MultiscaleAnnotationSource } from "#src/annotation/frontend_source.js";
import type {
  Annotation,
  AnnotationReference,
  AnnotationSource,
  Line,
  Point,
} from "#src/annotation/index.js";
import {
  AnnotationType,
  LocalAnnotationSource,
  makeDataBoundsBoundingBoxAnnotationSet,
} from "#src/annotation/index.js";
import { LayerChunkProgressInfo } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import { makeIdentityTransform } from "#src/coordinate_transform.js";
import { WithCredentialsProvider } from "#src/credentials_provider/chunk_source_frontend.js";
import type { CredentialsManager } from "#src/credentials_provider/index.js";
import type {
  ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface,
  ChunkedGraphChunkSpecification,
  MultiscaleMeshMetadata,
} from "#src/datasource/graphene/base.js";
import {
  CHUNKED_GRAPH_LAYER_RPC_ID,
  CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  ChunkedGraphSourceParameters,
  getGrapheneFragmentKey,
  GRAPHENE_MESH_NEW_SEGMENT_RPC_ID,
  isBaseSegmentId,
  makeChunkedGraphChunkSpecification,
  MeshSourceParameters,
  PYCG_APP_VERSION,
  responseIdentity,
} from "#src/datasource/graphene/base.js";
import type {
  DataSource,
  DataSubsourceEntry,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import { RedirectError } from "#src/datasource/index.js";
import type { ShardingParameters } from "#src/datasource/precomputed/base.js";
import {
  DataEncoding,
  ShardingHashFunction,
} from "#src/datasource/precomputed/base.js";
import type { MultiscaleVolumeInfo } from "#src/datasource/precomputed/frontend.js";
import {
  getSegmentPropertyMap,
  parseMultiscaleVolumeInfo,
  parseProviderUrl,
  PrecomputedDataSource,
  PrecomputedMultiscaleVolumeChunkSource,
  resolvePath,
} from "#src/datasource/precomputed/frontend.js";
import type {
  LayerView,
  MouseSelectionState,
  VisibleLayerInfo,
} from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { MeshSource } from "#src/mesh/frontend.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import {
  getChunkPositionFromCombinedGlobalLocalPositions,
  getChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
import type { RenderLayer } from "#src/renderlayer.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import type {
  SegmentationDisplayState3D,
  Uint64MapEntry,
} from "#src/segmentation_display_state/frontend.js";
import {
  augmentSegmentId,
  resetTemporaryVisibleSegmentsState,
  SegmentationLayerSharedObject,
  SegmentWidgetFactory,
} from "#src/segmentation_display_state/frontend.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type {
  ComputedSplit,
  SegmentationGraphSourceTab,
} from "#src/segmentation_graph/source.js";
import {
  SegmentationGraphSource,
  SegmentationGraphSourceConnection,
} from "#src/segmentation_graph/source.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type {
  FrontendTransformedSource,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import {
  getVolumetricTransformedSources,
  serializeAllTransformedSources,
  SliceViewChunkSource,
} from "#src/sliceview/frontend.js";
import type { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import { StatusMessage } from "#src/status.js";
import {
  TrackableBoolean,
  TrackableBooleanCheckbox,
} from "#src/trackable_boolean.js";
import type {
  NestedStateManager,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import {
  makeCachedLazyDerivedWatchableValue,
  registerNested,
  TrackableValue,
  WatchableSet,
  WatchableValue,
} from "#src/trackable_value.js";
import {
  AnnotationLayerView,
  MergedAnnotationStates,
  PlaceLineTool,
  makeAnnotationListElement,
} from "#src/ui/annotations.js";
import { getDefaultAnnotationListBindings } from "#src/ui/default_input_event_bindings.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  makeToolButton,
  registerLegacyTool,
  registerTool,
} from "#src/ui/tool.js";
import { Uint64Set } from "#src/uint64_set.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import { CancellationTokenSource } from "#src/util/cancellation.js";
import { packColor } from "#src/util/color.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import type { ValueOrError } from "#src/util/error.js";
import { makeValueOrError, valueOrThrow } from "#src/util/error.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { mat4, vec3, vec4 } from "#src/util/geom.js";
import {
  HttpError,
  isNotFoundError,
  responseJson,
} from "#src/util/http_request.js";
import {
  parseArray,
  parseFixedLengthArray,
  verify3dVec,
  verifyBoolean,
  verifyEnumString,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyFloatArray,
  verifyInt,
  verifyIntegerArray,
  verifyNonnegativeInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyOptionalString,
  verifyPositiveInt,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import { getObjectId } from "#src/util/object_id.js";
import { NullarySignal } from "#src/util/signal.js";
import type {
  SpecialProtocolCredentials,
  SpecialProtocolCredentialsProvider,
} from "#src/util/special_protocol_request.js";
import {
  cancellableFetchSpecialOk,
  parseSpecialUrl,
} from "#src/util/special_protocol_request.js";
import type { Trackable } from "#src/util/trackable.js";
import { Uint64 } from "#src/util/uint64.js";
import { makeDeleteButton } from "#src/widget/delete_button.js";
import type { DependentViewContext } from "#src/widget/dependent_view_widget.js";
import { makeIcon } from "#src/widget/icon.js";

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
const WHITE_COLOR = vec3.fromValues(1, 1, 1);

class GrapheneMeshSource extends WithParameters(
  WithCredentialsProvider<SpecialProtocolCredentials>()(MeshSource),
  MeshSourceParameters,
) {
  getFragmentKey(objectKey: string | null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
  }
}

class AppInfo {
  segmentationUrl: string;
  meshingUrl: string;
  l2CacheUrl: string;
  table: string;
  supported_api_versions: number[];
  constructor(infoUrl: string, obj: any) {
    // .../1.0/... is the legacy link style
    // .../table/... is the current, version agnostic link style (for retrieving the info file)
    const linkStyle =
      /^(https?:\/\/[.\w:\-/]+)\/segmentation\/(?:1\.0|table)\/([^/]+)\/?$/;
    const match = infoUrl.match(linkStyle);
    if (match === null) {
      throw Error(`Graph URL invalid: ${infoUrl}`);
    }
    this.table = match[2];
    const { table } = this;
    this.segmentationUrl = `${match[1]}/segmentation/api/v${PYCG_APP_VERSION}/table/${table}`;
    this.meshingUrl = `${match[1]}/meshing/api/v${PYCG_APP_VERSION}/table/${table}`;
    this.l2CacheUrl = `${match[1]}/l2cache/api/v${PYCG_APP_VERSION}`;

    try {
      verifyObject(obj);
      this.supported_api_versions = verifyObjectProperty(
        obj,
        "supported_api_versions",
        (x) => parseArray(x, verifyNonnegativeInt),
      );
    } catch (error) {
      // Dealing with a prehistoric graph server with no version information
      this.supported_api_versions = [0];
    }
    if (PYCG_APP_VERSION in this.supported_api_versions === false) {
      const redirectMsg = `This Neuroglancer branch requires Graph Server version ${PYCG_APP_VERSION}, but the server only supports version(s) ${this.supported_api_versions}.`;
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
    this.chunkSize = verifyObjectProperty(obj, "chunk_size", (x) =>
      parseFixedLengthArray(vec3.create(), x, verifyPositiveInt),
    );
    this.nBitsForLayerId = verifyOptionalObjectProperty(
      obj,
      "n_bits_for_layer_id",
      verifyPositiveInt,
      N_BITS_FOR_LAYER_ID_DEFAULT,
    );
  }
}

interface GrapheneMultiscaleVolumeInfo extends MultiscaleVolumeInfo {
  dataUrl: string;
  app: AppInfo;
  graph: GraphInfo;
}

function parseGrapheneMultiscaleVolumeInfo(
  obj: unknown,
  url: string,
  credentialsManager: CredentialsManager,
): GrapheneMultiscaleVolumeInfo {
  const volumeInfo = parseMultiscaleVolumeInfo(obj);
  const dataUrl = verifyObjectProperty(obj, "data_dir", (x) =>
    parseSpecialUrl(x, credentialsManager),
  ).url;
  const app = verifyObjectProperty(obj, "app", (x) => new AppInfo(url, x));
  const graph = verifyObjectProperty(obj, "graph", (x) => new GraphInfo(x));
  return {
    ...volumeInfo,
    app,
    graph,
    dataUrl,
  };
}

class GrapheneMultiscaleVolumeChunkSource extends PrecomputedMultiscaleVolumeChunkSource {
  constructor(
    chunkManager: ChunkManager,
    public chunkedGraphCredentialsProvider: SpecialProtocolCredentialsProvider,
    public info: GrapheneMultiscaleVolumeInfo,
  ) {
    super(chunkManager, undefined, info.dataUrl, info);
  }

  getChunkedGraphSource() {
    const { rank } = this;
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
    const { lowerBounds: baseLowerBound, upperBounds: baseUpperBound } =
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
      chunkSource: this.chunkManager.getChunkSource(
        GrapheneChunkedGraphChunkSource,
        {
          spec,
          credentialsProvider: this.chunkedGraphCredentialsProvider,
          parameters: { url: `${this.info.app!.segmentationUrl}/node` },
        },
      ),
      chunkToMultiscaleTransform,
      lowerClipBound,
      upperClipBound,
    };
  }
}

function parseTransform(data: any): mat4 {
  return verifyObjectProperty(data, "transform", (value) => {
    const transform = mat4.create();
    if (value !== undefined) {
      parseFixedLengthArray(
        transform.subarray(0, 12),
        value,
        verifyFiniteFloat,
      );
    }
    mat4.transpose(transform, transform);
    return transform;
  });
}

interface ParsedMeshMetadata {
  metadata: MultiscaleMeshMetadata | undefined;
  segmentPropertyMap?: string | undefined;
}

function parseMeshMetadata(data: any): ParsedMeshMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, "@type", verifyString);
  let metadata: MultiscaleMeshMetadata | undefined;
  if (t === "neuroglancer_legacy_mesh") {
    const sharding = verifyObjectProperty(
      data,
      "sharding",
      parseGrapheneShardingParameters,
    );
    if (sharding === undefined) {
      metadata = undefined;
    } else {
      const lodScaleMultiplier = 0;
      const vertexQuantizationBits = 10;
      const transform = parseTransform(data);
      metadata = {
        lodScaleMultiplier,
        transform,
        sharding,
        vertexQuantizationBits,
      };
    }
  } else if (t !== "neuroglancer_multilod_draco") {
    throw new Error(`Unsupported mesh type: ${JSON.stringify(t)}`);
  } else {
    const lodScaleMultiplier = verifyObjectProperty(
      data,
      "lod_scale_multiplier",
      verifyFinitePositiveFloat,
    );
    const vertexQuantizationBits = verifyObjectProperty(
      data,
      "vertex_quantization_bits",
      verifyPositiveInt,
    );
    const transform = parseTransform(data);
    const sharding = verifyObjectProperty(
      data,
      "sharding",
      parseGrapheneShardingParameters,
    );
    metadata = {
      lodScaleMultiplier,
      transform,
      sharding,
      vertexQuantizationBits,
    };
  }
  const segmentPropertyMap = verifyObjectProperty(
    data,
    "segment_properties",
    verifyOptionalString,
  );
  return { metadata, segmentPropertyMap };
}

async function getMeshMetadata(
  chunkManager: ChunkManager,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
): Promise<ParsedMeshMetadata> {
  let metadata: any;
  try {
    metadata = await getJsonMetadata(chunkManager, credentialsProvider, url);
  } catch (e) {
    if (isNotFoundError(e)) {
      // If we fail to fetch the info file, assume it is the legacy
      // single-resolution mesh format.
      return { metadata: undefined };
    }
    throw e;
  }
  return parseMeshMetadata(metadata);
}

function parseShardingEncoding(y: any): DataEncoding {
  if (y === undefined) return DataEncoding.RAW;
  return verifyEnumString(y, DataEncoding);
}

function parseShardingParameters(
  shardingData: any,
): ShardingParameters | undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  const t = verifyObjectProperty(shardingData, "@type", verifyString);
  if (t !== "neuroglancer_uint64_sharded_v1") {
    throw new Error(`Unsupported sharding format: ${JSON.stringify(t)}`);
  }
  const hash = verifyObjectProperty(shardingData, "hash", (y) =>
    verifyEnumString(y, ShardingHashFunction),
  );
  const preshiftBits = verifyObjectProperty(
    shardingData,
    "preshift_bits",
    verifyInt,
  );
  const shardBits = verifyObjectProperty(shardingData, "shard_bits", verifyInt);
  const minishardBits = verifyObjectProperty(
    shardingData,
    "minishard_bits",
    verifyInt,
  );
  const minishardIndexEncoding = verifyObjectProperty(
    shardingData,
    "minishard_index_encoding",
    parseShardingEncoding,
  );
  const dataEncoding = verifyObjectProperty(
    shardingData,
    "data_encoding",
    parseShardingEncoding,
  );
  return {
    hash,
    preshiftBits,
    shardBits,
    minishardBits,
    minishardIndexEncoding,
    dataEncoding,
  };
}

function parseGrapheneShardingParameters(
  shardingData: any,
): Array<ShardingParameters> | undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  const grapheneShardingParameters = new Array<ShardingParameters>();
  for (const layer in shardingData) {
    const index = Number(layer);
    grapheneShardingParameters[index] = parseShardingParameters(
      shardingData[index],
    )!;
  }
  return grapheneShardingParameters;
}

function getShardedMeshSource(
  chunkManager: ChunkManager,
  parameters: MeshSourceParameters,
  credentialsProvider: SpecialProtocolCredentialsProvider,
) {
  return chunkManager.getChunkSource(GrapheneMeshSource, {
    parameters,
    credentialsProvider,
  });
}

async function getMeshSource(
  chunkManager: ChunkManager,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  fragmentUrl: string,
  nBitsForLayerId: number,
) {
  const { metadata, segmentPropertyMap } = await getMeshMetadata(
    chunkManager,
    undefined,
    fragmentUrl,
  );
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
  chunkManager: ChunkManager,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
): Promise<any> {
  return chunkManager.memoize.getUncounted(
    {
      type: "graphene:metadata",
      url,
      credentialsProvider: getObjectId(credentialsProvider),
    },
    async () => {
      return await cancellableFetchSpecialOk(
        credentialsProvider,
        `${url}/info`,
        {},
        responseJson,
      );
    },
  );
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
  options: GetDataSourceOptions,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  metadata: any,
): Promise<DataSource> {
  const info = parseGrapheneMultiscaleVolumeInfo(
    metadata,
    url,
    options.credentialsManager,
  );
  const volume = new GrapheneMultiscaleVolumeChunkSource(
    options.chunkManager,
    credentialsProvider,
    info,
  );
  const state = new GrapheneState();
  if (options.state) {
    state.restoreState(options.state);
  }
  const segmentationGraph = new GrapheneGraphSource(
    info,
    credentialsProvider,
    volume,
    state,
  );
  const { modelSpace } = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: "default",
      default: true,
      subsource: { volume },
    },
    {
      id: "graph",
      default: true,
      subsource: { segmentationGraph },
    },
    {
      id: "bounds",
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(
          modelSpace.bounds,
        ),
      },
    },
  ];
  if (info.segmentPropertyMap !== undefined) {
    const mapUrl = resolvePath(url, info.segmentPropertyMap);
    const metadata = await getJsonMetadata(
      options.chunkManager,
      credentialsProvider,
      mapUrl,
    );
    const segmentPropertyMap = getSegmentPropertyMap(
      options.chunkManager,
      credentialsProvider,
      metadata,
      mapUrl,
    );
    subsources.push({
      id: "properties",
      default: true,
      subsource: { segmentPropertyMap },
    });
  }
  if (info.mesh !== undefined) {
    const { source: meshSource, transform } = await getMeshSource(
      options.chunkManager,
      credentialsProvider,
      info.app!.meshingUrl,
      resolvePath(info.dataUrl, info.mesh),
      info.graph.nBitsForLayerId,
    );
    const subsourceToModelSubspaceTransform =
      getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(
      subsourceToModelSubspaceTransform,
      subsourceToModelSubspaceTransform,
      transform,
    );
    subsources.push({
      id: "mesh",
      default: true,
      subsource: { mesh: meshSource },
      subsourceToModelSubspaceTransform,
    });
  }
  return {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources,
    state,
  };
}

export class GrapheneDataSource extends PrecomputedDataSource {
  get description() {
    return "Graphene file-backed data source";
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const { url: providerUrl, parameters } = parseProviderUrl(
      options.providerUrl,
    );
    return options.chunkManager.memoize.getUncounted(
      { type: "graphene:get", providerUrl, parameters },
      async (): Promise<DataSource> => {
        const { url, credentialsProvider } = parseSpecialUrl(
          providerUrl,
          options.credentialsManager,
        );
        let metadata: any;
        try {
          metadata = await getJsonMetadata(
            options.chunkManager,
            credentialsProvider,
            url,
          );
        } catch (e) {
          if (isNotFoundError(e)) {
            if (parameters.type === "mesh") {
              console.log("does this happen?");
            }
          }
          throw e;
        }
        verifyObject(metadata);
        const redirect = verifyOptionalObjectProperty(
          metadata,
          "redirect",
          verifyString,
        );
        if (redirect !== undefined) {
          throw new RedirectError(redirect);
        }
        const t = verifyOptionalObjectProperty(metadata, "@type", verifyString);
        switch (t) {
          case "neuroglancer_multiscale_volume":
          case undefined:
            return await getVolumeDataSource(
              options,
              credentialsProvider,
              url,
              metadata,
            );
          default:
            throw new Error(`Invalid type: ${JSON.stringify(t)}`);
        }
      },
    );
  }
}

function getGraphLoadedSubsource(layer: SegmentationUserLayer) {
  for (const dataSource of layer.dataSources) {
    const { loadState } = dataSource;
    if (loadState === undefined || loadState.error !== undefined) continue;
    for (const subsource of loadState.subsources) {
      if (subsource.enabled) {
        if (subsource.subsourceEntry.id === "graph") {
          return subsource;
        }
      }
    }
  }
  return undefined;
}

function makeColoredAnnotationState(
  layer: SegmentationUserLayer,
  loadedSubsource: LoadedDataSubsource,
  subsubsourceId: string,
  color: vec3,
) {
  const { subsourceEntry } = loadedSubsource;
  const source = new LocalAnnotationSource(
    loadedSubsource.loadedDataSource.transform,
    [],
    ["associated segments"],
  );

  const displayState = new AnnotationDisplayState();
  displayState.color.value.set(color);

  displayState.relationshipStates.set("associated segments", {
    segmentationState: new WatchableValue(layer.displayState),
    showMatches: new TrackableBoolean(false),
  });

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

function getOptionalUint64(obj: any, key: string) {
  return verifyOptionalObjectProperty(obj, key, (value) =>
    Uint64.parseString(String(value)),
  );
}

function getUint64(obj: any, key: string) {
  return verifyObjectProperty(obj, key, (value) =>
    Uint64.parseString(String(value)),
  );
}

function restoreSegmentSelection(obj: any): SegmentSelection {
  const segmentId = getUint64(obj, SEGMENT_ID_JSON_KEY);
  const rootId = getUint64(obj, ROOT_ID_JSON_KEY);
  const position = verifyObjectProperty(obj, POSITION_JSON_KEY, (value) => {
    return verify3dVec(value);
  });
  return {
    segmentId,
    rootId,
    position,
  };
}

const segmentSelectionToJSON = (x: SegmentSelection) => {
  return {
    [SEGMENT_ID_JSON_KEY]: x.segmentId.toJSON(),
    [ROOT_ID_JSON_KEY]: x.rootId.toJSON(),
    [POSITION_JSON_KEY]: [...x.position],
  };
};

const ID_JSON_KEY = "id";
const SEGMENT_ID_JSON_KEY = "segmentId";
const ROOT_ID_JSON_KEY = "rootId";
const POSITION_JSON_KEY = "position";
const SINK_JSON_KEY = "sink";
const SOURCE_JSON_KEY = "source";

const MULTICUT_JSON_KEY = "multicut";
const FOCUS_SEGMENT_JSON_KEY = "focusSegment";
const SINKS_JSON_KEY = "sinks";
const SOURCES_JSON_KEY = "sources";

const MERGE_JSON_KEY = "merge";
const MERGES_JSON_KEY = "merges";
const AUTOSUBMIT_JSON_KEY = "autosubmit";
const LOCKED_JSON_KEY = "locked";
const MERGED_ROOT_JSON_KEY = "mergedRoot";
const ERROR_JSON_KEY = "error";

const FIND_PATH_JSON_KEY = "findPath";
const TARGET_JSON_KEY = "target";
const CENTROIDS_JSON_KEY = "centroids";
const PRECISION_MODE_JSON_KEY = "precision";

class GrapheneState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  public multicutState = new MulticutState();
  public mergeState = new MergeState();
  public findPathState = new FindPathState();

  constructor() {
    super();
    this.registerDisposer(
      this.multicutState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.mergeState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.findPathState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    this.multicutState.replaceSegments(oldValues, newValues);
    this.mergeState.replaceSegments(oldValues, newValues);
    this.findPathState.replaceSegments(oldValues, newValues);
  }

  reset() {
    this.multicutState.reset();
    this.mergeState.reset();
    this.findPathState.reset();
  }

  toJSON() {
    return {
      [MULTICUT_JSON_KEY]: this.multicutState.toJSON(),
      [MERGE_JSON_KEY]: this.mergeState.toJSON(),
      [FIND_PATH_JSON_KEY]: this.findPathState.toJSON(),
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, MULTICUT_JSON_KEY, (value) => {
      this.multicutState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, MERGE_JSON_KEY, (value) => {
      this.mergeState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, FIND_PATH_JSON_KEY, (value) => {
      this.findPathState.restoreState(value);
    });
  }
}

export interface SegmentSelection {
  segmentId: Uint64;
  rootId: Uint64;
  position: Float32Array;
  annotationReference?: AnnotationReference;
}

class MergeState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  merges = new WatchableValue<MergeSubmission[]>([]);
  autoSubmit = new TrackableBoolean(false);

  constructor() {
    super();
    this.registerDisposer(this.merges.changed.add(this.changed.dispatch));
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const {
      merges: { value: merges },
    } = this;
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    for (const merge of merges) {
      if (merge.source && oldValues.has(merge.source.rootId)) {
        if (newValue) {
          merge.source.rootId = newValue;
        } else {
          this.reset();
          return;
        }
      }
      if (merge.sink && oldValues.has(merge.sink.rootId)) {
        if (newValue) {
          merge.sink.rootId = newValue;
        } else {
          this.reset();
          return;
        }
      }
    }
  }

  reset() {
    this.merges.value = [];
    this.autoSubmit.reset();
  }

  toJSON() {
    const { merges, autoSubmit } = this;
    const mergeToJSON = (x: MergeSubmission) => {
      const res: any = {
        [ID_JSON_KEY]: x.id,
        [LOCKED_JSON_KEY]: x.locked,
        [SINK_JSON_KEY]: segmentSelectionToJSON(x.sink),
        [SOURCE_JSON_KEY]: segmentSelectionToJSON(x.source!),
      };
      if (x.mergedRoot) {
        res[MERGED_ROOT_JSON_KEY] = x.mergedRoot.toJSON();
      }
      if (x.error) {
        res[ERROR_JSON_KEY] = x.error;
      }
      return res;
    };
    return {
      [MERGES_JSON_KEY]: merges.value.filter((x) => x.source).map(mergeToJSON),
      [AUTOSUBMIT_JSON_KEY]: autoSubmit.toJSON(),
    };
  }

  restoreState(x: any) {
    function restoreSubmission(obj: any): MergeSubmission {
      const mergedRoot = getOptionalUint64(obj, MERGED_ROOT_JSON_KEY);
      const id = verifyObjectProperty(obj, ID_JSON_KEY, verifyString);
      const error = verifyOptionalObjectProperty(
        obj,
        ERROR_JSON_KEY,
        verifyString,
      );
      const locked = verifyObjectProperty(obj, LOCKED_JSON_KEY, verifyBoolean);
      const sink = restoreSegmentSelection(obj[SINK_JSON_KEY]);
      const source = restoreSegmentSelection(obj[SOURCE_JSON_KEY]);
      return {
        id,
        locked,
        sink,
        source,
        mergedRoot,
        error,
      };
    }

    const submissionsValidator = (value: any) => {
      return parseArray(value, (x) => {
        return restoreSubmission(x);
      });
    };

    this.merges.value = verifyObjectProperty(
      x,
      MERGES_JSON_KEY,
      submissionsValidator,
    );
    this.autoSubmit.restoreState(
      verifyOptionalObjectProperty(x, AUTOSUBMIT_JSON_KEY, verifyBoolean),
    );
  }
}

class FindPathState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  triggerPathUpdate = new NullarySignal();

  source = new TrackableValue<SegmentSelection | undefined>(
    undefined,
    (x) => x,
  );
  target = new TrackableValue<SegmentSelection | undefined>(
    undefined,
    (x) => x,
  );
  centroids = new TrackableValue<number[][]>([], (x) => x);
  precisionMode = new TrackableBoolean(true);

  get path() {
    const path: Line[] = [];
    const {
      source: { value: source },
      target: { value: target },
      centroids: { value: centroids },
    } = this;
    if (!source || !target || centroids.length === 0) {
      return path;
    }
    for (let i = 0; i < centroids.length - 1; i++) {
      const pointA = centroids[i];
      const pointB = centroids[i + 1];
      const line: Line = {
        pointA: vec3.fromValues(pointA[0], pointA[1], pointA[2]),
        pointB: vec3.fromValues(pointB[0], pointB[1], pointB[2]),
        id: "",
        type: AnnotationType.LINE,
        properties: [],
      };
      path.push(line);
    }
    const firstLine: Line = {
      pointA: source.position,
      pointB: path[0].pointA,
      id: "",
      type: AnnotationType.LINE,
      properties: [],
    };
    const lastLine: Line = {
      pointA: path[path.length - 1].pointB,
      pointB: target.position,
      id: "",
      type: AnnotationType.LINE,
      properties: [],
    };

    return [firstLine, ...path, lastLine];
  }

  constructor() {
    super();
    this.registerDisposer(
      this.source.changed.add(() => {
        this.centroids.reset();
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.target.changed.add(() => {
        this.centroids.reset();
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(this.centroids.changed.add(this.changed.dispatch));
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const {
      source: { value: source },
      target: { value: target },
    } = this;
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    const sourceChanged = !!source && oldValues.has(source.rootId);
    const targetChanged = !!target && oldValues.has(target.rootId);
    if (newValue) {
      if (sourceChanged) {
        source.rootId = newValue;
      }
      if (targetChanged) {
        target.rootId = newValue;
      }
      // don't want to fire off multiple changed
      if (sourceChanged || targetChanged) {
        if (this.centroids.value.length) {
          this.centroids.reset();
          this.triggerPathUpdate.dispatch();
        } else {
          this.changed.dispatch();
        }
      }
    } else {
      if (sourceChanged || targetChanged) {
        this.reset();
      }
    }
  }

  reset() {
    this.source.reset();
    this.target.reset();
    this.centroids.reset();
    this.precisionMode.reset();
  }

  toJSON() {
    const {
      source: { value: source },
      target: { value: target },
      centroids,
      precisionMode,
    } = this;
    return {
      [SOURCE_JSON_KEY]: source ? segmentSelectionToJSON(source) : undefined,
      [TARGET_JSON_KEY]: target ? segmentSelectionToJSON(target) : undefined,
      [CENTROIDS_JSON_KEY]: centroids.toJSON(),
      [PRECISION_MODE_JSON_KEY]: precisionMode.toJSON(),
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, SOURCE_JSON_KEY, (value) => {
      this.source.restoreState(restoreSegmentSelection(value));
    });
    verifyOptionalObjectProperty(x, TARGET_JSON_KEY, (value) => {
      this.target.restoreState(restoreSegmentSelection(value));
    });
    verifyOptionalObjectProperty(x, CENTROIDS_JSON_KEY, (value) => {
      this.centroids.restoreState(value);
    });
    verifyOptionalObjectProperty(x, PRECISION_MODE_JSON_KEY, (value) => {
      this.precisionMode.restoreState(value);
    });
  }
}

class MulticutState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  sinks = new WatchableSet<SegmentSelection>();
  sources = new WatchableSet<SegmentSelection>();

  constructor(
    public focusSegment = new TrackableValue<Uint64 | undefined>(
      undefined,
      (x) => x,
    ),
    public blueGroup = new WatchableValue<boolean>(false),
  ) {
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

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    const {
      focusSegment: { value: focusSegment },
    } = this;

    if (focusSegment && oldValues.has(focusSegment)) {
      if (newValue) {
        this.focusSegment.value = newValue;
        for (const sink of this.sinks) {
          sink.rootId = newValue;
        }
        for (const source of this.sources) {
          source.rootId = newValue;
        }
        this.changed.dispatch();
      } else {
        this.reset();
      }
    }
  }

  reset() {
    this.focusSegment.reset();
    this.blueGroup.value = false;
    this.sinks.clear();
    this.sources.clear();
  }

  toJSON() {
    const { focusSegment, sinks, sources } = this;
    return {
      [FOCUS_SEGMENT_JSON_KEY]: focusSegment.toJSON(),
      [SINKS_JSON_KEY]: [...sinks].map(segmentSelectionToJSON),
      [SOURCES_JSON_KEY]: [...sources].map(segmentSelectionToJSON),
    };
  }

  restoreState(x: any) {
    const segmentSelectionsValidator = (value: any) => {
      return parseArray(value, (x) => {
        return restoreSegmentSelection(x);
      });
    };

    verifyOptionalObjectProperty(x, FOCUS_SEGMENT_JSON_KEY, (value) => {
      this.focusSegment.restoreState(Uint64.parseString(String(value)));
    });
    const sinks = verifyObjectProperty(
      x,
      SINKS_JSON_KEY,
      segmentSelectionsValidator,
    );
    const sources = verifyObjectProperty(
      x,
      SOURCES_JSON_KEY,
      segmentSelectionsValidator,
    );

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
    return [...this.sinks]
      .filter((x) => !Uint64.equal(x.segmentId, x.rootId))
      .map((x) => x.segmentId);
  }

  get blueSegments() {
    return [...this.sources]
      .filter((x) => !Uint64.equal(x.segmentId, x.rootId))
      .map((x) => x.segmentId);
  }
}

class GraphConnection extends SegmentationGraphSourceConnection {
  public annotationLayerStates: AnnotationLayerState[] = [];
  public mergeAnnotationState: AnnotationLayerState;
  public findPathAnnotationState: AnnotationLayerState;

  constructor(
    public graph: GrapheneGraphSource,
    private layer: SegmentationUserLayer,
    private chunkSource: GrapheneMultiscaleVolumeChunkSource,
    public state: GrapheneState,
  ) {
    super(graph, layer.displayState.segmentationGroupState.value);
    const segmentsState = layer.displayState.segmentationGroupState.value;
    this.registerDisposer(
      segmentsState.selectedSegments.changed.add(
        (segmentIds: Uint64[] | Uint64 | null, add: boolean) => {
          if (segmentIds !== null) {
            segmentIds = Array<Uint64>().concat(segmentIds);
          }
          this.selectedSegmentsChanged(segmentIds, add);
        },
      ),
    );

    this.registerDisposer(
      segmentsState.visibleSegments.changed.add(
        (segmentIds: Uint64[] | Uint64 | null, add: boolean) => {
          if (segmentIds !== null) {
            segmentIds = Array<Uint64>().concat(segmentIds);
          }
          this.visibleSegmentsChanged(segmentIds, add);
        },
      ),
    );

    const {
      annotationLayerStates,
      state: { multicutState, findPathState },
    } = this;
    const loadedSubsource = getGraphLoadedSubsource(layer)!;
    const redGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "sinks",
      RED_COLOR,
    );
    const blueGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "sources",
      BLUE_COLOR,
    );
    synchronizeAnnotationSource(multicutState.sinks, redGroup);
    synchronizeAnnotationSource(multicutState.sources, blueGroup);
    annotationLayerStates.push(redGroup, blueGroup);

    if (layer.tool.value instanceof MergeSegmentsPlaceLineTool) {
      layer.tool.value = undefined;
    }

    this.mergeAnnotationState = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "grapheneMerge",
      RED_COLOR,
    );

    {
      const { mergeState } = state;
      const { merges, autoSubmit } = mergeState;
      const { mergeAnnotationState } = this;
      const { visibleSegments } = segmentsState;

      // load merges from state
      for (const merge of merges.value) {
        mergeAnnotationState.source.add(mergeToLine(merge));
      }

      // initialize source changes
      this.registerDisposer(
        mergeAnnotationState.source.childAdded.add((x) => {
          const annotation = x as Line;
          const relatedSegments = annotation.relatedSegments![0];
          const visibles = relatedSegments.map((x) => visibleSegments.has(x));
          if (visibles[0] === false) {
            setTimeout(() => {
              const { tool } = layer;
              if (tool.value instanceof MergeSegmentsPlaceLineTool) {
                tool.value.deactivate();
              }
            }, 0);
            StatusMessage.showTemporaryMessage(
              `Cannot merge a hidden segment.`,
            );
          } else if (merges.value.length < MAX_MERGE_COUNT) {
            merges.value = [
              ...merges.value,
              lineToSubmission(annotation, true),
            ];
          } else {
            setTimeout(() => {
              const { tool } = layer;
              if (tool.value instanceof MergeSegmentsPlaceLineTool) {
                tool.value.deactivate();
              }
            }, 0);
            StatusMessage.showTemporaryMessage(
              `Maximum of ${MAX_MERGE_COUNT} simultanous merges allowed.`,
            );
          }
        }),
      );

      this.registerDisposer(
        mergeAnnotationState.source.childCommitted.add((x) => {
          const ref = mergeAnnotationState.source.getReference(x);
          const annotation = ref.value as Line | undefined;
          if (annotation) {
            const relatedSegments = annotation.relatedSegments![0];
            const visibles = relatedSegments.map((x) => visibleSegments.has(x));
            if (relatedSegments.length < 4) {
              mergeAnnotationState.source.delete(ref);
              StatusMessage.showTemporaryMessage(
                `Cannot merge segment with itself.`,
              );
            }
            if (visibles[2] === false) {
              mergeAnnotationState.source.delete(ref);
              StatusMessage.showTemporaryMessage(
                `Cannot merge a hidden segment.`,
              );
            }
            const existingSubmission = merges.value.find(
              (x) => x.id === ref.id,
            );
            if (existingSubmission && !existingSubmission?.locked) {
              //  how would it be locked?
              const newSubmission = lineToSubmission(annotation, false);
              existingSubmission.sink = newSubmission.sink;
              existingSubmission.source = newSubmission.source;
              merges.changed.dispatch();
              if (autoSubmit.value) {
                this.bulkMerge([existingSubmission]);
              }
            }
          }
          ref.dispose();
        }),
      );

      this.registerDisposer(
        mergeAnnotationState.source.childDeleted.add((id) => {
          let changed = false;
          const filtered = merges.value.filter((x) => {
            const keep = x.id !== id || x.locked;
            if (!keep) {
              changed = true;
            }
            return keep;
          });
          if (changed) {
            merges.value = filtered;
          }
        }),
      );
    }

    const findPathGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "findpath",
      WHITE_COLOR,
    );
    this.findPathAnnotationState = findPathGroup;
    findPathGroup.source.childDeleted.add((annotationId) => {
      if (
        findPathState.source.value?.annotationReference?.id === annotationId
      ) {
        findPathState.source.value = undefined;
      }
      if (
        findPathState.target.value?.annotationReference?.id === annotationId
      ) {
        findPathState.target.value = undefined;
      }
    });
    let findPathCancellation: CancellationTokenSource | undefined = undefined;
    const findPathChanged = () => {
      if (findPathCancellation) {
        findPathCancellation.cancel();
      }
      const { path, source, target } = findPathState;
      const annotationSource = findPathGroup.source;
      if (source.value && !source.value.annotationReference) {
        addSelection(annotationSource, source.value, "find path source");
      }
      if (target.value && !target.value.annotationReference) {
        addSelection(annotationSource, target.value, "find path target");
      }
      for (const annotation of annotationSource) {
        if (
          annotation.id !== source.value?.annotationReference?.id &&
          annotation.id !== target.value?.annotationReference?.id
        ) {
          annotationSource.delete(annotationSource.getReference(annotation.id));
        }
      }
      for (const line of path) {
        // line.id = ''; // TODO, is it a bug that this is necessary? annotationMap is empty if I
        // step through it but logging shows it isn't empty
        annotationSource.add(line);
      }
    };
    this.registerDisposer(findPathState.changed.add(findPathChanged));
    this.registerDisposer(
      findPathState.triggerPathUpdate.add(() => {
        if (findPathCancellation) {
          findPathCancellation.cancel();
        }
        const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
        const annotationToNanometers =
          loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
            (x) => x / 1e-9,
          );
        findPathCancellation = new CancellationTokenSource();
        this.submitFindPath(
          findPathState.precisionMode.value,
          annotationToNanometers,
          findPathCancellation,
        ).then((success) => {
          success;
          findPathCancellation = undefined;
        });
      }),
    );
    findPathChanged(); // initial state
  }

  createRenderLayers(
    chunkManager: ChunkManager,
    displayState: SegmentationDisplayState3D,
    localPosition: WatchableValueInterface<Float32Array>,
  ): RenderLayer[] {
    return [
      new SliceViewPanelChunkedGraphLayer(
        chunkManager,
        this.chunkSource.getChunkedGraphSource(),
        displayState, // FIXME will displayState always match this.segmentsState?
        localPosition,
        this.graph.info.graph.nBitsForLayerId,
      ),
    ];
  }

  private lastDeselectionMessage: StatusMessage | undefined;
  private lastDeselectionMessageExists = false;

  private visibleSegmentsChanged(segments: Uint64[] | null, added: boolean) {
    const { segmentsState } = this;
    const {
      focusSegment: { value: focusSegment },
    } = this.graph.state.multicutState;
    if (focusSegment && !segmentsState.visibleSegments.has(focusSegment)) {
      if (segmentsState.selectedSegments.has(focusSegment)) {
        StatusMessage.showTemporaryMessage(
          `Can't hide active multicut segment.`,
          3000,
        );
      } else {
        StatusMessage.showTemporaryMessage(
          `Can't deselect active multicut segment.`,
          3000,
        );
      }
      segmentsState.selectedSegments.add(focusSegment);
      segmentsState.visibleSegments.add(focusSegment);
      if (segments) {
        segments = segments.filter(
          (segment) => !Uint64.equal(segment, focusSegment),
        );
      }
    }
    if (segments === null) {
      const leafSegmentCount = this.segmentsState.selectedSegments.size;
      this.segmentsState.segmentEquivalences.clear();
      StatusMessage.showTemporaryMessage(
        `Hid all ${leafSegmentCount} segments.`,
        3000,
      );
      return;
    }
    for (const segmentId of segments) {
      if (!added) {
        const segmentCount = [
          ...segmentsState.segmentEquivalences.setElements(segmentId),
        ].length; // Approximation
        segmentsState.segmentEquivalences.deleteSet(segmentId);
        if (this.lastDeselectionMessage && this.lastDeselectionMessageExists) {
          this.lastDeselectionMessage.dispose();
          this.lastDeselectionMessageExists = false;
        }
        this.lastDeselectionMessage = StatusMessage.showMessage(
          `Hid ${segmentCount} segments.`,
        );
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

  private selectedSegmentsChanged(segments: Uint64[] | null, added: boolean) {
    const { segmentsState } = this;
    if (segments === null) {
      const leafSegmentCount = this.segmentsState.selectedSegments.size;
      StatusMessage.showTemporaryMessage(
        `Deselected all ${leafSegmentCount} segments.`,
        3000,
      );
      return;
    }
    for (const segmentId of segments) {
      const isBaseSegment = isBaseSegmentId(
        segmentId,
        this.graph.info.graph.nBitsForLayerId,
      );
      const segmentConst = segmentId.clone();
      if (added && isBaseSegment) {
        this.graph.getRoot(segmentConst).then((rootId) => {
          if (segmentsState.visibleSegments.has(segmentConst)) {
            segmentsState.visibleSegments.add(rootId);
          }
          segmentsState.selectedSegments.delete(segmentConst);
          segmentsState.selectedSegments.add(rootId);
        });
      }
    }
  }

  computeSplit(include: Uint64, exclude: Uint64): ComputedSplit | undefined {
    include;
    exclude;
    return undefined;
  }

  getMeshSource() {
    const { layer } = this;
    for (const dataSource of layer.dataSources) {
      const { loadState } = dataSource;
      if (loadState instanceof LoadedLayerDataSource) {
        const { subsources } = loadState.dataSource;
        const graphSubsource = subsources.filter(
          (subsource) => subsource.id === "graph",
        )[0];
        if (graphSubsource && graphSubsource.subsource.segmentationGraph) {
          if (graphSubsource.subsource.segmentationGraph !== this.graph) {
            continue;
          }
        }
        const meshSubsource = subsources.filter(
          (subsource) => subsource.id === "mesh",
        )[0];
        if (meshSubsource) {
          return meshSubsource.subsource.mesh;
        }
      }
    }
    return undefined;
  }

  meshAddNewSegments(segments: Uint64[]) {
    const meshSource = this.getMeshSource();
    if (meshSource) {
      for (const segment of segments) {
        meshSource.rpc!.invoke(GRAPHENE_MESH_NEW_SEGMENT_RPC_ID, {
          rpcId: meshSource.rpcId!,
          segment: segment.toString(),
        });
      }
    }
  }

  async submitMulticut(annotationToNanometers: Float64Array): Promise<boolean> {
    const {
      state: { multicutState },
    } = this;
    const { sinks, sources } = multicutState;
    if (sinks.size === 0 || sources.size === 0) {
      StatusMessage.showTemporaryMessage(
        "Must select both red and blue groups to perform a multi-cut.",
        7000,
      );
      return false;
    } else {
      const splitRoots = await this.graph.graphServer.splitSegments(
        [...sinks].map((x) => selectionInNanometers(x, annotationToNanometers)),
        [...sources].map((x) =>
          selectionInNanometers(x, annotationToNanometers),
        ),
      );
      if (splitRoots.length === 0) {
        StatusMessage.showTemporaryMessage(`No split found.`, 3000);
        return false;
      } else {
        const focusSegment = multicutState.focusSegment.value!;
        multicutState.reset(); // need to clear the focus segment before deleting the multicut segment
        const { segmentsState } = this;
        segmentsState.selectedSegments.delete(focusSegment);
        for (const segment of [...sinks, ...sources]) {
          segmentsState.selectedSegments.delete(segment.rootId);
        }
        this.meshAddNewSegments(splitRoots);
        segmentsState.selectedSegments.add(splitRoots);
        segmentsState.visibleSegments.add(splitRoots);
        const oldValues = new Uint64Set();
        oldValues.add(focusSegment);
        const newValues = new Uint64Set();
        newValues.add(splitRoots);
        this.state.replaceSegments(oldValues, newValues);
        return true;
      }
    }
  }

  deleteMergeSubmission = (submission: MergeSubmission) => {
    const { mergeAnnotationState } = this;
    submission.locked = false;
    mergeAnnotationState.source.delete(
      mergeAnnotationState.source.getReference(submission.id),
    );
  };

  private submitMerge = async (
    submission: MergeSubmission,
    attempts = 1,
  ): Promise<Uint64> => {
    const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
    const annotationToNanometers =
      loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
        (x) => x / 1e-9,
      );
    submission.error = undefined;
    for (let i = 1; i <= attempts; i++) {
      try {
        const newRoot = await this.graph.graphServer.mergeSegments(
          selectionInNanometers(submission.sink, annotationToNanometers),
          selectionInNanometers(submission.source!, annotationToNanometers),
        );
        const oldValues = new Uint64Set();
        oldValues.add(submission.sink.rootId);
        oldValues.add(submission.source!.rootId);
        const newValues = new Uint64Set();
        newValues.add(newRoot);
        this.state.replaceSegments(oldValues, newValues);
        return newRoot;
      } catch (err) {
        if (i === attempts) {
          submission.error = err.message || "unknown";
          throw err;
        }
      }
    }

    return Uint64.ZERO; // appease typescript
  };

  async bulkMerge(submissions: MergeSubmission[]) {
    const { merges } = this.state.mergeState;
    const bulkMergeHelper = (
      submissions: MergeSubmission[],
    ): Promise<Uint64[]> => {
      return new Promise((f) => {
        if (submissions.length === 0) {
          f([]);
          return;
        }
        const segmentsToRemove: Uint64[] = [];
        let completed = 0;
        let activeLoops = 0;
        const loop = (completedAt: number, pending: MergeSubmission[]) => {
          if (completed === submissions.length || pending.length === 0) return;
          activeLoops++;
          let failed: MergeSubmission[] = [];
          const checkDone = () => {
            loopDone++;
            if (loopDone === pending.length) {
              activeLoops -= 1;
            }
            if (activeLoops === 0) {
              f(segmentsToRemove);
            }
          };
          let loopDone = 0;
          for (const submission of pending) {
            submission.locked = true;
            submission.status = "trying...";
            merges.changed.dispatch();
            const segments = [
              submission.source!.rootId,
              submission.sink.rootId,
            ];
            this.submitMerge(submission, 3)
              .then((mergedRoot) => {
                segmentsToRemove.push(...segments);
                submission.status = "done";
                submission.mergedRoot = mergedRoot;
                merges.changed.dispatch();
                completed += 1;
                loop(completed, failed);
                failed = [];
                checkDone();
                wait(5000).then(() => {
                  this.deleteMergeSubmission(submission);
                });
              })
              .catch(() => {
                merges.changed.dispatch();
                failed.push(submission);
                if (completed > completedAt) {
                  loop(completed, failed);
                  failed = [];
                }
                checkDone();
              });
          }
        };
        loop(completed, submissions);
      });
    };

    submissions = submissions.filter((x) => !x.locked && x.source);
    const segmentsToRemove = await bulkMergeHelper(submissions);
    const segmentsToAdd: Uint64[] = [];
    for (const submission of submissions) {
      if (submission.error) {
        submission.locked = false;
        submission.status = submission.error;
      } else if (submission.mergedRoot) {
        segmentsToAdd.push(submission.mergedRoot);
      }
      const segmentsState =
        this.layer.displayState.segmentationGroupState.value;
      const { visibleSegments, selectedSegments } = segmentsState;
      selectedSegments.delete(segmentsToRemove);
      const latestRoots =
        await this.graph.graphServer.filterLatestRoots(segmentsToAdd);
      this.meshAddNewSegments(latestRoots);
      selectedSegments.add(latestRoots);
      visibleSegments.add(latestRoots);
      merges.changed.dispatch();
    }
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    const { visibleSegments, selectedSegments } = segmentsState;
    selectedSegments.delete(segmentsToRemove);
    const latestRoots =
      await this.graph.graphServer.filterLatestRoots(segmentsToAdd);
    selectedSegments.add(latestRoots);
    visibleSegments.add(latestRoots);
    merges.changed.dispatch();
  }

  async submitFindPath(
    precisionMode: boolean,
    annotationToNanometers: Float64Array,
    cancellationToken?: CancellationToken,
  ): Promise<boolean> {
    const {
      state: { findPathState },
    } = this;
    const { source, target } = findPathState;
    if (!source.value || !target.value) return false;
    const centroids = await this.graph.findPath(
      source.value,
      target.value,
      precisionMode,
      annotationToNanometers,
      cancellationToken,
    );
    StatusMessage.showTemporaryMessage("Path found!", 5000);
    findPathState.centroids.value = centroids;
    return true;
  }
}

async function parseGrapheneError(e: HttpError) {
  if (e.response) {
    let msg: string;
    if (e.response.headers.get("content-type") === "application/json") {
      msg = (await e.response.json())["message"];
    } else {
      msg = await e.response.text();
    }
    return msg;
  }
  return undefined;
}

async function withErrorMessageHTTP(
  promise: Promise<Response>,
  options: {
    initialMessage?: string;
    errorPrefix: string;
  },
): Promise<Response> {
  let status: StatusMessage | undefined = undefined;
  let dispose = () => {};
  if (options.initialMessage) {
    status = new StatusMessage(true);
    status.setText(options.initialMessage);
    dispose = status.dispose.bind(status);
  }
  try {
    const response = await promise;
    dispose();
    return response;
  } catch (e) {
    if (e instanceof HttpError && e.response) {
      const { errorPrefix = "" } = options;
      const msg = (await parseGrapheneError(e)) || "unknown error";
      if (!status) {
        status = new StatusMessage(true);
      }
      status.setErrorMessage(errorPrefix + msg);
      status.setVisible(true);
      throw new Error(`[${e.response.status}] ${errorPrefix}${msg}`);
    }
    if (e instanceof DOMException && e.name === "AbortError") {
      dispose();
      StatusMessage.showTemporaryMessage("Request was aborted.");
    }
    throw e;
  }
}

const selectionInNanometers = (
  selection: SegmentSelection,
  annotationToNanometers: Float64Array,
): SegmentSelection => {
  const { rootId, segmentId, position } = selection;
  return {
    rootId,
    segmentId,
    position: position.map((val, i) => val * annotationToNanometers[i]),
  };
};

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol("Graph Server Not Specified.");

class GrapheneGraphServerInterface {
  constructor(
    private url: string,
    private credentialsProvider: SpecialProtocolCredentialsProvider,
  ) {}

  async getRoot(segment: Uint64, timestamp = "") {
    const timestampEpoch = new Date(timestamp).valueOf() / 1000;

    const url = `${this.url}/node/${String(segment)}/root?int64_as_str=1${
      Number.isNaN(timestampEpoch) ? "" : `&timestamp=${timestampEpoch}`
    }`;

    const promise = cancellableFetchSpecialOk(
      this.credentialsProvider,
      url,
      {},
      responseIdentity,
    );

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Retrieving root for segment ${segment}`,
      errorPrefix: `Could not fetch root: `,
    });
    const jsonResp = await response.json();
    return Uint64.parseString(jsonResp["root_id"]);
  }

  async mergeSegments(
    first: SegmentSelection,
    second: SegmentSelection,
  ): Promise<Uint64> {
    const { url } = this;
    if (url === "") {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = cancellableFetchSpecialOk(
      this.credentialsProvider,
      `${url}/merge?int64_as_str=1`,
      {
        method: "POST",
        body: JSON.stringify([
          [String(first.segmentId), ...first.position],
          [String(second.segmentId), ...second.position],
        ]),
      },
      responseIdentity,
    );

    try {
      const response = await promise;
      const jsonResp = await response.json();
      return Uint64.parseString(jsonResp["new_root_ids"][0]);
    } catch (e) {
      if (e instanceof HttpError) {
        const msg = await parseGrapheneError(e);
        throw new Error(msg);
      }
      throw e;
    }
  }

  async splitSegments(
    first: SegmentSelection[],
    second: SegmentSelection[],
  ): Promise<Uint64[]> {
    const { url } = this;
    if (url === "") {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = cancellableFetchSpecialOk(
      this.credentialsProvider,
      `${url}/split?int64_as_str=1`,
      {
        method: "POST",
        body: JSON.stringify({
          sources: first.map((x) => [String(x.segmentId), ...x.position]),
          sinks: second.map((x) => [String(x.segmentId), ...x.position]),
        }),
      },
      responseIdentity,
    );

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Splitting ${first.length} sources from ${second.length} sinks`,
      errorPrefix: "Split failed: ",
    });
    const jsonResp = await response.json();
    const final: Uint64[] = new Array(jsonResp["new_root_ids"].length);
    for (let i = 0; i < final.length; ++i) {
      final[i] = Uint64.parseString(jsonResp["new_root_ids"][i]);
    }
    return final;
  }

  async filterLatestRoots(segments: Uint64[]): Promise<Uint64[]> {
    const url = `${this.url}/is_latest_roots`;

    const promise = cancellableFetchSpecialOk(
      this.credentialsProvider,
      url,
      {
        method: "POST",
        body: JSON.stringify({ node_ids: segments.map((x) => x.toJSON()) }),
      },
      responseIdentity,
    );

    const response = await withErrorMessageHTTP(promise, {
      errorPrefix: `Could not check latest: `,
    });
    const jsonResp = await response.json();

    const res: Uint64[] = [];
    for (const [i, isLatest] of jsonResp["is_latest"].entries()) {
      if (isLatest) {
        res.push(segments[i]);
      }
    }
    return res;
  }

  async findPath(
    first: SegmentSelection,
    second: SegmentSelection,
    precisionMode: boolean,
    cancellationToken?: CancellationToken,
  ) {
    const { url } = this;
    if (url === "") {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }
    const promise = cancellableFetchSpecialOk(
      this.credentialsProvider,
      `${url}/graph/find_path?int64_as_str=1&precision_mode=${Number(precisionMode)}`,
      {
        method: "POST",
        body: JSON.stringify([
          [String(first.rootId), ...first.position],
          [String(second.rootId), ...second.position],
        ]),
      },
      responseIdentity,
      cancellationToken,
    );

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Finding path between ${first.segmentId} and ${second.segmentId}`,
      errorPrefix: "Path finding failed: ",
    });
    const jsonResponse = await response.json();
    const supervoxelCentroidsKey = "centroids_list";
    const centroids = verifyObjectProperty(
      jsonResponse,
      supervoxelCentroidsKey,
      (x) => parseArray(x, verifyFloatArray),
    );
    const missingL2IdsKey = "failed_l2_ids";
    const missingL2Ids = jsonResponse[missingL2IdsKey];
    if (missingL2Ids && missingL2Ids.length > 0) {
      StatusMessage.showTemporaryMessage(
        "Some level 2 meshes are missing, so the path shown may have a poor level of detail.",
      );
    }
    const l2_path = verifyOptionalObjectProperty(
      jsonResponse,
      "l2_path",
      verifyStringArray,
    );
    return {
      centroids,
      l2_path,
    };
  }
}

class GrapheneGraphSource extends SegmentationGraphSource {
  private connections = new Set<GraphConnection>();
  public graphServer: GrapheneGraphServerInterface;
  private l2CacheAvailable: boolean | undefined = undefined;

  constructor(
    public info: GrapheneMultiscaleVolumeInfo,
    private credentialsProvider: SpecialProtocolCredentialsProvider,
    private chunkSource: GrapheneMultiscaleVolumeChunkSource,
    public state: GrapheneState,
  ) {
    super();
    this.graphServer = new GrapheneGraphServerInterface(
      info.app!.segmentationUrl,
      credentialsProvider,
    );
  }

  connect(
    layer: SegmentationUserLayer,
  ): Owned<SegmentationGraphSourceConnection> {
    const connection = new GraphConnection(
      this,
      layer,
      this.chunkSource,
      this.state,
    );

    this.connections.add(connection);
    connection.registerDisposer(() => {
      this.connections.delete(connection);
    });

    return connection;
  }

  get visibleSegmentEquivalencePolicy() {
    return (
      VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE |
      VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED
    );
  }

  async isL2CacheUrlAvailable() {
    if (this.l2CacheAvailable !== undefined) {
      return this.l2CacheAvailable;
    }
    try {
      const { l2CacheUrl, table } = this.info.app;
      const tableMapping = await cancellableFetchSpecialOk(
        undefined,
        `${l2CacheUrl}/table_mapping`,
        {},
        responseJson,
      );
      this.l2CacheAvailable = !!(tableMapping && tableMapping[table]);
      return this.l2CacheAvailable;
    } catch (e) {
      console.error("e", e);
      return false;
    }
  }

  getRoot(segment: Uint64) {
    return this.graphServer.getRoot(segment);
  }

  async findPath(
    first: SegmentSelection,
    second: SegmentSelection,
    precisionMode: boolean,
    annotationToNanometers: Float64Array,
    cancellationToken?: CancellationToken,
  ): Promise<number[][]> {
    const { l2CacheUrl, table } = this.info.app;
    const l2CacheAvailable =
      precisionMode && (await this.isL2CacheUrlAvailable()); // don't check if available if we don't need it
    let { centroids, l2_path } = await this.graphServer.findPath(
      selectionInNanometers(first, annotationToNanometers),
      selectionInNanometers(second, annotationToNanometers),
      precisionMode && !l2CacheAvailable,
      cancellationToken,
    );
    if (precisionMode && l2CacheAvailable && l2_path) {
      const repCoordinatesUrl = `${l2CacheUrl}/table/${table}/attributes`;
      try {
        const res = await cancellableFetchSpecialOk(
          this.credentialsProvider,
          repCoordinatesUrl,
          {
            method: "POST",
            body: JSON.stringify({
              l2_ids: l2_path,
            }),
          },
          responseJson,
          cancellationToken,
        );

        // many reasons why an l2 id might not have info
        // l2 cache has a process that takes time for new ids (even hours)
        // maybe a small fraction have no info
        // sometime l2 is so small (single voxel), it is ignored by l2
        // best to just drop those points
        centroids = l2_path
          .map((id) => {
            return verifyOptionalObjectProperty(res, id, (x) => {
              return verifyIntegerArray(x["rep_coord_nm"]);
            });
          })
          .filter((x): x is number[] => x !== undefined);
      } catch (e) {
        console.log("e", e);
      }
    }
    const centroidsTransformed = centroids.map((point: number[]) => {
      return point.map((val, i) => val / annotationToNanometers[i]);
    });
    return centroidsTransformed;
  }

  tabContents(
    layer: SegmentationUserLayer,
    context: DependentViewContext,
    tab: SegmentationGraphSourceTab,
  ) {
    const parent = document.createElement("div");
    parent.style.display = "contents";
    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-segmentation-toolbox";
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: GRAPHENE_MULTICUT_SEGMENTS_TOOL_ID,
        label: "Multicut",
        title: "Multicut segments",
      }),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: GRAPHENE_MERGE_SEGMENTS_TOOL_ID,
        label: "Merge",
        title: "Merge segments",
      }),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: GRAPHENE_FIND_PATH_TOOL_ID,
        label: "Find Path",
        title: "Find Path",
      }),
    );
    parent.appendChild(toolbox);
    parent.appendChild(
      context.registerDisposer(
        new MulticutAnnotationLayerView(layer, layer.annotationDisplayState),
      ).element,
    );
    const tabElement = tab.element;
    tabElement.classList.add("neuroglancer-annotations-tab");
    tabElement.classList.add("neuroglancer-graphene-tab");
    return parent;
  }

  // following not used

  async merge(a: Uint64, b: Uint64): Promise<Uint64> {
    a;
    b;
    return new Uint64();
  }

  async split(
    include: Uint64,
    exclude: Uint64,
  ): Promise<{ include: Uint64; exclude: Uint64 }> {
    return { include, exclude };
  }

  trackSegment(id: Uint64, callback: (id: Uint64 | null) => void): () => void {
    return () => {
      console.log("trackSegment... do nothing", id, callback);
    };
  }
}

class ChunkedGraphChunkSource
  extends SliceViewChunkSource
  implements ChunkedGraphChunkSourceInterface
{
  spec: ChunkedGraphChunkSpecification;
  OPTIONS: { spec: ChunkedGraphChunkSpecification };

  constructor(
    chunkManager: ChunkManager,
    options: {
      spec: ChunkedGraphChunkSpecification;
    },
  ) {
    super(chunkManager, options);
  }
}

class GrapheneChunkedGraphChunkSource extends WithParameters(
  WithCredentialsProvider<SpecialProtocolCredentials>()(
    ChunkedGraphChunkSource,
  ),
  ChunkedGraphSourceParameters,
) {}

interface ChunkedGraphLayerDisplayState extends SegmentationDisplayState3D {}

interface TransformedChunkedGraphSource
  extends FrontendTransformedSource<
    SliceViewRenderLayer,
    ChunkedGraphChunkSource
  > {}

interface AttachmentState {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  source?: NestedStateManager<TransformedChunkedGraphSource>;
}

class SliceViewPanelChunkedGraphLayer extends SliceViewPanelRenderLayer {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  private sharedObject: SegmentationLayerSharedObject;
  readonly chunkTransform: WatchableValueInterface<
    ValueOrError<ChunkTransformParameters>
  >;

  private leafRequestsActive: SharedWatchableValue<boolean>;
  private leafRequestsStatusMessage: StatusMessage | undefined;

  constructor(
    public chunkManager: ChunkManager,
    public source: SliceViewSingleResolutionSource<ChunkedGraphChunkSource>,
    public displayState: ChunkedGraphLayerDisplayState,
    public localPosition: WatchableValueInterface<Float32Array>,
    nBitsForLayerId: number,
  ) {
    super();
    this.leafRequestsActive = this.registerDisposer(
      SharedWatchableValue.make(chunkManager.rpc!, true),
    );
    this.chunkTransform = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (modelTransform) =>
          makeValueOrError(() =>
            getChunkTransformParameters(valueOrThrow(modelTransform)),
          ),
        this.displayState.transform,
      ),
    );
    const sharedObject =
      (this.sharedObject =
      this.backend =
        this.registerDisposer(
          new SegmentationLayerSharedObject(
            chunkManager,
            displayState,
            this.layerChunkProgressInfo,
          ),
        ));
    sharedObject.RPC_TYPE_ID = CHUNKED_GRAPH_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      source: source.chunkSource.addCounterpartRef(),
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(
          chunkManager.rpc!,
          this.localPosition,
        ),
      ).rpcId,
      leafRequestsActive: this.leafRequestsActive.rpcId,
      nBitsForLayerId: this.registerDisposer(
        SharedWatchableValue.make(chunkManager.rpc!, nBitsForLayerId),
      ).rpcId,
    });
    this.registerDisposer(sharedObject.visibility.add(this.visibility));

    this.registerDisposer(
      this.leafRequestsActive.changed.add(() => {
        this.showOrHideMessage(this.leafRequestsActive.value);
      }),
    );
  }

  attach(attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
    super.attach(attachment);
    const chunkTransform = this.chunkTransform.value;
    const displayDimensionRenderInfo =
      attachment.view.displayDimensionRenderInfo.value;
    attachment.state = {
      chunkTransform,
      displayDimensionRenderInfo,
    };
    attachment.state!.source = attachment.registerDisposer(
      registerNested(
        (
          context: RefCounted,
          transform: RenderLayerTransformOrError,
          displayDimensionRenderInfo: DisplayDimensionRenderInfo,
        ) => {
          const transformedSources = getVolumetricTransformedSources(
            displayDimensionRenderInfo,
            transform,
            (_options) => [[this.source]],
            attachment.messages,
            this,
          ) as TransformedChunkedGraphSource[][];
          attachment.view.flushBackendProjectionParameters();
          this.sharedObject.rpc!.invoke(
            CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
            {
              layer: this.sharedObject.rpcId,
              view: attachment.view.rpcId,
              displayDimensionRenderInfo,
              sources: serializeAllTransformedSources(transformedSources),
            },
          );
          context;
          return transformedSources[0][0];
        },
        this.displayState.transform,
        attachment.view.displayDimensionRenderInfo,
      ),
    );
  }

  isReady() {
    return true;
  }

  private showOrHideMessage(leafRequestsActive: boolean) {
    if (this.leafRequestsStatusMessage && leafRequestsActive) {
      this.leafRequestsStatusMessage.dispose();
      this.leafRequestsStatusMessage = undefined;
      StatusMessage.showTemporaryMessage(
        "Loading chunked graph segmentation...",
        3000,
      );
    } else if (!this.leafRequestsStatusMessage && !leafRequestsActive) {
      this.leafRequestsStatusMessage = StatusMessage.showMessage(
        "At this zoom level, chunked graph segmentation will not be loaded. Please zoom in if you wish to load it.",
      );
    }
  }
}

const GRAPHENE_MULTICUT_SEGMENTS_TOOL_ID = "grapheneMulticutSegments";
const GRAPHENE_MERGE_SEGMENTS_TOOL_ID = "grapheneMergeSegments";
const GRAPHENE_FIND_PATH_TOOL_ID = "grapheneFindPath";

class MulticutAnnotationLayerView extends AnnotationLayerView {
  private _annotationStates: MergedAnnotationStates;

  constructor(
    public layer: SegmentationUserLayer,
    public displayState: AnnotationDisplayState,
  ) {
    super(layer, displayState);

    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (graphConnection instanceof GraphConnection) {
      for (const state of graphConnection.annotationLayerStates) {
        this.annotationStates.add(state);
      }
    }
  }

  get annotationStates() {
    if (this._annotationStates === undefined) {
      this._annotationStates = this.registerDisposer(
        new MergedAnnotationStates(),
      );
    }
    return this._annotationStates;
  }
}

const addSelection = (
  source: AnnotationSource | MultiscaleAnnotationSource,
  selection: SegmentSelection,
  description?: string,
) => {
  const annotation: Point = {
    id: "",
    point: selection.position,
    type: AnnotationType.POINT,
    properties: [],
    relatedSegments: [[selection.segmentId, selection.rootId]],
    description,
  };
  const ref = source.add(annotation);
  selection.annotationReference = ref;
};

const synchronizeAnnotationSource = (
  source: WatchableSet<SegmentSelection>,
  state: AnnotationLayerState,
) => {
  const annotationSource = state.source;
  annotationSource.childDeleted.add((annotationId) => {
    const selection = [...source].find(
      (selection) => selection.annotationReference?.id === annotationId,
    );
    if (selection) source.delete(selection);
  });
  source.changed.add((x, add) => {
    if (x === null) {
      for (const annotation of annotationSource) {
        annotationSource.delete(annotationSource.getReference(annotation.id));
      }
      return;
    }
    if (add) {
      addSelection(annotationSource, x);
    } else if (x.annotationReference) {
      annotationSource.delete(x.annotationReference);
    }
  });
  // load initial state
  for (const selection of source) {
    addSelection(annotationSource, selection);
  }
};

function getMousePositionInLayerCoordinates(
  unsnappedPosition: Float32Array,
  layer: SegmentationUserLayer,
): Float32Array | undefined {
  const loadedSubsource = getGraphLoadedSubsource(layer)!;
  const modelTransform = loadedSubsource.getRenderLayerTransform();
  const chunkTransform = makeValueOrError(() =>
    getChunkTransformParameters(valueOrThrow(modelTransform.value)),
  );
  if (chunkTransform.error !== undefined) return undefined;
  const chunkPosition = new Float32Array(
    chunkTransform.modelTransform.unpaddedRank,
  );
  if (
    !getChunkPositionFromCombinedGlobalLocalPositions(
      chunkPosition,
      unsnappedPosition,
      layer.localPosition.value,
      chunkTransform.layerRank,
      chunkTransform.combinedGlobalLocalToChunkTransform,
    )
  ) {
    return undefined;
  }
  return chunkPosition;
}

const getPoint = (
  layer: SegmentationUserLayer,
  mouseState: MouseSelectionState,
) => {
  if (mouseState.updateUnconditionally()) {
    return getMousePositionInLayerCoordinates(
      mouseState.unsnappedPosition,
      layer,
    );
  }
  return undefined;
};

const MULTICUT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+control+mousedown0": { action: "set-anchor" },
  "at:shift?+keyg": { action: "swap-group" },
  "at:shift?+enter": { action: "submit" },
});

class MulticutSegmentsTool extends LayerTool<SegmentationUserLayer> {
  toJSON() {
    return GRAPHENE_MULTICUT_SEGMENTS_TOOL_ID;
  }

  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection))
      return;
    const {
      state: { multicutState },
      segmentsState,
    } = graphConnection;
    if (multicutState === undefined) return;

    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Multicut segments";
    body.classList.add("graphene-tool-status", "graphene-multicut");
    body.appendChild(
      makeIcon({
        text: "Swap",
        title: "Swap group",
        onClick: () => {
          multicutState.swapGroup();
        },
      }),
    );
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear multicut",
        onClick: () => {
          multicutState.reset();
        },
      }),
    );
    const submitAction = async () => {
      submitIcon.classList.toggle("disabled", true);
      const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
      const annotationToNanometers =
        loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
          (x) => x / 1e-9,
        );
      graphConnection.submitMulticut(annotationToNanometers).then((success) => {
        submitIcon.classList.toggle("disabled", false);
        if (success) {
          activation.cancel();
        }
      });
    };
    const submitIcon = makeIcon({
      text: "Submit",
      title: "Submit multicut",
      onClick: () => {
        submitAction();
      },
    });
    body.appendChild(submitIcon);
    const activeGroupIndicator = document.createElement("div");
    activeGroupIndicator.className = "activeGroupIndicator";
    activeGroupIndicator.innerHTML = "Active Group: ";
    body.appendChild(activeGroupIndicator);

    const { displayState } = this.layer;
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = displayState.segmentationGroupState.value;
    const priorBaseSegmentHighlighting =
      displayState.baseSegmentHighlighting.value;
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
      activeGroupIndicator.classList.toggle(
        "blueGroup",
        multicutState.blueGroup.value,
      );

      const focusSegment = multicutState.focusSegment.value;
      if (focusSegment === undefined) return;

      displayState.baseSegmentHighlighting.value = true;
      displayState.highlightColor.value = multicutState.blueGroup.value
        ? BLUE_COLOR_HIGHTLIGHT
        : RED_COLOR_HIGHLIGHT;
      segmentsState.useTemporaryVisibleSegments.value = true;
      segmentsState.useTemporarySegmentEquivalences.value = true;

      // add to focus segments and temporary sets
      segmentsState.temporaryVisibleSegments.add(focusSegment);

      for (const segment of multicutState.segments) {
        segmentsState.temporaryVisibleSegments.add(segment);
      }

      // all other segments are added to the focus segment equivalences
      for (const equivalence of segmentsState.segmentEquivalences.setElements(
        focusSegment,
      )) {
        if (!segmentsState.temporaryVisibleSegments.has(equivalence)) {
          segmentsState.temporarySegmentEquivalences.link(
            focusSegment,
            equivalence,
          );
        }
      }

      // set colors
      displayState.tempSegmentDefaultColor2d.value = MULTICUT_OFF_COLOR;
      displayState.tempSegmentStatedColors2d.value.set(
        focusSegment,
        TRANSPARENT_COLOR_PACKED,
      );

      for (const segment of multicutState.redSegments) {
        displayState.tempSegmentStatedColors2d.value.set(
          segment,
          RED_COLOR_SEGMENT_PACKED,
        );
      }
      for (const segment of multicutState.blueSegments) {
        displayState.tempSegmentStatedColors2d.value.set(
          segment,
          BLUE_COLOR_SEGMENT_PACKED,
        );
      }

      displayState.useTempSegmentStatedColors2d.value = true;
    };

    updateMulticutDisplay();

    activation.registerDisposer(
      multicutState.changed.add(updateMulticutDisplay),
    );

    activation.bindAction("swap-group", (event) => {
      event.stopPropagation();
      multicutState.swapGroup();
    });

    activation.bindAction("set-anchor", (event) => {
      event.stopPropagation();
      const currentSegmentSelection = maybeGetSelection(
        this,
        segmentationGroupState.visibleSegments,
      );
      if (!currentSegmentSelection) return;
      const { rootId, segmentId } = currentSegmentSelection;
      const { focusSegment, segments } = multicutState;
      if (focusSegment.value === undefined) {
        focusSegment.value = rootId.clone();
      }
      if (!Uint64.equal(focusSegment.value, rootId)) {
        StatusMessage.showTemporaryMessage(
          `The selected supervoxel has root segment ${rootId.toString()}, but the supervoxels already selected have root ${focusSegment.value.toString()}`,
          12000,
        );
        return;
      }
      const isRoot = Uint64.equal(rootId, segmentId);
      if (!isRoot) {
        for (const segment of segments) {
          if (Uint64.equal(segment, segmentId)) {
            StatusMessage.showTemporaryMessage(
              `Supervoxel ${segmentId.toString()} has already been selected`,
              7000,
            );
            return;
          }
        }
      }
      multicutState.activeGroup.add(currentSegmentSelection);
    });

    activation.bindAction("submit", (event) => {
      event.stopPropagation();
      submitAction();
    });
  }

  get description() {
    return `multicut`;
  }
}

const maybeGetSelection = (
  tool: LayerTool<SegmentationUserLayer>,
  visibleSegments: Uint64Set,
): SegmentSelection | undefined => {
  const { layer, mouseState } = tool;
  const {
    segmentSelectionState: { value, baseValue },
  } = layer.displayState;
  if (!baseValue || !value) return;
  if (!visibleSegments.has(value)) {
    StatusMessage.showTemporaryMessage(
      "The selected supervoxel is of an unselected segment",
      7000,
    );
    return;
  }
  const point = getPoint(layer, mouseState);
  if (point === undefined) return;
  return {
    rootId: value.clone(),
    segmentId: baseValue.clone(),
    position: point,
  };
};

const wait = (t: number) => {
  return new Promise((f, _r) => {
    setTimeout(f, t);
  });
};

interface MergeSubmission {
  id: string;
  locked: boolean;
  error?: string;
  status?: string;
  sink: SegmentSelection;
  source?: SegmentSelection;
  mergedRoot?: Uint64;
}

export class MergeSegmentsPlaceLineTool extends PlaceLineTool {
  getBaseSegment = true;
  constructor(
    layer: SegmentationUserLayer,
    private annotationState: AnnotationLayerState,
  ) {
    super(layer, {});
    const { inProgressAnnotation } = this;
    const { displayState } = annotationState;
    if (!displayState) return; // TODO, this happens when reloading the page when a toggle tool is up
    const { disablePicking } = displayState;
    this.registerDisposer(
      inProgressAnnotation.changed.add(() => {
        disablePicking.value = inProgressAnnotation.value !== undefined;
      }),
    );
  }
  get annotationLayer() {
    return this.annotationState;
  }
  get description() {
    return `merge line`;
  }
  toJSON() {
    return ANNOTATE_MERGE_LINE_TOOL_ID;
  }
}

function lineToSubmission(line: Line, pending: boolean): MergeSubmission {
  const relatedSegments = line.relatedSegments![0];
  const res: MergeSubmission = {
    id: line.id,
    locked: false,
    sink: {
      position: line.pointA.slice(),
      rootId: relatedSegments[0].clone(),
      segmentId: relatedSegments[1].clone(),
    },
  };
  if (!pending) {
    res.source = {
      position: line.pointB.slice(),
      rootId: relatedSegments[2].clone(),
      segmentId: relatedSegments[3].clone(),
    };
  }
  return res;
}

function mergeToLine(submission: MergeSubmission): Line {
  const { sink, source } = submission;
  const res: Line = {
    id: submission.id,
    type: AnnotationType.LINE,
    pointA: sink.position.slice(),
    pointB: source!.position.slice(),
    relatedSegments: [
      [
        sink.rootId.clone(),
        sink.segmentId.clone(),
        source!.rootId.clone(),
        source!.segmentId.clone(),
      ],
    ],
    properties: [],
  };
  return res;
}

const MAX_MERGE_COUNT = 10;

const MERGE_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+enter": { action: "submit" },
});

class MergeSegmentsTool extends LayerTool<SegmentationUserLayer> {
  activate(activation: ToolActivation<this>) {
    const {
      graphConnection: { value: graphConnection },
      tool,
    } = this.layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection))
      return;
    const {
      state: { mergeState },
    } = graphConnection;
    if (mergeState === undefined) return;
    const { merges, autoSubmit } = mergeState;

    const lineTool = new MergeSegmentsPlaceLineTool(
      this.layer,
      graphConnection.mergeAnnotationState,
    );
    tool.value = lineTool;
    activation.registerDisposer(() => {
      tool.value = undefined;
    });
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Merge segments";
    body.classList.add("graphene-tool-status", "graphene-merge-segments");
    activation.bindInputEventMap(MERGE_SEGMENTS_INPUT_EVENT_MAP);
    const submitAction = async () => {
      if (merges.value.filter((x) => x.locked).length) return;
      submitIcon.classList.toggle("disabled", true);
      await graphConnection.bulkMerge(merges.value);
      submitIcon.classList.toggle("disabled", false);
    };
    const submitIcon = makeIcon({
      text: "Submit",
      title: "Submit merge",
      onClick: async () => {
        submitAction();
      },
    });
    body.appendChild(submitIcon);
    activation.bindAction("submit", async (event) => {
      event.stopPropagation();
      submitAction();
    });
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear pending merges",
        onClick: () => {
          merges.value = [];
        },
      }),
    );
    const checkbox = activation.registerDisposer(
      new TrackableBooleanCheckbox(autoSubmit),
    );
    const label = document.createElement("label");
    label.appendChild(document.createTextNode("auto-submit"));
    label.title = "auto-submit merges";
    label.appendChild(checkbox.element);
    body.appendChild(label);
    const points = document.createElement("div");
    points.classList.add("graphene-merge-segments-merges");
    body.appendChild(points);

    const segmentWidgetFactory = SegmentWidgetFactory.make(
      this.layer.displayState,
      /*includeUnmapped=*/ true,
    );
    const makeWidget = (id: Uint64MapEntry) => {
      const row = segmentWidgetFactory.getWithNormalizedId(id);
      row.classList.add("neuroglancer-segment-list-entry-double-line");
      return row;
    };

    const createPointElement = (id: Uint64) => {
      const containerEl = document.createElement("div");
      containerEl.classList.add("graphene-merge-segments-point");
      const widget = makeWidget(augmentSegmentId(this.layer.displayState, id));
      containerEl.appendChild(widget);
      return containerEl;
    };

    const createSubmissionElement = (submission: MergeSubmission) => {
      const containerEl = document.createElement("div");
      containerEl.classList.add("graphene-merge-segments-submission");
      containerEl.appendChild(createPointElement(submission.sink.rootId));
      if (submission.source) {
        containerEl.appendChild(document.createElement("div")).textContent =
          "ꕹ";
        containerEl.appendChild(createPointElement(submission.source.rootId));
      }
      if (!submission.locked) {
        containerEl.appendChild(
          makeDeleteButton({
            title: "Delete merge",
            onClick: (event) => {
              event.stopPropagation();
              event.preventDefault();
              graphConnection.deleteMergeSubmission(submission);
            },
          }),
        );
      }
      if (submission.status) {
        const statusEl = document.createElement("div");
        statusEl.classList.add("graphene-merge-segments-submission-status");
        statusEl.textContent = submission.status;
        containerEl.appendChild(statusEl);
      }
      return containerEl;
    };

    const updateUI = () => {
      while (points.firstChild) {
        points.removeChild(points.firstChild);
      }
      for (const submission of merges.value) {
        points.appendChild(createSubmissionElement(submission));
      }
    };
    activation.registerDisposer(merges.changed.add(updateUI));
    updateUI();
  }

  toJSON() {
    return GRAPHENE_MERGE_SEGMENTS_TOOL_ID;
  }

  get description() {
    return `merge segments`;
  }
}

const FIND_PATH_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+enter": { action: "submit" },
  escape: { action: "clearPath" },
  "at:shift?+control+mousedown0": { action: "add-point" },
});

class FindPathTool extends LayerTool<SegmentationUserLayer> {
  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection))
      return;
    const {
      state: { findPathState },
      findPathAnnotationState,
    } = graphConnection;
    const { source, target, precisionMode } = findPathState;
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState =
      this.layer.displayState.segmentationGroupState.value;
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Find Path";
    body.classList.add("graphene-tool-status", "graphene-find-path");
    const submitAction = () => {
      findPathState.triggerPathUpdate.dispatch();
    };
    const clearPath = () => {
      findPathState.source.reset();
      findPathState.target.reset();
      findPathState.centroids.reset();
    };
    body.appendChild(
      makeIcon({
        text: "Submit",
        title: "Submit Find Path",
        onClick: () => {
          submitAction();
        },
      }),
    );
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear Find Path",
        onClick: clearPath,
      }),
    );
    const checkbox = activation.registerDisposer(
      new TrackableBooleanCheckbox(precisionMode),
    );
    const label = document.createElement("label");
    const labelText = document.createElement("span");
    labelText.textContent = "Precision mode: ";
    label.appendChild(labelText);
    label.title =
      "Precision mode returns a more accurate path, but takes longer.";
    label.appendChild(checkbox.element);
    body.appendChild(label);
    const annotationElements = document.createElement("div");
    annotationElements.classList.add("find-path-annotations");
    body.appendChild(annotationElements);
    const bindings = getDefaultAnnotationListBindings();
    this.registerDisposer(new MouseEventBinder(annotationElements, bindings));
    const updateAnnotationElements = () => {
      removeChildren(annotationElements);
      const maxColumnWidths = [0, 0, 0];
      const globalDimensionIndices = [0, 1, 2];
      const localDimensionIndices: number[] = [];
      const template =
        "[symbol] 2ch [dim] var(--neuroglancer-column-0-width) [dim] var(--neuroglancer-column-1-width) [dim] var(--neuroglancer-column-2-width) [delete] min-content";
      const endpoints = [source, target];
      const endpointAnnotations = endpoints
        .map((x) => x.value?.annotationReference?.value)
        .filter((x) => x) as Annotation[];
      for (const annotation of endpointAnnotations) {
        const [element, elementColumnWidths] = makeAnnotationListElement(
          this.layer,
          annotation,
          findPathAnnotationState,
          template,
          globalDimensionIndices,
          localDimensionIndices,
        );
        for (const [column, width] of elementColumnWidths.entries()) {
          maxColumnWidths[column] = width;
        }
        annotationElements.appendChild(element);
      }
      for (const [column, width] of maxColumnWidths.entries()) {
        annotationElements.style.setProperty(
          `--neuroglancer-column-${column}-width`,
          `${width + 2}ch`,
        );
      }
    };
    findPathState.changed.add(updateAnnotationElements);
    updateAnnotationElements();
    activation.bindInputEventMap(FIND_PATH_INPUT_EVENT_MAP);
    activation.bindAction("submit", (event) => {
      event.stopPropagation();
      submitAction();
    });
    activation.bindAction("add-point", (event) => {
      event.stopPropagation();
      (async () => {
        if (source.value && target.value) {
          clearPath();
        }
        if (!source.value) {
          // first selection
          const selection = maybeGetSelection(
            this,
            segmentationGroupState.visibleSegments,
          );
          if (selection) {
            source.value = selection;
          }
        } else if (!target.value) {
          const selection = maybeGetSelection(
            this,
            segmentationGroupState.visibleSegments,
          );
          if (selection) {
            target.value = selection;
          }
        }
      })();
    });
    activation.bindAction("clearPath", clearPath);
  }

  toJSON() {
    return GRAPHENE_FIND_PATH_TOOL_ID;
  }

  get description() {
    return `find path`;
  }
}

registerTool(
  SegmentationUserLayer,
  GRAPHENE_MULTICUT_SEGMENTS_TOOL_ID,
  (layer) => {
    return new MulticutSegmentsTool(layer, true);
  },
);

registerTool(
  SegmentationUserLayer,
  GRAPHENE_MERGE_SEGMENTS_TOOL_ID,
  (layer) => {
    return new MergeSegmentsTool(layer, true);
  },
);

registerTool(SegmentationUserLayer, GRAPHENE_FIND_PATH_TOOL_ID, (layer) => {
  return new FindPathTool(layer, true);
});

const ANNOTATE_MERGE_LINE_TOOL_ID = "annotateMergeLine";

registerLegacyTool(
  ANNOTATE_MERGE_LINE_TOOL_ID,
  (layer, options) =>
    new MergeSegmentsPlaceLineTool(<SegmentationUserLayer>layer, options),
);
