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

import type { AnnotationGeometryChunkSpecification } from "#src/annotation/base.js";
import {
  AnnotationGeometryChunkSource,
  MultiscaleAnnotationSource,
} from "#src/annotation/frontend_source.js";
import {
  AnnotationType,
  makeDataBoundsBoundingBoxAnnotationSet,
  parseAnnotationPropertySpecs,
} from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type {
  BoundingBox,
  CoordinateSpace,
} from "#src/coordinate_transform.js";
import {
  coordinateSpaceFromJson,
  emptyValidCoordinateSpace,
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import {
  KvStoreBasedDataSourceLegacyUrlAdapter,
  type ConvertLegacyUrlOptions,
  type DataSource,
  type DataSourceLookupResult,
  type DataSubsourceEntry,
  type GetKvStoreBasedDataSourceOptions,
  type KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import type {
  MultiscaleMeshMetadata,
  ShardingParameters,
  SkeletonMetadata,
} from "#src/datasource/precomputed/base.js";
import {
  AnnotationSourceParameters,
  AnnotationSpatialIndexSourceParameters,
  DataEncoding,
  MeshSourceParameters,
  MultiscaleMeshSourceParameters,
  ShardingHashFunction,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/precomputed/base.js";
import type { AutoDetectRegistry } from "#src/kvstore/auto_detect.js";
import { simpleFilePresenceAutoDetectDirectorySpec } from "#src/kvstore/auto_detect.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { KvStoreContext } from "#src/kvstore/context.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  kvstoreEnsureDirectoryPipelineUrl,
  parseUrlSuffix,
  pipelineUrlJoin,
} from "#src/kvstore/url.js";
import { VertexPositionFormat } from "#src/mesh/base.js";
import { MeshSource, MultiscaleMeshSource } from "#src/mesh/frontend.js";
import type {
  InlineSegmentProperty,
  InlineSegmentPropertyMap,
} from "#src/segmentation_display_state/property_map.js";
import {
  normalizeInlineSegmentPropertyMap,
  SegmentPropertyMap,
} from "#src/segmentation_display_state/property_map.js";
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import { SkeletonSource } from "#src/skeleton/frontend.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import type { TypedNumberArrayConstructor } from "#src/util/array.js";
import { transposeNestedArrays } from "#src/util/array.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR, DataType } from "#src/util/data_type.js";
import { mat4, vec3 } from "#src/util/geom.js";
import {
  parseArray,
  parseFixedLengthArray,
  parseQueryStringParameters,
  unparseQueryStringParameters,
  verifyEnumString,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyOptionalString,
  verifyPositiveInt,
  verifyString,
  verifyStringArray,
  verifyOptionalBoolean,
  parseUint64,
} from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export class PrecomputedVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {}

class PrecomputedMeshSource extends WithParameters(
  WithSharedKvStoreContext(MeshSource),
  MeshSourceParameters,
) {}

class PrecomputedMultiscaleMeshSource extends WithParameters(
  WithSharedKvStoreContext(MultiscaleMeshSource),
  MultiscaleMeshSourceParameters,
) {}

class PrecomputedSkeletonSource extends WithParameters(
  WithSharedKvStoreContext(SkeletonSource),
  SkeletonSourceParameters,
) {
  get skeletonVertexCoordinatesInVoxels() {
    return false;
  }
  get vertexAttributes() {
    return this.parameters.metadata.vertexAttributes;
  }
}

class ScaleInfo {
  key: string;
  encoding: VolumeChunkEncoding;
  resolution: Float64Array;
  voxelOffset: Float32Array;
  size: Float32Array;
  chunkSizes: Uint32Array[];
  compressedSegmentationBlockSize: vec3 | undefined;
  sharding: ShardingParameters | undefined;
  hidden: boolean;
  constructor(obj: any, numChannels: number) {
    verifyObject(obj);
    const rank = numChannels === 1 ? 3 : 4;
    const resolution = (this.resolution = new Float64Array(rank));
    const voxelOffset = (this.voxelOffset = new Float32Array(rank));
    const size = (this.size = new Float32Array(rank));
    if (rank === 4) {
      resolution[3] = 1;
      size[3] = numChannels;
    }
    verifyObjectProperty(obj, "resolution", (x) =>
      parseFixedLengthArray(
        resolution.subarray(0, 3),
        x,
        verifyFinitePositiveFloat,
      ),
    );
    verifyOptionalObjectProperty(obj, "voxel_offset", (x) =>
      parseFixedLengthArray(voxelOffset.subarray(0, 3), x, verifyInt),
    );
    verifyObjectProperty(obj, "size", (x) =>
      parseFixedLengthArray(size.subarray(0, 3), x, verifyPositiveInt),
    );
    this.chunkSizes = verifyObjectProperty(obj, "chunk_sizes", (x) =>
      parseArray(x, (y) => {
        const chunkSize = new Uint32Array(rank);
        if (rank === 4) chunkSize[3] = numChannels;
        parseFixedLengthArray(chunkSize.subarray(0, 3), y, verifyPositiveInt);
        return chunkSize;
      }),
    );
    if (this.chunkSizes.length === 0) {
      throw new Error("No chunk sizes specified.");
    }
    this.sharding = verifyObjectProperty(
      obj,
      "sharding",
      parseShardingParameters,
    );
    if (this.sharding !== undefined && this.chunkSizes.length !== 1) {
      throw new Error("Sharding requires a single chunk size per scale");
    }
    const encoding = (this.encoding = verifyObjectProperty(
      obj,
      "encoding",
      (x) => verifyEnumString(x, VolumeChunkEncoding),
    ));
    if (encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION) {
      this.compressedSegmentationBlockSize = verifyObjectProperty(
        obj,
        "compressed_segmentation_block_size",
        (x) => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt),
      );
    }
    this.key = verifyObjectProperty(obj, "key", verifyString);
    this.hidden =
      verifyObjectProperty(obj, "hidden", verifyOptionalBoolean) ?? false;
  }
}

export interface MultiscaleVolumeInfo {
  dataType: DataType;
  volumeType: VolumeType;
  mesh: string | undefined;
  skeletons: string | undefined;
  segmentPropertyMap: string | undefined;
  scales: ScaleInfo[];
  modelSpace: CoordinateSpace;
}

export function parseMultiscaleVolumeInfo(obj: unknown): MultiscaleVolumeInfo {
  verifyObject(obj);
  const dataType = verifyObjectProperty(obj, "data_type", (x) =>
    verifyEnumString(x, DataType),
  );
  const numChannels = verifyObjectProperty(
    obj,
    "num_channels",
    verifyPositiveInt,
  );
  const volumeType = verifyObjectProperty(obj, "type", (x) =>
    verifyEnumString(x, VolumeType),
  );
  const mesh = verifyObjectProperty(obj, "mesh", verifyOptionalString);
  const skeletons = verifyObjectProperty(
    obj,
    "skeletons",
    verifyOptionalString,
  );
  const segmentPropertyMap = verifyObjectProperty(
    obj,
    "segment_properties",
    verifyOptionalString,
  );
  const scaleInfos = verifyObjectProperty(obj, "scales", (x) =>
    parseArray(x, (y) => new ScaleInfo(y, numChannels)),
  );
  if (scaleInfos.length === 0) throw new Error("Expected at least one scale");
  const baseScale = scaleInfos[0];
  const rank = numChannels === 1 ? 3 : 4;
  const scales = new Float64Array(rank);
  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const names = ["x", "y", "z"];
  const units = ["m", "m", "m"];

  for (let i = 0; i < 3; ++i) {
    scales[i] = baseScale.resolution[i] / 1e9;
    lowerBounds[i] = baseScale.voxelOffset[i];
    upperBounds[i] = lowerBounds[i] + baseScale.size[i];
  }
  if (rank === 4) {
    scales[3] = 1;
    upperBounds[3] = numChannels;
    names[3] = "c^";
    units[3] = "";
  }
  const box: BoundingBox = { lowerBounds, upperBounds };
  const modelSpace = makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });
  return {
    dataType,
    volumeType,
    mesh,
    skeletons,
    segmentPropertyMap,
    scales: scaleInfos,
    modelSpace,
  };
}

