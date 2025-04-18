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
import { debounce } from "lodash-es";
import {
  AnnotationDisplayState,
  AnnotationLayerState,
} from "#src/annotation/annotation_layer_state.js";
import type {
  AnnotationReference,
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
import type {
  ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface,
  ChunkedGraphChunkSpecification,
  HttpSource,
  MultiscaleMeshMetadata,
} from "#src/datasource/graphene/base.js";
import {
  parseGrapheneError,
  CHUNKED_GRAPH_LAYER_RPC_ID,
  CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  ChunkedGraphSourceParameters,
  getGrapheneFragmentKey,
  GRAPHENE_MESH_NEW_SEGMENT_RPC_ID,
  isBaseSegmentId,
  makeChunkedGraphChunkSpecification,
  MeshSourceParameters,
  PYCG_APP_VERSION,
  getHttpSource,
} from "#src/datasource/graphene/base.js";
import type {
  DataSource,
  DataSourceLookupResult,
  DataSubsourceEntry,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import type { ShardingParameters } from "#src/datasource/precomputed/base.js";
import {
  DataEncoding,
  ShardingHashFunction,
} from "#src/datasource/precomputed/base.js";
import type { MultiscaleVolumeInfo } from "#src/datasource/precomputed/frontend.js";
import {
  getSegmentPropertyMap,
  parseMultiscaleVolumeInfo,
  PrecomputedMultiscaleVolumeChunkSource,
} from "#src/datasource/precomputed/frontend.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  ensureEmptyUrlSuffix,
  kvstoreEnsureDirectoryPipelineUrl,
  pipelineUrlJoin,
} from "#src/kvstore/url.js";
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
} from "#src/ui/annotations.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  makeToolButton,
  registerLegacyTool,
  registerTool,
} from "#src/ui/tool.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { packColor } from "#src/util/color.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ValueOrError } from "#src/util/error.js";
import { makeValueOrError, valueOrThrow } from "#src/util/error.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { mat4, vec3, vec4 } from "#src/util/geom.js";
import { HttpError, isNotFoundError } from "#src/util/http_request.js";
import {
  parseArray,
  parseFixedLengthArray,
  parseUint64,
  verify3dVec,
  verifyBoolean,
  verifyEnumString,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyInt,
  verifyNonnegativeInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyOptionalString,
  verifyPositiveInt,
  verifyString,
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
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
const RED_COLOR_SEGMENT_PACKED = BigInt(packColor(RED_COLOR_SEGMENT));
const BLUE_COLOR_SEGMENT_PACKED = BigInt(packColor(BLUE_COLOR_SEGMENT));
const TRANSPARENT_COLOR_PACKED = BigInt(packColor(TRANSPARENT_COLOR));
const MULTICUT_OFF_COLOR = vec4.fromValues(0, 0, 0, 0.5);

class GrapheneMeshSource extends WithParameters(
  WithSharedKvStoreContext(MeshSource),
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
  supported_api_versions: number[];
  constructor(infoUrl: string, obj: any) {
    // .../1.0/... is the legacy link style
    // .../table/... is the current, version agnostic link style (for retrieving the info file)
    const linkStyle =
      /^((?:middleauth\+)?https?:\/\/[.\w:\-/]+)\/segmentation\/(?:1\.0|table)\/([^/]+)\/?$/;
    const match = infoUrl.match(linkStyle);
    if (match === null) {
      throw Error(`Graph URL invalid: ${infoUrl}`);
    }
    this.segmentationUrl = `${match[1]}/segmentation/api/v${PYCG_APP_VERSION}/table/${match[2]}`;
    this.meshingUrl = `${match[1]}/meshing/api/v${PYCG_APP_VERSION}/table/${match[2]}`;

    try {
      verifyObject(obj);
      this.supported_api_versions = verifyObjectProperty(
        obj,
        "supported_api_versions",
        (x) => parseArray(x, verifyNonnegativeInt),
      );
    } catch {
      // Dealing with a prehistoric graph server with no version information
      this.supported_api_versions = [0];
    }
    if (this.supported_api_versions.includes(PYCG_APP_VERSION) === false) {
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
): GrapheneMultiscaleVolumeInfo {
  const volumeInfo = parseMultiscaleVolumeInfo(obj);
  const dataUrl = verifyObjectProperty(obj, "data_dir", verifyString);
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
    sharedKvStoreContext: SharedKvStoreContext,
    public info: GrapheneMultiscaleVolumeInfo,
  ) {
    super(sharedKvStoreContext, info.dataUrl, info);
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
          sharedKvStoreContext: this.sharedKvStoreContext,
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
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<ParsedMeshMetadata> {
  let metadata: any;
  try {
    metadata = await getJsonMetadata(
      sharedKvStoreContext,
      url,
      /*required=*/ false,
      options,
    );
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
  sharedKvStoreContext: SharedKvStoreContext,
  parameters: MeshSourceParameters,
) {
  return sharedKvStoreContext.chunkManager.getChunkSource(GrapheneMeshSource, {
    sharedKvStoreContext,
    parameters,
  });
}

async function getMeshSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  fragmentUrl: string,
  nBitsForLayerId: number,
  options: ProgressOptions,
) {
  const { metadata, segmentPropertyMap } = await getMeshMetadata(
    sharedKvStoreContext,
    fragmentUrl,
    options,
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
    source: getShardedMeshSource(sharedKvStoreContext, parameters),
    transform,
    segmentPropertyMap,
  };
}

export function getJsonMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  required: boolean,
  options: Partial<ProgressOptions>,
): Promise<any> {
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    {
      type: "precomputed:metadata",
      url,
    },
    options,
    async (options) => {
      const infoUrl = pipelineUrlJoin(url, "info");
      using _span = new ProgressSpan(options.progressListener, {
        message: `Reading graphene metadata from ${infoUrl}`,
      });
      const response = await sharedKvStoreContext.kvStoreContext.read(infoUrl, {
        ...options,
        throwIfMissing: required,
      });
      if (response === undefined) return undefined;
      return await response.response.json();
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
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  metadata: any,
  options: ProgressOptions,
  stateJson: any,
): Promise<DataSource> {
  const info = parseGrapheneMultiscaleVolumeInfo(metadata, url);
  const volume = new GrapheneMultiscaleVolumeChunkSource(
    sharedKvStoreContext,
    info,
  );
  const state = new GrapheneState();
  if (stateJson) {
    state.restoreState(stateJson);
  }
  const segmentationGraph = new GrapheneGraphSource(info, volume, state);
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
    const mapUrl = kvstoreEnsureDirectoryPipelineUrl(
      sharedKvStoreContext.kvStoreContext.resolveRelativePath(
        url,
        info.segmentPropertyMap,
      ),
    );
    const metadata = await getJsonMetadata(
      sharedKvStoreContext,
      mapUrl,
      /*required=*/ true,
      options,
    );
    const segmentPropertyMap = getSegmentPropertyMap(metadata);
    subsources.push({
      id: "properties",
      default: true,
      subsource: { segmentPropertyMap },
    });
  }
  if (info.mesh !== undefined) {
    const { source: meshSource, transform } = await getMeshSource(
      sharedKvStoreContext,
      info.app!.meshingUrl,
      kvstoreEnsureDirectoryPipelineUrl(
        sharedKvStoreContext.kvStoreContext.resolveRelativePath(
          info.dataUrl,
          info.mesh,
        ),
      ),
      info.graph.nBitsForLayerId,
      options,
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

// Note: Graphene is not really a kvstore-based data source, since it relies on
// making arbitrary HTTP requests rather than just kvstore. It fails if the
// provided kvstore does not inherit from HttpKvStore.
export class GrapheneDataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "graphene";
  }
  get description() {
    return "Graphene data source";
  }

  get(
    options: GetKvStoreBasedDataSourceOptions,
  ): Promise<DataSourceLookupResult> {
    ensureEmptyUrlSuffix(options.url);
    const url = kvstoreEnsureDirectoryPipelineUrl(options.kvStoreUrl);
    return options.registry.chunkManager.memoize.getAsync(
      { type: "graphene:get", url },
      options,
      async (progressOptions) => {
        const metadata = await getJsonMetadata(
          options.registry.sharedKvStoreContext,
          url,
          /*required=*/ true,
          progressOptions,
        );
        verifyObject(metadata);
        const redirect = verifyOptionalObjectProperty(
          metadata,
          "redirect",
          verifyString,
        );
        const canonicalUrl = `${options.url.scheme}://${url}`;
        if (redirect !== undefined) {
          return { canonicalUrl, targetUrl: redirect };
        }
        const t = verifyOptionalObjectProperty(metadata, "@type", verifyString);
        switch (t) {
          case "neuroglancer_multiscale_volume":
          case undefined: {
            const dataSource = await getVolumeDataSource(
              options.registry.sharedKvStoreContext,
              url,
              metadata,
              progressOptions,
              options.state,
            );
            dataSource.canonicalUrl = canonicalUrl;
            return dataSource;
          }
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
  return verifyOptionalObjectProperty(obj, key, parseUint64);
}

function getUint64(obj: any, key: string) {
  return verifyObjectProperty(obj, key, parseUint64);
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

const ID_JSON_KEY = "id";
const ERROR_JSON_KEY = "error";
const MULTICUT_JSON_KEY = "multicut";
const FOCUS_SEGMENT_JSON_KEY = "focusSegment";
const SINKS_JSON_KEY = "sinks";
const SOURCES_JSON_KEY = "sources";
const SEGMENT_ID_JSON_KEY = "segmentId";
const ROOT_ID_JSON_KEY = "rootId";
const POSITION_JSON_KEY = "position";
const MERGE_JSON_KEY = "merge";
const MERGES_JSON_KEY = "merges";
const AUTOSUBMIT_JSON_KEY = "autosubmit";
const SINK_JSON_KEY = "sink";
const SOURCE_JSON_KEY = "source";
const MERGED_ROOT_JSON_KEY = "mergedRoot";
const LOCKED_JSON_KEY = "locked";

class GrapheneState implements Trackable {
  changed = new NullarySignal();

  public multicutState = new MulticutState();
  public mergeState = new MergeState();

  constructor() {
    this.multicutState.changed.add(() => {
      this.changed.dispatch();
    });
    this.mergeState.changed.add(() => {
      this.changed.dispatch();
    });
  }

  reset() {
    this.multicutState.reset();
    this.mergeState.reset();
  }

  toJSON() {
    return {
      [MULTICUT_JSON_KEY]: this.multicutState.toJSON(),
      [MERGE_JSON_KEY]: this.mergeState.toJSON(),
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, MULTICUT_JSON_KEY, (value) => {
      this.multicutState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, MERGE_JSON_KEY, (value) => {
      this.mergeState.restoreState(value);
    });
  }
}

export interface SegmentSelection {
  segmentId: bigint;
  rootId: bigint;
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

  reset() {
    this.merges.value = [];
    this.autoSubmit.reset();
  }

  toJSON() {
    const { merges, autoSubmit } = this;

    const segmentSelectionToJSON = (x: SegmentSelection) => {
      return {
        [SEGMENT_ID_JSON_KEY]: x.segmentId.toString(),
        [ROOT_ID_JSON_KEY]: x.rootId.toString(),
        [POSITION_JSON_KEY]: [...x.position],
      };
    };

    const mergeToJSON = (x: MergeSubmission) => {
      const res: any = {
        [ID_JSON_KEY]: x.id,
        [LOCKED_JSON_KEY]: x.locked,
        [SINK_JSON_KEY]: segmentSelectionToJSON(x.sink),
        [SOURCE_JSON_KEY]: segmentSelectionToJSON(x.source!),
      };

      if (x.mergedRoot) {
        res[MERGED_ROOT_JSON_KEY] = x.mergedRoot.toString();
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
      const locked = false; // TODO(chrisj) verifyObjectProperty(obj, LOCKED_JSON_KEY, verifyBoolean);
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

class MulticutState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  sinks = new WatchableSet<SegmentSelection>();
  sources = new WatchableSet<SegmentSelection>();

  constructor(
    public focusSegment = new TrackableValue<bigint | undefined>(
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

  reset() {
    this.focusSegment.value = undefined;
    this.blueGroup.value = false;
    this.sinks.clear();
    this.sources.clear();
  }

  toJSON() {
    const { focusSegment, sinks, sources } = this;

    const segmentSelectionToJSON = (x: SegmentSelection) => {
      return {
        [SEGMENT_ID_JSON_KEY]: x.segmentId.toString(),
        [ROOT_ID_JSON_KEY]: x.rootId.toString(),
        [POSITION_JSON_KEY]: [...x.position],
      };
    };

    return {
      [FOCUS_SEGMENT_JSON_KEY]: focusSegment.toJSON()?.toString(),
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
      this.focusSegment.restoreState(parseUint64(value));
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
      .filter((x) => x.segmentId !== x.rootId)
      .map((x) => x.segmentId);
  }

  get blueSegments() {
    return [...this.sources]
      .filter((x) => x.segmentId !== x.rootId)
      .map((x) => x.segmentId);
  }
}

class GraphConnection extends SegmentationGraphSourceConnection {
  public annotationLayerStates: AnnotationLayerState[] = [];
  public mergeAnnotationState: AnnotationLayerState;

  constructor(
    public graph: GrapheneGraphSource,
    private layer: SegmentationUserLayer,
    private chunkSource: GrapheneMultiscaleVolumeChunkSource,
    public state: GrapheneState,
  ) {
    super(graph, layer.displayState.segmentationGroupState.value);
    const segmentsState = layer.displayState.segmentationGroupState.value;
    segmentsState.selectedSegments.changed.add(
      (segmentIds: bigint[] | bigint | null, add: boolean) => {
        if (segmentIds !== null) {
          segmentIds =
            typeof segmentIds === "bigint" ? [segmentIds] : segmentIds;
        }
        this.selectedSegmentsChanged(segmentIds, add);
      },
    );

    segmentsState.visibleSegments.changed.add(
      (segmentIds: bigint[] | bigint | null, add: boolean) => {
        if (segmentIds !== null) {
          segmentIds =
            typeof segmentIds === "bigint" ? [segmentIds] : segmentIds;
        }
        this.visibleSegmentsChanged(segmentIds, add);
      },
    );

    const {
      annotationLayerStates,
      state: { multicutState },
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
      mergeAnnotationState.source.childAdded.add((x) => {
        const annotation = x as Line;
        const relatedSegments = annotation.relatedSegments![0];
        const visibles = Array.from(relatedSegments, (x) =>
          visibleSegments.has(x),
        );
        if (visibles[0] === false) {
          setTimeout(() => {
            const { tool } = layer;
            if (tool.value instanceof MergeSegmentsPlaceLineTool) {
              tool.value.deactivate();
            }
          }, 0);
          StatusMessage.showTemporaryMessage("Cannot merge a hidden segment.");
        } else if (merges.value.length < MAX_MERGE_COUNT) {
          merges.value = [...merges.value, lineToSubmission(annotation, true)];
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
      });

      mergeAnnotationState.source.childCommitted.add((x) => {
        const ref = mergeAnnotationState.source.getReference(x);
        const annotation = ref.value as Line | undefined;
        if (annotation) {
          const relatedSegments = annotation.relatedSegments![0];
          const visibles = Array.from(relatedSegments, (x) =>
            visibleSegments.has(x),
          );
          if (relatedSegments.length < 4) {
            mergeAnnotationState.source.delete(ref);
            StatusMessage.showTemporaryMessage(
              "Cannot merge segment with itself.",
            );
          }
          if (visibles[2] === false) {
            mergeAnnotationState.source.delete(ref);
            StatusMessage.showTemporaryMessage(
              "Cannot merge a hidden segment.",
            );
          }
          const existingSubmission = merges.value.find((x) => x.id === ref.id);
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
      });

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
      });
    }
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

  private visibleSegmentsChanged(segments: bigint[] | null, added: boolean) {
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
        segments = segments.filter((segment) => segment !== focusSegment);
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

  private selectedSegmentsChanged(segments: bigint[] | null, added: boolean) {
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
      if (added && isBaseSegment) {
        this.graph.getRoot(segmentId).then((rootId) => {
          if (segmentsState.visibleSegments.has(segmentId)) {
            segmentsState.visibleSegments.add(rootId);
          }
          segmentsState.selectedSegments.delete(segmentId);
          segmentsState.selectedSegments.add(rootId);
        });
      }
    }
  }

  computeSplit(include: bigint, exclude: bigint): ComputedSplit | undefined {
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
        if (graphSubsource?.subsource.segmentationGraph) {
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

  meshAddNewSegments(segments: bigint[]) {
    const meshSource = this.getMeshSource();
    if (meshSource) {
      for (const segment of segments) {
        meshSource.rpc!.invoke(GRAPHENE_MESH_NEW_SEGMENT_RPC_ID, {
          rpcId: meshSource.rpcId!,
          segment,
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
    }
    const splitRoots = await this.graph.graphServer.splitSegments(
      [...sinks],
      [...sources],
      annotationToNanometers,
    );
    if (splitRoots.length === 0) {
      StatusMessage.showTemporaryMessage("No split found.", 3000);
      return false;
    }
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
    return true;
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
  ): Promise<bigint> => {
    this.graph;
    const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
    const annotationToNanometers =
      loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
        (x) => x / 1e-9,
      );
    submission.error = undefined;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await this.graph.graphServer.mergeSegments(
          submission.sink,
          submission.source!,
          annotationToNanometers,
        );
      } catch (err) {
        if (i === attempts) {
          submission.error = err.message || "unknown";
          throw err;
        }
      }
    }

    return 0n; // appease typescript
  };

  async bulkMerge(submissions: MergeSubmission[]) {
    const { merges } = this.state.mergeState;
    const bulkMergeHelper = (
      submissions: MergeSubmission[],
    ): Promise<bigint[]> => {
      return new Promise((f) => {
        if (submissions.length === 0) {
          f([]);
          return;
        }
        const segmentsToRemove: bigint[] = [];
        const replaceSegment = (a: bigint, b: bigint) => {
          segmentsToRemove.push(a);
          for (const submission of submissions) {
            if (submission.source && submission.source.rootId === a) {
              submission.source.rootId = b;
            }
            if (submission.sink.rootId === a) {
              submission.sink.rootId = b;
            }
          }
        };
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
            this.submitMerge(submission, 3)
              .then((mergedRoot) => {
                replaceSegment(submission.source!.rootId, mergedRoot);
                replaceSegment(submission.sink.rootId, mergedRoot);
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
    const segmentsToAdd: bigint[] = [];
    for (const submission of submissions) {
      if (submission.error) {
        submission.locked = false;
        submission.status = submission.error;
      } else if (submission.mergedRoot) {
        segmentsToAdd.push(submission.mergedRoot);
      }
    }
    const latestRoots =
      await this.graph.graphServer.filterLatestRoots(segmentsToAdd);
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    const { visibleSegments, selectedSegments } = segmentsState;
    selectedSegments.delete(segmentsToRemove);
    this.meshAddNewSegments(latestRoots);
    selectedSegments.add(latestRoots);
    visibleSegments.add(latestRoots);
    merges.changed.dispatch();
  }
}

async function withErrorMessageHTTP<T>(
  promise: Promise<T>,
  options: {
    initialMessage?: string;
    errorPrefix: string;
  },
): Promise<T> {
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
      const msg = await parseGrapheneError(e);
      if (msg) {
        if (!status) {
          status = new StatusMessage(true);
        }
        status.setErrorMessage(errorPrefix + msg);
        status.setVisible(true);
        throw new Error(`[${e.response.status}] ${errorPrefix}${msg}`);
      }
    }
    throw e;
  }
}

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol("Graph Server Not Specified.");

class GrapheneGraphServerInterface {
  private httpSource: HttpSource;
  constructor(sharedKvStoreContext: SharedKvStoreContext, url: string) {
    this.httpSource = getHttpSource(sharedKvStoreContext.kvStoreContext, url);
  }

  async getRoot(segment: bigint, timestamp = "") {
    const timestampEpoch = new Date(timestamp).valueOf() / 1000;

    const { fetchOkImpl, baseUrl } = this.httpSource;

    const jsonResp = await withErrorMessageHTTP(
      fetchOkImpl(
        `${baseUrl}/node/${String(segment)}/root?int64_as_str=1${
          Number.isNaN(timestampEpoch) ? "" : `&timestamp=${timestampEpoch}`
        }`,
        {},
      ).then((response) => response.json()),
      {
        initialMessage: `Retrieving root for segment ${segment}`,
        errorPrefix: "Could not fetch root: ",
      },
    );
    return parseUint64(jsonResp.root_id);
  }

  async mergeSegments(
    first: SegmentSelection,
    second: SegmentSelection,
    annotationToNanometers: Float64Array,
  ): Promise<bigint> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(`${baseUrl}/merge?int64_as_str=1`, {
      method: "POST",
      body: JSON.stringify([
        [
          String(first.segmentId),
          ...first.position.map((val, i) => val * annotationToNanometers[i]),
        ],
        [
          String(second.segmentId),
          ...second.position.map((val, i) => val * annotationToNanometers[i]),
        ],
      ]),
    });

    try {
      const response = await promise;
      const jsonResp = await response.json();
      return parseUint64(jsonResp.new_root_ids[0]);
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
    annotationToNanometers: Float64Array,
  ): Promise<bigint[]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(`${baseUrl}/split?int64_as_str=1`, {
      method: "POST",
      body: JSON.stringify({
        sources: first.map((x) => [
          String(x.segmentId),
          ...x.position.map((val, i) => val * annotationToNanometers[i]),
        ]),
        sinks: second.map((x) => [
          String(x.segmentId),
          ...x.position.map((val, i) => val * annotationToNanometers[i]),
        ]),
      }),
    });

    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Splitting ${first.length} sources from ${second.length} sinks`,
      errorPrefix: "Split failed: ",
    });
    const jsonResp = await response.json();
    const final: bigint[] = new Array(jsonResp.new_root_ids.length);
    for (let i = 0; i < final.length; ++i) {
      final[i] = parseUint64(jsonResp.new_root_ids[i]);
    }
    return final;
  }

  async filterLatestRoots(segments: bigint[]): Promise<bigint[]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const url = `${baseUrl}/is_latest_roots`;

    const promise = fetchOkImpl(url, {
      method: "POST",
      body: JSON.stringify({
        node_ids: segments.map((x) => x.toString()),
      }),
    });

    const jsonResp = await withErrorMessageHTTP(
      promise.then((response) => response.json()),
      {
        errorPrefix: "Could not check latest: ",
      },
    );

    const res: bigint[] = [];
    for (const [i, isLatest] of jsonResp.is_latest.entries()) {
      if (isLatest) {
        res.push(segments[i]);
      }
    }
    return res;
  }
}

class GrapheneGraphSource extends SegmentationGraphSource {
  private connections = new Set<GraphConnection>();
  public graphServer: GrapheneGraphServerInterface;

  constructor(
    public info: GrapheneMultiscaleVolumeInfo,
    private chunkSource: GrapheneMultiscaleVolumeChunkSource,
    public state: GrapheneState,
  ) {
    super();
    this.graphServer = new GrapheneGraphServerInterface(
      chunkSource.sharedKvStoreContext,
      info.app!.segmentationUrl,
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

  getRoot(segment: bigint) {
    return this.graphServer.getRoot(segment);
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

  async merge(a: bigint, b: bigint): Promise<bigint> {
    a;
    b;
    return 0n;
  }

  async split(
    include: bigint,
    exclude: bigint,
  ): Promise<{ include: bigint; exclude: bigint }> {
    return { include, exclude };
  }

  trackSegment(id: bigint, callback: (id: bigint | null) => void): () => void {
    return () => {
      console.log("trackSegment... do nothing", id, callback);
    };
  }
}

class ChunkedGraphChunkSource
  extends SliceViewChunkSource
  implements ChunkedGraphChunkSourceInterface
{
  declare spec: ChunkedGraphChunkSpecification;
  declare OPTIONS: { spec: ChunkedGraphChunkSpecification };
}

class GrapheneChunkedGraphChunkSource extends WithParameters(
  WithSharedKvStoreContext(ChunkedGraphChunkSource),
  ChunkedGraphSourceParameters,
) {}

type ChunkedGraphLayerDisplayState = SegmentationDisplayState3D;

type TransformedChunkedGraphSource = FrontendTransformedSource<
  SliceViewRenderLayer,
  ChunkedGraphChunkSource
>;

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

class MulticutAnnotationLayerView extends AnnotationLayerView {
  declare private _annotationStates: MergedAnnotationStates;
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

  const addSelection = (selection: SegmentSelection) => {
    const annotation: Point = {
      id: "",
      point: selection.position,
      type: AnnotationType.POINT,
      properties: [],
      relatedSegments: [
        BigUint64Array.of(selection.segmentId, selection.rootId),
      ],
    };
    const ref = annotationSource.add(annotation);
    selection.annotationReference = ref;
  };

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
    body.classList.add("graphene-multicut-status");
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
      // add focus segment and red/blue segments
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
    activation.registerDisposer(
      segmentationGroupState.segmentEquivalences.changed.add(
        debounce(() => updateMulticutDisplay(), 0),
      ),
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
        focusSegment.value = rootId;
      }
      if (focusSegment.value !== rootId) {
        StatusMessage.showTemporaryMessage(
          `The selected supervoxel has root segment ${rootId}, but the supervoxels already selected have root ${focusSegment.value}`,
          12000,
        );
        return;
      }
      const isRoot = rootId === segmentId;
      if (!isRoot) {
        for (const segment of segments) {
          if (segment === segmentId) {
            StatusMessage.showTemporaryMessage(
              `Supervoxel ${segmentId} has already been selected`,
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
    return "multicut";
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
    rootId: value,
    segmentId: baseValue,
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
  mergedRoot?: bigint;
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
    return "merge line";
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
      rootId: relatedSegments[0],
      segmentId: relatedSegments[1],
    },
  };
  if (!pending) {
    res.source = {
      position: line.pointB.slice(),
      rootId: relatedSegments[2],
      segmentId: relatedSegments[3],
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
      BigUint64Array.of(
        sink.rootId,
        sink.segmentId,
        source!.rootId,
        source!.segmentId,
      ),
    ],
    properties: [],
  };
  return res;
}

const MAX_MERGE_COUNT = 10;

// on error, copy (also clean up error message)

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
    body.classList.add("graphene-merge-segments-status");
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
          lineTool.deactivate();
          for (const merge of merges.value) {
            if (!merge.locked) {
              graphConnection.deleteMergeSubmission(merge);
            }
          }
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

    const createPointElement = (id: bigint) => {
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
    return "merge segments";
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

const ANNOTATE_MERGE_LINE_TOOL_ID = "annotateMergeLine";

registerLegacyTool(
  ANNOTATE_MERGE_LINE_TOOL_ID,
  (layer, options) =>
    new MergeSegmentsPlaceLineTool(<SegmentationUserLayer>layer, options),
);