export class PrecomputedMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
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
    public sharedKvStoreContext: SharedKvStoreContext,
    public url: string,
    public info: MultiscaleVolumeInfo,
  ) {
    super(sharedKvStoreContext.chunkManager);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const modelResolution = this.info.scales[0].resolution;
    const { rank } = this;
    return transposeNestedArrays(
      this.info.scales
        .filter((x) => !x.hidden)
        .map((scaleInfo) => {
          const { resolution } = scaleInfo;
          const stride = rank + 1;
          const chunkToMultiscaleTransform = new Float32Array(stride * stride);
          chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
          const { lowerBounds: baseLowerBound, upperBounds: baseUpperBound } =
            this.info.modelSpace.boundingBoxes[0].box;
          const lowerClipBound = new Float32Array(rank);
          const upperClipBound = new Float32Array(rank);
          for (let i = 0; i < 3; ++i) {
            const relativeScale = resolution[i] / modelResolution[i];
            chunkToMultiscaleTransform[stride * i + i] = relativeScale;
            const voxelOffsetValue = scaleInfo.voxelOffset[i];
            chunkToMultiscaleTransform[stride * rank + i] =
              voxelOffsetValue * relativeScale;
            lowerClipBound[i] =
              baseLowerBound[i] / relativeScale - voxelOffsetValue;
            upperClipBound[i] =
              baseUpperBound[i] / relativeScale - voxelOffsetValue;
          }
          if (rank === 4) {
            chunkToMultiscaleTransform[stride * 3 + 3] = 1;
            lowerClipBound[3] = baseLowerBound[3];
            upperClipBound[3] = baseUpperBound[3];
          }
          return makeDefaultVolumeChunkSpecifications({
            rank,
            dataType: this.dataType,
            chunkToMultiscaleTransform,
            upperVoxelBound: scaleInfo.size,
            volumeType: this.volumeType,
            chunkDataSizes: scaleInfo.chunkSizes,
            baseVoxelOffset: scaleInfo.voxelOffset,
            compressedSegmentationBlockSize:
              scaleInfo.compressedSegmentationBlockSize,
            volumeSourceOptions,
          }).map(
            (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
              chunkSource: this.chunkManager.getChunkSource(
                PrecomputedVolumeChunkSource,
                {
                  sharedKvStoreContext: this.sharedKvStoreContext,
                  spec,
                  parameters: {
                    url: kvstoreEnsureDirectoryPipelineUrl(
                      this.sharedKvStoreContext.kvStoreContext.resolveRelativePath(
                        this.url,
                        scaleInfo.key,
                      ),
                    ),
                    encoding: scaleInfo.encoding,
                    sharding: scaleInfo.sharding,
                  },
                },
              ),
              chunkToMultiscaleTransform,
              lowerClipBound,
              upperClipBound,
            }),
          );
        }),
    );
  }
}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithSharedKvStoreContext(MultiscaleAnnotationSource),
  AnnotationSourceParameters,
);

class PrecomputedAnnotationSpatialIndexSource extends WithParameters(
  WithSharedKvStoreContext(AnnotationGeometryChunkSource),
  AnnotationSpatialIndexSourceParameters,
) {}

interface PrecomputedAnnotationSourceOptions {
  metadata: AnnotationMetadata;
  parameters: AnnotationSourceParameters;
  sharedKvStoreContext: SharedKvStoreContext;
}

export class PrecomputedAnnotationSource extends MultiscaleAnnotationSourceBase {
  declare key: any;
  metadata: AnnotationMetadata;
  declare OPTIONS: PrecomputedAnnotationSourceOptions;
  constructor(
    chunkManager: ChunkManager,
    options: PrecomputedAnnotationSourceOptions,
  ) {
    const { parameters } = options;
    super(chunkManager, {
      rank: parameters.rank,
      relationships: parameters.relationships.map((x) => x.name),
      properties: parameters.properties,
      sharedKvStoreContext: options.sharedKvStoreContext,
      parameters,
    } as any);
    this.readonly = true;
    this.metadata = options.metadata;
  }

  getSources(): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    return [
      this.metadata.spatialIndices.map((spatialIndexLevel) => {
        const { spec } = spatialIndexLevel;
        return {
          chunkSource: this.chunkManager.getChunkSource(
            PrecomputedAnnotationSpatialIndexSource,
            {
              sharedKvStoreContext: this.sharedKvStoreContext,
              parent: this,
              spec,
              parameters: spatialIndexLevel.parameters,
            },
          ),
          chunkToMultiscaleTransform: spec.chunkToMultiscaleTransform,
        };
      }),
    ];
  }
}

function getLegacyMeshSource(
  sharedKvStoreContext: SharedKvStoreContext,
  parameters: MeshSourceParameters,
) {
  return sharedKvStoreContext.chunkManager.getChunkSource(
    PrecomputedMeshSource,
    {
      parameters,
      sharedKvStoreContext,
    },
  );
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
    metadata = undefined;
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
      parseShardingParameters,
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
  const metadata = await getJsonMetadata(
    sharedKvStoreContext,
    url,
    /*required=*/ false,
    options,
  );
  if (metadata === undefined) {
    // If the info file is missing, assume it is the legacy
    // single-resolution mesh format.
    return { metadata: undefined };
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

interface ParsedSkeletonMetadata {
  metadata: SkeletonMetadata;
  segmentPropertyMap: string | undefined;
}

function parseSkeletonMetadata(data: any): ParsedSkeletonMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, "@type", verifyString);
  if (t !== "neuroglancer_skeletons") {
    throw new Error(`Unsupported skeleton type: ${JSON.stringify(t)}`);
  }
  const transform = parseTransform(data);
  const vertexAttributes = new Map<string, VertexAttributeInfo>();
  verifyObjectProperty(data, "vertex_attributes", (attributes) => {
    if (attributes === undefined) return;
    parseArray(attributes, (attributeData) => {
      verifyObject(attributeData);
      const id = verifyObjectProperty(attributeData, "id", verifyString);
      if (id === "") throw new Error("vertex attribute id must not be empty");
      if (vertexAttributes.has(id)) {
        throw new Error(`duplicate vertex attribute id ${JSON.stringify(id)}`);
      }
      const dataType = verifyObjectProperty(attributeData, "data_type", (y) =>
        verifyEnumString(y, DataType),
      );
      const numComponents = verifyObjectProperty(
        attributeData,
        "num_components",
        verifyPositiveInt,
      );
      vertexAttributes.set(id, { dataType, numComponents });
    });
  });
  const sharding = verifyObjectProperty(
    data,
    "sharding",
    parseShardingParameters,
  );
  const segmentPropertyMap = verifyObjectProperty(
    data,
    "segment_properties",
    verifyOptionalString,
  );
  return {
    metadata: { transform, vertexAttributes, sharding } as SkeletonMetadata,
    segmentPropertyMap,
  };
}

async function getSkeletonMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<ParsedSkeletonMetadata> {
  const metadata = await getJsonMetadata(
    sharedKvStoreContext,
    url,
    /*required=*/ true,
    options,
  );
  return parseSkeletonMetadata(metadata);
}

function getDefaultCoordinateSpace() {
  return makeCoordinateSpace({
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    scales: Float64Array.of(1e-9, 1e-9, 1e-9),
  });
}

async function getMeshSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
) {
  const { metadata, segmentPropertyMap } = await getMeshMetadata(
    sharedKvStoreContext,
    url,
    options,
  );
  if (metadata === undefined) {
    return {
      source: getLegacyMeshSource(sharedKvStoreContext, {
        url,
        lod: 0,
      }),
      transform: mat4.create(),
      segmentPropertyMap,
    };
  }
  let vertexPositionFormat: VertexPositionFormat;
  const { vertexQuantizationBits } = metadata;
  if (vertexQuantizationBits === 10) {
    vertexPositionFormat = VertexPositionFormat.uint10;
  } else if (vertexQuantizationBits === 16) {
    vertexPositionFormat = VertexPositionFormat.uint16;
  } else {
    throw new Error(
      `Invalid vertex quantization bits: ${vertexQuantizationBits}`,
    );
  }
  return {
    source: sharedKvStoreContext.chunkManager.getChunkSource(
      PrecomputedMultiscaleMeshSource,
      {
        sharedKvStoreContext,
        parameters: { url, metadata },
        format: {
          fragmentRelativeVertices: true,
          vertexPositionFormat,
        },
      },
    ),
    transform: metadata.transform,
    segmentPropertyMap,
  };
}

async function getSkeletonSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
) {
  const { metadata, segmentPropertyMap } = await getSkeletonMetadata(
    sharedKvStoreContext,
    url,
    options,
  );
  return {
    source: sharedKvStoreContext.chunkManager.getChunkSource(
      PrecomputedSkeletonSource,
      {
        sharedKvStoreContext,
        parameters: {
          url,
          metadata,
        },
      },
    ),
    transform: metadata.transform,
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
        message: `Reading neuroglancer_precomputed metadata from ${infoUrl}`,
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
  options: Partial<ProgressOptions>,
): Promise<DataSource> {
  const info = parseMultiscaleVolumeInfo(metadata);
  const volume = new PrecomputedMultiscaleVolumeChunkSource(
    sharedKvStoreContext,
    url,
    info,
  );
  const { modelSpace } = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: "default",
      default: true,
      subsource: { volume },
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
    const meshUrl = kvstoreEnsureDirectoryPipelineUrl(
      sharedKvStoreContext.kvStoreContext.resolveRelativePath(url, info.mesh),
    );
    const { source: meshSource, transform } = await getMeshSource(
      sharedKvStoreContext,
      meshUrl,
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
  if (info.skeletons !== undefined) {
    const skeletonsUrl = kvstoreEnsureDirectoryPipelineUrl(
      sharedKvStoreContext.kvStoreContext.resolveRelativePath(
        url,
        info.skeletons,
      ),
    );
    const { source: skeletonSource, transform } = await getSkeletonSource(
      sharedKvStoreContext,
      skeletonsUrl,
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
      id: "skeletons",
      default: true,
      subsource: { mesh: skeletonSource },
      subsourceToModelSubspaceTransform,
    });
  }
  return { modelTransform: makeIdentityTransform(modelSpace), subsources };
}

async function getSkeletonsDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<DataSource> {
  const {
    source: skeletons,
    transform,
    segmentPropertyMap,
  } = await getSkeletonSource(sharedKvStoreContext, url, options);
  const subsources: DataSubsourceEntry[] = [
    {
      id: "default",
      default: true,
      subsource: { mesh: skeletons },
      subsourceToModelSubspaceTransform: transform,
    },
  ];
  if (segmentPropertyMap !== undefined) {
    const mapUrl = kvstoreEnsureDirectoryPipelineUrl(
      sharedKvStoreContext.kvStoreContext.resolveRelativePath(
        url,
        segmentPropertyMap,
      ),
    );
    const metadata = await getJsonMetadata(
      sharedKvStoreContext,
      mapUrl,
      /*required=*/ true,
      options,
    );
    const segmentPropertyMapData = getSegmentPropertyMap(metadata);
    subsources.push({
      id: "properties",
      default: true,
      subsource: { segmentPropertyMap: segmentPropertyMapData },
    });
  }
  return {
    modelTransform: makeIdentityTransform(getDefaultCoordinateSpace()),
    subsources,
  };
}

function parseKeyAndShardingSpec(
  kvStoreContext: KvStoreContext,
  url: string,
  obj: any,
) {
  verifyObject(obj);
  const relativePath = verifyObjectProperty(obj, "key", verifyString);
  return {
    url: kvstoreEnsureDirectoryPipelineUrl(
      kvStoreContext.resolveRelativePath(url, relativePath),
    ),
    sharding: verifyObjectProperty(obj, "sharding", parseShardingParameters),
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
  constructor(
    kvStoreContext: KvStoreContext,
    public url: string,
    metadata: any,
  ) {
    verifyObject(metadata);
    const baseCoordinateSpace = verifyObjectProperty(
      metadata,
      "dimensions",
      coordinateSpaceFromJson,
    );
    const { rank } = baseCoordinateSpace;
    const lowerBounds = verifyObjectProperty(
      metadata,
      "lower_bound",
      (boundJson) =>
        parseFixedLengthArray(
          new Float64Array(rank),
          boundJson,
          verifyFiniteFloat,
        ),
    );
    const upperBounds = verifyObjectProperty(
      metadata,
      "upper_bound",
      (boundJson) =>
        parseFixedLengthArray(
          new Float64Array(rank),
          boundJson,
          verifyFiniteFloat,
        ),
    );
    this.coordinateSpace = makeCoordinateSpace({
      rank,
      names: baseCoordinateSpace.names,
      units: baseCoordinateSpace.units,
      scales: baseCoordinateSpace.scales,
      boundingBoxes: [
        makeIdentityTransformedBoundingBox({ lowerBounds, upperBounds }),
      ],
    });
    this.parameters = {
      type: verifyObjectProperty(metadata, "annotation_type", (typeObj) =>
        verifyEnumString(typeObj, AnnotationType),
      ),
      rank,
      relationships: verifyObjectProperty(
        metadata,
        "relationships",
        (relsObj) =>
          parseArray(relsObj, (relObj) => {
            const common = parseKeyAndShardingSpec(kvStoreContext, url, relObj);
            const name = verifyObjectProperty(relObj, "id", verifyString);
            return { ...common, name };
          }),
      ),
      properties: verifyObjectProperty(
        metadata,
        "properties",
        parseAnnotationPropertySpecs,
      ),
      byId: verifyObjectProperty(metadata, "by_id", (obj) =>
        parseKeyAndShardingSpec(kvStoreContext, url, obj),
      ),
    };
    this.spatialIndices = verifyObjectProperty(
      metadata,
      "spatial",
      (spatialObj) =>
        parseArray(spatialObj, (levelObj) => {
          const common: AnnotationSpatialIndexSourceParameters =
            parseKeyAndShardingSpec(kvStoreContext, url, levelObj);
          const gridShape = verifyObjectProperty(levelObj, "grid_shape", (j) =>
            parseFixedLengthArray(new Float32Array(rank), j, verifyPositiveInt),
          );
          const chunkShape = verifyObjectProperty(levelObj, "chunk_size", (j) =>
            parseFixedLengthArray(
              new Float32Array(rank),
              j,
              verifyFinitePositiveFloat,
            ),
          );
          const limit = verifyObjectProperty(
            levelObj,
            "limit",
            verifyPositiveInt,
          );
          const gridShapeInVoxels = new Float32Array(rank);
          for (let i = 0; i < rank; ++i) {
            gridShapeInVoxels[i] = gridShape[i] * chunkShape[i];
          }
          const chunkToMultiscaleTransform = matrix.createIdentity(
            Float32Array,
            rank + 1,
          );
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
            }),
          };
          spec.upperChunkBound = gridShape;
          return {
            parameters: common,
            spec,
            limit,
          };
        }),
    );
    this.spatialIndices.reverse();
  }
}

function getAnnotationDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  metadata: any,
): DataSource {
  const info = new AnnotationMetadata(
    sharedKvStoreContext.kvStoreContext,
    url,
    metadata,
  );
  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(info.coordinateSpace),
    subsources: [
      {
        id: "default",
        default: true,
        subsource: {
          annotation: sharedKvStoreContext.chunkManager.getChunkSource(
            PrecomputedAnnotationSource,
            {
              sharedKvStoreContext,
              metadata: info,
              parameters: info.parameters,
            },
          ),
        },
      },
    ],
  };
  return dataSource;
}

async function getMeshDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<DataSource> {
  const {
    source: mesh,
    transform,
    segmentPropertyMap,
  } = await getMeshSource(sharedKvStoreContext, url, options);
  const subsources: DataSubsourceEntry[] = [
    {
      id: "default",
      default: true,
      subsource: { mesh },
      subsourceToModelSubspaceTransform: transform,
    },
  ];
  if (segmentPropertyMap !== undefined) {
    const mapUrl = kvstoreEnsureDirectoryPipelineUrl(
      sharedKvStoreContext.kvStoreContext.resolveRelativePath(
        url,
        segmentPropertyMap,
      ),
    );
    const metadata = await getJsonMetadata(
      sharedKvStoreContext,
      mapUrl,
      /*required=*/ true,
      options,
    );
    const segmentPropertyMapData = getSegmentPropertyMap(metadata);
    subsources.push({
      id: "properties",
      default: true,
      subsource: { segmentPropertyMap: segmentPropertyMapData },
    });
  }

  return {
    modelTransform: makeIdentityTransform(getDefaultCoordinateSpace()),
    subsources,
  };
}

function parseInlinePropertyMap(data: unknown): InlineSegmentPropertyMap {
  verifyObject(data);
  const ids = verifyObjectProperty(data, "ids", (idsObj) => {
    idsObj = verifyStringArray(idsObj);
    const numIds = idsObj.length;
    const ids = new BigUint64Array(numIds);
    for (let i = 0; i < numIds; ++i) {
      ids[i] = parseUint64(idsObj[i]);
    }
    return ids;
  });
  const numIds = ids.length;
  const properties = verifyObjectProperty(data, "properties", (propertiesObj) =>
    parseArray(propertiesObj, (propertyObj): InlineSegmentProperty => {
      verifyObject(propertyObj);
      const id = verifyObjectProperty(propertyObj, "id", verifyString);
      const description = verifyOptionalObjectProperty(
        propertyObj,
        "description",
        verifyString,
      );
      const type = verifyObjectProperty(propertyObj, "type", (type) => {
        if (
          type !== "label" &&
          type !== "description" &&
          type !== "string" &&
          type !== "tags" &&
          type !== "number"
        ) {
          throw new Error(`Invalid property type: ${JSON.stringify(type)}`);
        }
        return type;
      });
      if (type === "tags") {
        const tags = verifyObjectProperty(
          propertyObj,
          "tags",
          verifyStringArray,
        );
        let tagDescriptions = verifyOptionalObjectProperty(
          propertyObj,
          "tag_descriptions",
          verifyStringArray,
        );
        if (tagDescriptions === undefined) {
          tagDescriptions = new Array(tags.length);
          tagDescriptions.fill("");
        } else {
          if (tagDescriptions.length !== tags.length) {
            throw new Error(
              `Expected tag_descriptions to have length: ${tags.length}`,
            );
          }
        }
        const values = verifyObjectProperty(
          propertyObj,
          "values",
          (valuesObj) => {
            if (!Array.isArray(valuesObj) || valuesObj.length !== numIds) {
              throw new Error(
                `Expected ${numIds} values, but received: ${valuesObj.length}`,
              );
            }
            return valuesObj.map((tagIndices) => {
              return String.fromCharCode(...tagIndices);
            });
          },
        );
        return { id, description, type, tags, tagDescriptions, values };
      }
      if (type === "number") {
        const dataType = verifyObjectProperty(propertyObj, "data_type", (x) =>
          verifyEnumString(x, DataType),
        );
        if (dataType === DataType.UINT64) {
          throw new Error("uint64 properties not supported");
        }
        const values = verifyObjectProperty(
          propertyObj,
          "values",
          (valuesObj) => {
            if (!Array.isArray(valuesObj) || valuesObj.length !== numIds) {
              throw new Error(
                `Expected ${numIds} values, but received: ${valuesObj.length}`,
              );
            }
            return (
              DATA_TYPE_ARRAY_CONSTRUCTOR[
                dataType
              ] as TypedNumberArrayConstructor
            ).from(valuesObj);
          },
        );
        let min = Infinity;
        let max = -Infinity;
        for (let i = values.length - 1; i >= 0; --i) {
          const v = values[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        return { id, description, type, dataType, values, bounds: [min, max] };
      }
      const values = verifyObjectProperty(
        propertyObj,
        "values",
        (valuesObj) => {
          verifyStringArray(valuesObj);
          if (valuesObj.length !== numIds) {
            throw new Error(
              `Expected ${numIds} values, but received: ${valuesObj.length}`,
            );
          }
          return valuesObj;
        },
      );
      return { id, description, type, values };
    }),
  );
  return normalizeInlineSegmentPropertyMap({ ids, properties });
}

export function getSegmentPropertyMap(data: unknown): SegmentPropertyMap {
  try {
    const t = verifyObjectProperty(data, "@type", verifyString);
    if (t !== "neuroglancer_segment_properties") {
      throw new Error(
        `Unsupported segment property map type: ${JSON.stringify(t)}`,
      );
    }
    const inlineProperties = verifyOptionalObjectProperty(
      data,
      "inline",
      parseInlinePropertyMap,
    );
    return new SegmentPropertyMap({ inlineProperties });
  } catch (e) {
    throw new Error(`Error parsing segment property map: ${e.message}`);
  }
}

function getSegmentPropertyMapDataSource(metadata: unknown): DataSource {
  return {
    modelTransform: makeIdentityTransform(emptyValidCoordinateSpace),
    subsources: [
      {
        id: "default",
        default: true,
        subsource: {
          segmentPropertyMap: getSegmentPropertyMap(metadata),
        },
      },
    ],
  };
}

const urlPattern = /^([^#]*)(?:#(.*))?$/;

export function parseProviderUrl(providerUrl: string) {
  let [, url, fragment] = providerUrl.match(urlPattern)!;
  if (url.endsWith("/")) {
    url = url.substring(0, url.length - 1);
  }
  const parameters = parseQueryStringParameters(fragment || "");
  return { url, parameters };
}

export function unparseProviderUrl(url: string, parameters: any) {
  const fragment = unparseQueryStringParameters(parameters);
  if (fragment) {
    url += `#${fragment}`;
  }
  return url;
}

export class PrecomputedDataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "neuroglancer-precomputed";
  }
  get expectsDirectory() {
    return true;
  }
  get description() {
    return "Neuroglancer Precomputed data source";
  }

  get(
    options: GetKvStoreBasedDataSourceOptions,
  ): Promise<DataSourceLookupResult> {
    const { authorityAndPath, query, fragment } = parseUrlSuffix(
      options.url.suffix,
    );
    if (query) {
      throw new Error(
        `Invalid URL ${JSON.stringify(options.url.url)}: query parameters not supported`,
      );
    }
    if (authorityAndPath) {
      throw new Error(
        `Invalid URL ${JSON.stringify(options.url.url)}: non-empty path not supported`,
      );
    }
    const parameters = parseQueryStringParameters(fragment ?? "");
    const url = kvstoreEnsureDirectoryPipelineUrl(options.kvStoreUrl);
    return options.registry.chunkManager.memoize.getAsync(
      { type: "precomputed:get", url, parameters },
      options,
      async (progressOptions) => {
        const { sharedKvStoreContext } = options.registry;
        const metadata = await getJsonMetadata(
          sharedKvStoreContext,
          url,
          /*required=*/ parameters.type !== "mesh",
          progressOptions,
        );
        const canonicalUrl = `${url}|${options.url.scheme}:`;
        verifyObject(metadata);
        const redirect = verifyOptionalObjectProperty(
          metadata,
          "redirect",
          verifyString,
        );
        if (redirect !== undefined) {
          return { canonicalUrl, targetUrl: redirect };
        }
        const t = verifyOptionalObjectProperty(metadata, "@type", verifyString);
        let dataSource: DataSource;
        switch (t) {
          case "neuroglancer_skeletons":
            dataSource = await getSkeletonsDataSource(
              sharedKvStoreContext,
              url,
              progressOptions,
            );
            break;
          case "neuroglancer_multilod_draco":
          case "neuroglancer_legacy_mesh":
            dataSource = await getMeshDataSource(
              sharedKvStoreContext,
              url,
              progressOptions,
            );
            break;
          case "neuroglancer_annotations_v1":
            dataSource = getAnnotationDataSource(
              sharedKvStoreContext,
              url,
              metadata,
            );
            break;
          case "neuroglancer_segment_properties":
            dataSource = getSegmentPropertyMapDataSource(metadata);
            break;
          case "neuroglancer_multiscale_volume":
          case undefined:
            dataSource = await getVolumeDataSource(
              sharedKvStoreContext,
              url,
              metadata,
              progressOptions,
            );
            break;
          default:
            throw new Error(`Invalid type: ${JSON.stringify(t)}`);
        }
        dataSource.canonicalUrl = canonicalUrl;
        return dataSource;
      },
    );
  }
}

export class PrecomputedLegacyUrlDataSource extends KvStoreBasedDataSourceLegacyUrlAdapter {
  constructor() {
    super(new PrecomputedDataSource(), "precomputed");
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    const { url, parameters } = parseProviderUrl(options.providerUrl);
    if (options.type === "mesh") {
      parameters.type = "mesh";
    }
    return options.providerScheme + "://" + unparseProviderUrl(url, parameters);
  }
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerDirectoryFormat(
    simpleFilePresenceAutoDetectDirectorySpec(new Set(["info"]), {
      suffix: "neuroglancer-precomputed:",
      description: "Neuroglancer Precomputed data source",
    }),
  );
}
