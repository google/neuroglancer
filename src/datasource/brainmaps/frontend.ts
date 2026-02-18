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

import {
  AnnotationGeometryChunkSource,
  MultiscaleAnnotationSource,
} from "#src/annotation/frontend_source.js";
import {
  AnnotationType,
  makeDataBoundsBoundingBoxAnnotationSet,
} from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type {
  BoundingBox,
  CoordinateSpace,
} from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import { WithCredentialsProvider } from "#src/credentials_provider/chunk_source_frontend.js";
import type {
  CredentialsManager,
  CredentialsProvider,
} from "#src/credentials_provider/index.js";
import type {
  BrainmapsCredentialsProvider,
  BrainmapsInstance,
  OAuth2Credentials,
} from "#src/datasource/brainmaps/api.js";
import { credentialsKey, makeRequest } from "#src/datasource/brainmaps/api.js";
import type {
  ChangeSpec,
  MultiscaleMeshInfo,
  SingleMeshInfo,
} from "#src/datasource/brainmaps/base.js";
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
  CompleteUrlOptions,
  DataSource,
  DataSourceRegistry,
  GetDataSourceOptions,
  DataSourceProvider,
} from "#src/datasource/index.js";
import { VertexPositionFormat } from "#src/mesh/base.js";
import { MeshSource, MultiscaleMeshSource } from "#src/mesh/frontend.js";
import { SkeletonSource } from "#src/skeleton/frontend.js";
import {
  ChunkLayoutPreference,
  makeSliceViewChunkSpecification,
} from "#src/sliceview/base.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import type { CompletionWithDescription } from "#src/util/completion.js";
import {
  applyCompletionOffset,
  completeQueryStringParametersFromTable,
  getPrefixMatches,
  getPrefixMatchesWithDescriptions,
} from "#src/util/completion.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import {
  parseArray,
  parseQueryStringParameters,
  parseXYZ,
  verifyEnumString,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyInt,
  verifyMapKey,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyOptionalString,
  verifyPositiveInt,
  verifyString,
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { defaultStringCompare } from "#src/util/string.js";

class BrainmapsVolumeChunkSource extends WithParameters(
  WithCredentialsProvider<OAuth2Credentials>()(VolumeChunkSource),
  VolumeSourceParameters,
) {}

class BrainmapsMultiscaleMeshSource extends WithParameters(
  WithCredentialsProvider<OAuth2Credentials>()(MultiscaleMeshSource),
  MultiscaleMeshSourceParameters,
) {}

class BrainmapsMeshSource extends WithParameters(
  WithCredentialsProvider<OAuth2Credentials>()(MeshSource),
  MeshSourceParameters,
) {}

export class BrainmapsSkeletonSource extends WithParameters(
  WithCredentialsProvider<OAuth2Credentials>()(SkeletonSource),
  SkeletonSourceParameters,
) {}

class BrainmapsAnnotationSpatialIndexSource extends WithParameters(
  WithCredentialsProvider<OAuth2Credentials>()(AnnotationGeometryChunkSource),
  AnnotationSpatialIndexSourceParameters,
) {}

const SERVER_DATA_TYPES = new Map<string, DataType>();
SERVER_DATA_TYPES.set("UINT8", DataType.UINT8);
SERVER_DATA_TYPES.set("FLOAT", DataType.FLOAT32);
SERVER_DATA_TYPES.set("UINT32", DataType.UINT32);
SERVER_DATA_TYPES.set("UINT64", DataType.UINT64);

function parseBoundingBox(obj: any) {
  verifyObject(obj);
  try {
    return {
      corner: verifyObjectProperty(obj, "corner", (x) =>
        parseXYZ(vec3.create(), x, verifyFiniteFloat),
      ),
      size: verifyObjectProperty(obj, "size", (x) =>
        parseXYZ(vec3.create(), x, verifyFinitePositiveFloat),
      ),
      metadata: verifyObjectProperty(obj, "metadata", verifyOptionalString),
    };
  } catch (parseError) {
    throw new Error(`Failed to parse bounding box: ${parseError.message}`);
  }
}

export class VolumeInfo {
  numChannels: number;
  dataType: DataType;
  voxelSize: vec3;
  upperVoxelBound: vec3;
  boundingBoxes: { corner: vec3; size: vec3; metadata?: string }[];
  constructor(obj: any) {
    try {
      verifyObject(obj);
      this.numChannels = verifyObjectProperty(
        obj,
        "channelCount",
        verifyPositiveInt,
      );
      this.dataType = verifyObjectProperty(obj, "channelType", (x) =>
        verifyMapKey(x, SERVER_DATA_TYPES),
      );
      this.voxelSize = verifyObjectProperty(obj, "pixelSize", (x) =>
        parseXYZ(vec3.create(), x, verifyFinitePositiveFloat),
      );
      this.upperVoxelBound = verifyObjectProperty(obj, "volumeSize", (x) =>
        parseXYZ(vec3.create(), x, verifyPositiveInt),
      );
      this.boundingBoxes = verifyObjectProperty(obj, "boundingBox", (a) =>
        a === undefined ? [] : parseArray(a, parseBoundingBox),
      );
    } catch (parseError) {
      throw new Error(
        `Failed to parse BrainMaps volume geometry: ${parseError.message}`,
      );
    }
  }
}

function parseMeshInfo(obj: any): SingleMeshInfo {
  verifyObject(obj);
  return {
    name: verifyObjectProperty(obj, "name", verifyString),
    type: verifyObjectProperty(obj, "type", verifyString),
  };
}

function parseMeshesResponse(meshesResponse: any): SingleMeshInfo[] {
  try {
    verifyObject(meshesResponse);
    return verifyObjectProperty(meshesResponse, "meshes", (y) => {
      if (y === undefined) {
        return [];
      }
      return parseArray(y, parseMeshInfo);
    });
  } catch (parseError) {
    throw new Error(
      `Failed to parse BrainMaps meshes specification: ${parseError.message}`,
    );
  }
}

const floatPattern = "([0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)";
const intPattern = "([0-9]+)";
const lodPattern = new RegExp(
  `^(.*)_${intPattern}x${intPattern}x${intPattern}_lod([0-9]+)_${floatPattern}$`,
);

function getMultiscaleMeshes(
  volumeInfo: MultiscaleVolumeInfo,
  meshes: SingleMeshInfo[],
): MultiscaleMeshInfo[] {
  const multiscaleMeshes = new Map<string, MultiscaleMeshInfo>();
  const baseVolume = volumeInfo.scales[0];

  const invalidLodMeshes = new Set<string>();

  for (const mesh of meshes) {
    // Only triangular meshes supported currently.
    if (mesh.type !== "TRIANGLES") continue;
    const m = mesh.name.match(lodPattern);
    if (m === null) continue;
    const key = m[1];
    let info = multiscaleMeshes.get(key);
    if (info === undefined) {
      info = { key, chunkShape: vec3.create(), lods: [] };
      multiscaleMeshes.set(key, info);
    }
    const lod = parseInt(m[5]);
    if (info.lods[lod] !== undefined) {
      invalidLodMeshes.add(key);
      continue;
    }
    const chunkShapeInVoxels = vec3.fromValues(
      parseInt(m[2], 10),
      parseInt(m[3], 10),
      parseInt(m[4], 10),
    );
    const gridShape = new Uint32Array(3);
    for (let i = 0; i < 3; ++i) {
      gridShape[i] = Math.ceil(
        baseVolume.upperVoxelBound[i] / chunkShapeInVoxels[i],
      );
    }

    info.lods[lod] = {
      info: mesh,
      scale: parseFloat(m[6]),
      // Temporarily use the relativeBlockShape field to store the absolute shape in voxels.
      relativeBlockShape: chunkShapeInVoxels,
      gridShape,
    };
  }

  const output: MultiscaleMeshInfo[] = [];
  meshLoop: for (const mesh of multiscaleMeshes.values()) {
    if (invalidLodMeshes.has(mesh.key)) continue;
    const baseLod = mesh.lods[0];
    if (baseLod === undefined) continue;
    const baseBlockShapeInVoxels = baseLod.relativeBlockShape;
    vec3.multiply(
      mesh.chunkShape,
      baseBlockShapeInVoxels,
      baseVolume.voxelSize,
    );
    for (let lodIndex = 1; lodIndex < mesh.lods.length; ++lodIndex) {
      const lod = mesh.lods[lodIndex];
      if (lod === undefined) continue meshLoop;
      const { relativeBlockShape } = lod;
      for (let i = 0; i < 3; ++i) {
        const curSize = relativeBlockShape[i];
        const baseSize = baseBlockShapeInVoxels[i];
        if (curSize < baseSize || curSize % baseSize !== 0) continue meshLoop;
        relativeBlockShape[i] = curSize / baseSize;
      }
    }
    baseBlockShapeInVoxels.fill(1);
    output.push(mesh);
  }

  return output;
}

type MeshInfo =
  | {
      single: SingleMeshInfo;
      partOfMultiscale: boolean;
      multi: undefined;
      name: string;
    }
  | {
      multi: MultiscaleMeshInfo;
      partOfMultiscale: false;
      single: undefined;
      name: string;
    };

function getSingleScaleAndMultiscaleMeshes(
  volumeInfo: MultiscaleVolumeInfo,
  meshes: SingleMeshInfo[],
): MeshInfo[] {
  const multiscaleMeshes = getMultiscaleMeshes(volumeInfo, meshes);
  const results: MeshInfo[] = [];
  const add = (entry: MeshInfo) => {
    // Prevent duplicates in pathological multiscale mesh naming cases.
    if (results.some((x) => x.name === entry.name)) {
      return;
    }
    results.push(entry);
  };
  const multiscaleLodMeshes = new Set<SingleMeshInfo>();
  for (const m of multiscaleMeshes) {
    add({ multi: m, single: undefined, name: m.key, partOfMultiscale: false });
    for (const s of m.lods) {
      multiscaleLodMeshes.add(s.info);
    }
  }
  for (const m of meshes) {
    add({
      single: m,
      multi: undefined,
      name: m.name,
      partOfMultiscale: multiscaleLodMeshes.has(m),
    });
  }
  return results;
}

export class MultiscaleVolumeInfo {
  scales: VolumeInfo[];
  numChannels: number;
  dataType: DataType;
  box: BoundingBox;

  constructor(volumeInfoResponse: any) {
    try {
      verifyObject(volumeInfoResponse);
      const scales = (this.scales = verifyObjectProperty(
        volumeInfoResponse,
        "geometry",
        (y) => parseArray(y, (x) => new VolumeInfo(x)),
      ));
      if (scales.length === 0) {
        throw new Error("Expected at least one scale.");
      }
      let baseScale = scales[0];
      const numChannels = (this.numChannels = baseScale.numChannels);
      const dataType = (this.dataType = baseScale.dataType);
      for (
        let scaleIndex = 1, numScales = scales.length;
        scaleIndex < numScales;
        ++scaleIndex
      ) {
        const scale = scales[scaleIndex];
        if (scale.dataType !== dataType) {
          throw new Error(
            `Scale ${scaleIndex} has data type ${DataType[scale.dataType]} ` +
              `but scale 0 has data type ${DataType[dataType]}.`,
          );
        }
        if (scale.numChannels !== numChannels) {
          throw new Error(
            `Scale ${scaleIndex} has ${scale.numChannels} channel(s) ` +
              `but scale 0 has ${numChannels} channels.`,
          );
        }
      }
      scales.sort((a, b) => {
        const av = a.voxelSize;
        const bv = b.voxelSize;
        return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
      });
      baseScale = scales[0];
      this.box = {
        lowerBounds: new Float64Array(3),
        upperBounds: new Float64Array(baseScale.upperVoxelBound),
      };
    } catch (parseError) {
      throw new Error(
        `Failed to parse BrainMaps multiscale volume specification: ${parseError.message}`,
      );
    }
  }

  getModelSpace(channelDimension = false): CoordinateSpace {
    const baseScale = this.scales[0];
    const names = ["x", "y", "z"];
    const units = ["m", "m", "m"];
    const scales = Array.from(baseScale.voxelSize, (x) => x / 1e9);
    const lowerBounds = [0, 0, 0];
    const upperBounds = Array.from(baseScale.upperVoxelBound);
    if (channelDimension) {
      names.push("c^");
      units.push("");
      scales.push(1);
      lowerBounds.push(0);
      upperBounds.push(this.numChannels);
    }
    return makeCoordinateSpace({
      names,
      units,
      scales: Float64Array.from(scales),
      boundingBoxes: [
        makeIdentityTransformedBoundingBox({
          lowerBounds: new Float64Array(names.length),
          upperBounds: Float64Array.from(upperBounds),
        }),
      ],
    });
  }
}

export interface GetBrainmapsVolumeOptions {
  encoding?: VolumeChunkEncoding;
  chunkLayoutPreference?: ChunkLayoutPreference;
  jpegQuality: number;
}

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  volumeType: VolumeType;
  get scales() {
    return this.multiscaleVolumeInfo.scales;
  }
  get dataType() {
    return this.multiscaleVolumeInfo.dataType;
  }
  get rank() {
    return this.multiscaleVolumeInfo.numChannels !== 1 ? 4 : 3;
  }

  encoding: VolumeChunkEncoding | undefined;
  jpegQuality: number;
  chunkLayoutPreference: ChunkLayoutPreference | undefined;
  constructor(
    chunkManager: ChunkManager,
    public instance: BrainmapsInstance,
    public credentialsProvider: Borrowed<BrainmapsCredentialsProvider>,
    public volumeId: string,
    public changeSpec: ChangeSpec | undefined,
    public multiscaleVolumeInfo: MultiscaleVolumeInfo,
    options: GetBrainmapsVolumeOptions,
  ) {
    super(chunkManager);
    this.encoding = options.encoding;
    this.jpegQuality = options.jpegQuality;
    this.chunkLayoutPreference = options.chunkLayoutPreference;

    // Infer the VolumeType from the data type and number of channels.
    let volumeType = VolumeType.IMAGE;
    if (this.dataType === DataType.UINT64) {
      volumeType = VolumeType.SEGMENTATION;
    }
    this.volumeType = volumeType;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let encoding = VolumeChunkEncoding.RAW;
    if (
      (this.dataType === DataType.UINT64 ||
        this.dataType === DataType.UINT32) &&
      this.volumeType === VolumeType.SEGMENTATION &&
      this.encoding !== VolumeChunkEncoding.RAW
    ) {
      encoding = VolumeChunkEncoding.COMPRESSED_SEGMENTATION;
    } else if (
      this.volumeType === VolumeType.IMAGE &&
      this.dataType === DataType.UINT8 &&
      this.multiscaleVolumeInfo.numChannels === 1 &&
      this.encoding !== VolumeChunkEncoding.RAW
    ) {
      if (volumeSourceOptions.discreteValues !== true) {
        encoding = VolumeChunkEncoding.JPEG;
      }
    }

    const jpegQuality =
      encoding === VolumeChunkEncoding.JPEG ? this.jpegQuality : undefined;

    const baseScale = this.scales[0];
    const { upperVoxelBound: baseUpperVoxelBound } = baseScale;
    const relativeVoxelSize = vec3.create();

    const { rank } = this;
    return transposeNestedArrays(
      this.scales.map((volumeInfo, scaleIndex) => {
        vec3.divide(
          relativeVoxelSize,
          volumeInfo.voxelSize,
          baseScale.voxelSize,
        );
        let upperVoxelBound: Float32Array = volumeInfo.upperVoxelBound;
        let minBlockSize: Uint32Array | undefined;
        const { numChannels } = volumeInfo;
        const transform = new Float32Array((rank + 1) ** 2);
        transform[(rank + 1) * rank + rank] = 1;
        const upperClipBound = new Float32Array(rank);
        if (numChannels !== 1) {
          upperVoxelBound = Float32Array.of(...upperVoxelBound, numChannels);
          minBlockSize = Uint32Array.of(1, 1, 1, numChannels);
          // Channel dimension is not transformed.
          transform[(rank + 1) * 3 + 3] = 1;
          upperClipBound[3] = numChannels;
        }
        for (let i = 0; i < 3; ++i) {
          transform[(rank + 1) * i + i] = relativeVoxelSize[i];
          upperClipBound[i] = baseUpperVoxelBound[i] / relativeVoxelSize[i];
        }
        return makeDefaultVolumeChunkSpecifications({
          rank,
          minBlockSize,
          chunkToMultiscaleTransform: transform,
          dataType: volumeInfo.dataType,
          upperVoxelBound,
          volumeType: this.volumeType,
          volumeSourceOptions,
          chunkLayoutPreference: this.chunkLayoutPreference,
          maxCompressedSegmentationBlockSize: vec3.fromValues(64, 64, 64),
        }).map((spec) => {
          return {
            chunkSource: this.chunkManager.getChunkSource(
              BrainmapsVolumeChunkSource,
              {
                credentialsProvider: this.credentialsProvider,
                spec,
                parameters: {
                  volumeId: this.volumeId,
                  changeSpec: this.changeSpec,
                  scaleIndex: scaleIndex,
                  encoding: encoding,
                  jpegQuality: jpegQuality,
                  instance: this.instance,
                },
              },
            ),
            chunkToMultiscaleTransform: transform,
            upperClipBound,
          };
        });
      }),
    );
  }
}

function getNanometersToVoxelsTransform(info: MultiscaleVolumeInfo) {
  const transform = mat4.create();
  const baseVoxelSize = info.scales[0].voxelSize;
  for (let i = 0; i < 3; ++i) {
    transform[5 * i] = 1 / baseVoxelSize[i];
  }
  return transform;
}

export function parseVolumeKey(key: string): {
  volumeId: string;
  changeSpec: ChangeSpec | undefined;
  meshName: string | undefined;
  parameters: any;
} {
  const match = key.match(
    /^([^:?/]+:[^:?/]+:[^:?/]+)(?::([^:?/]+))?(?:\/([^?]+))?(?:\?(.*))?$/,
  );
  if (match === null) {
    throw new Error(`Invalid Brain Maps volume key: ${JSON.stringify(key)}.`);
  }
  let changeSpec: ChangeSpec | undefined;
  if (match[2] !== undefined) {
    changeSpec = { changeStackId: match[2] };
  }
  const parameters = parseQueryStringParameters(match[4] || "");
  return { volumeId: match[1], changeSpec, meshName: match[3], parameters };
}

interface ProjectMetadata {
  id: string;
  label: string;
  description?: string;
}

function parseProject(obj: any): ProjectMetadata {
  try {
    verifyObject(obj);
    return {
      id: verifyObjectProperty(obj, "id", verifyString),
      label: verifyObjectProperty(obj, "label", verifyString),
      description: verifyObjectProperty(
        obj,
        "description",
        verifyOptionalString,
      ),
    };
  } catch (parseError) {
    throw new Error(`Failed to parse project: ${parseError.message}`);
  }
}

function parseProjectList(obj: any) {
  try {
    verifyObject(obj);
    return verifyObjectProperty(obj, "project", (x) =>
      x === undefined ? [] : parseArray(x, parseProject),
    );
  } catch (parseError) {
    throw new Error(`Error parsing project list: ${parseError.message}`);
  }
}

function parseAPIResponseList(obj: any, propertyName: string) {
  try {
    verifyObject(obj);
    return verifyObjectProperty(obj, propertyName, (x) =>
      x === undefined ? [] : parseArray(x, verifyString),
    );
  } catch (parseError) {
    throw new Error(`Error parsing dataset list: ${parseError.message}`);
  }
}

export class VolumeList {
  volumeIds: string[];
  projects = new Map<string, ProjectMetadata>();
  hierarchicalVolumeIds = new Map<string, string[]>();
  constructor(projectsResponse: any, volumesResponse: any) {
    const { projects } = this;
    for (const project of parseProjectList(projectsResponse)) {
      projects.set(project.id, project);
    }
    try {
      verifyObject(volumesResponse);
      const volumeIds = (this.volumeIds = verifyObjectProperty(
        volumesResponse,
        "volumeId",
        (x) => (x === undefined ? [] : parseArray(x, verifyString)),
      ));
      volumeIds.sort();
      const hierarchicalSets = new Map<string, Set<string>>();
      for (const volumeId of volumeIds) {
        let componentStart = 0;
        while (true) {
          let nextColon: number | undefined = volumeId.indexOf(
            ":",
            componentStart,
          );
          if (nextColon === -1) {
            nextColon = undefined;
          } else {
            ++nextColon;
          }
          const groupString = volumeId.substring(0, componentStart);
          let group = hierarchicalSets.get(groupString);
          if (group === undefined) {
            group = new Set<string>();
            hierarchicalSets.set(groupString, group);
          }
          group.add(volumeId.substring(componentStart, nextColon));
          if (nextColon === undefined) {
            break;
          }
          componentStart = nextColon;
        }
      }
      const { hierarchicalVolumeIds } = this;
      for (const [group, valueSet] of hierarchicalSets) {
        hierarchicalVolumeIds.set(group, Array.from(valueSet));
      }
    } catch (parseError) {
      throw new Error(
        `Failed to parse Brain Maps volume list reply: ${parseError.message}`,
      );
    }
  }
}

export function parseChangeStackList(x: any) {
  return verifyObjectProperty(x, "changeStackId", (y) =>
    y === undefined ? undefined : parseArray(y, verifyString),
  );
}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithCredentialsProvider<OAuth2Credentials>()(MultiscaleAnnotationSource),
  AnnotationSourceParameters,
);

export class BrainmapsAnnotationSource extends MultiscaleAnnotationSourceBase {
  declare key: any;
  declare parameters: AnnotationSourceParameters;
  credentialsProvider: Owned<CredentialsProvider<OAuth2Credentials>>;
  constructor(
    chunkManager: ChunkManager,
    options: {
      credentialsProvider: CredentialsProvider<OAuth2Credentials>;
      parameters: AnnotationSourceParameters;
    },
  ) {
    super(chunkManager, {
      rank: 3,
      relationships: ["segments"],
      properties: [],
      ...options,
    });
    this.credentialsProvider = this.registerDisposer(
      options.credentialsProvider.addRef(),
    );
  }

  hasNonSerializedProperties() {
    // Has description field.
    return true;
  }

  getSources(): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    const { upperVoxelBound } = this.parameters;
    const spec = makeSliceViewChunkSpecification({
      rank: 3,
      chunkDataSize: upperVoxelBound,
      upperVoxelBound,
    });
    const chunkToMultiscaleTransform = mat4.create();
    return [
      [
        {
          chunkSource: this.chunkManager.getChunkSource(
            BrainmapsAnnotationSpatialIndexSource,
            {
              parent: this,
              spec: { limit: 0, chunkToMultiscaleTransform, ...spec },
              parameters: this.parameters,
              credentialsProvider: this.credentialsProvider,
            },
          ),
          chunkToMultiscaleTransform,
        },
      ],
    ];
  }
}

const supportedQueryParameters = [
  {
    key: { value: "encoding", description: "Volume chunk data encoding" },
    values: [
      { value: "raw", description: "" },
      { value: "jpeg", description: "" },
      { value: "compressed_segmentation", description: "" },
    ],
  },
  {
    key: {
      value: "chunkLayout",
      description: "Volume chunk layout preference",
    },
    values: [
      { value: "isotropic", description: "" },
      { value: "flat", description: "" },
    ],
  },
  {
    key: { value: "jpegQuality", description: "JPEG quality (1 to 100)" },
    values: [],
  },
];

function getCredentialsProvider(credentialsManager: CredentialsManager) {
  return credentialsManager.getCredentialsProvider<OAuth2Credentials>(
    credentialsKey,
  );
}

export class BrainmapsDataSource implements DataSourceProvider {
  constructor(
    public instance: BrainmapsInstance,
    public scheme: string,
  ) {}

  get description() {
    return this.instance.description;
  }

  private getMultiscaleInfo(
    registry: DataSourceRegistry,
    volumeId: string,
    options: Partial<ProgressOptions>,
  ) {
    return registry.chunkManager.memoize.getAsync(
      {
        type: "brainmaps:getMultiscaleInfo",
        volumeId,
        instance: this.instance,
      },
      options,
      async (progressOptions) => {
        const response = await makeRequest(
          this.instance,
          getCredentialsProvider(registry.credentialsManager),
          `/v1beta2/volumes/${volumeId}`,
          progressOptions,
        );
        return new MultiscaleVolumeInfo(await response.json());
      },
    );
  }

  private getMeshesInfo(
    registry: DataSourceRegistry,
    volumeId: string,
    options: Partial<ProgressOptions>,
  ) {
    return registry.chunkManager.memoize.getAsync(
      {
        type: "brainmaps:getMeshesInfo",
        volumeId,
        instance: this.instance,
      },
      options,
      (progressOptions) =>
        makeRequest(
          this.instance,
          getCredentialsProvider(registry.credentialsManager),
          `/v1beta2/objects/${volumeId}/meshes`,
          progressOptions,
        )
          .then((response) => response.json())
          .then((response) => parseMeshesResponse(response)),
    );
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const { volumeId, changeSpec, meshName, parameters } = parseVolumeKey(
      options.providerUrl,
    );
    verifyObject(parameters);
    const encoding = verifyOptionalObjectProperty(parameters, "encoding", (x) =>
      verifyEnumString(x, VolumeChunkEncoding),
    );
    const jpegQuality = verifyOptionalObjectProperty(
      parameters,
      "jpegQuality",
      (x) => {
        const quality = verifyInt(x);
        if (quality < 1 || quality > 100)
          throw new Error(
            `Expected integer in range [1, 100], but received: ${x}`,
          );
        return quality;
      },
      70,
    );
    const chunkLayoutPreference = verifyOptionalObjectProperty(
      parameters,
      "chunkLayout",
      (x) => verifyEnumString(x, ChunkLayoutPreference),
    );
    const brainmapsOptions: GetBrainmapsVolumeOptions = {
      encoding,
      chunkLayoutPreference,
      jpegQuality,
    };
    return options.registry.chunkManager.memoize.getAsync(
      {
        type: "brainmaps:get",
        instance: this.instance,
        volumeId,
        changeSpec,
        brainmapsOptions,
      },
      options,
      async (progressOptions) => {
        const credentialsProvider = getCredentialsProvider(
          options.registry.credentialsManager,
        );
        const [multiscaleVolumeInfo, meshesInfo] = await Promise.all([
          this.getMultiscaleInfo(options.registry, volumeId, progressOptions),
          this.getMeshesInfo(options.registry, volumeId, progressOptions),
        ]);
        const volume = new MultiscaleVolumeChunkSource(
          options.registry.chunkManager,
          this.instance,
          credentialsProvider,
          volumeId,
          changeSpec,
          multiscaleVolumeInfo,
          brainmapsOptions,
        );
        const dataSource: DataSource = {
          modelTransform: makeIdentityTransform(
            multiscaleVolumeInfo.getModelSpace(
              multiscaleVolumeInfo.numChannels !== 1,
            ),
          ),
          subsources: [
            {
              id: meshName === undefined ? "default" : "volume",
              subsource: { volume },
              default: meshName === undefined,
            },
          ],
        };

        const annotationSet = makeDataBoundsBoundingBoxAnnotationSet(
          multiscaleVolumeInfo.box,
        );
        const baseScale = multiscaleVolumeInfo.scales[0];
        baseScale.boundingBoxes.forEach((boundingBox, i) => {
          annotationSet.add({
            type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
            description: boundingBox.metadata,
            pointA: boundingBox.corner,
            pointB: vec3.add(
              vec3.create(),
              boundingBox.corner,
              boundingBox.size,
            ),
            id: `boundingBox${i}`,
            properties: [],
          });
        });
        dataSource.subsources.push({
          id: "bounds",
          subsource: { staticAnnotations: annotationSet },
          default: true,
        });

        const allMeshes = getSingleScaleAndMultiscaleMeshes(
          multiscaleVolumeInfo,
          meshesInfo,
        );
        const addMeshResource = (mesh: MeshInfo, enabled: boolean) => {
          let meshSource: MeshSource | MultiscaleMeshSource | SkeletonSource;
          const { single } = mesh;
          if (single !== undefined) {
            if (single.type === "TRIANGLES") {
              meshSource = options.registry.chunkManager.getChunkSource(
                BrainmapsMeshSource,
                {
                  credentialsProvider,
                  parameters: {
                    instance: this.instance,
                    volumeId: volumeId,
                    meshName: single.name,
                    changeSpec: changeSpec,
                  },
                },
              );
            } else {
              meshSource = options.registry.chunkManager.getChunkSource(
                BrainmapsSkeletonSource,
                {
                  credentialsProvider,
                  parameters: {
                    instance: this.instance,
                    volumeId: volumeId,
                    meshName: mesh.name,
                    changeSpec: changeSpec,
                  },
                },
              );
            }
          } else {
            const multi = mesh.multi!;
            meshSource = options.registry.chunkManager.getChunkSource(
              BrainmapsMultiscaleMeshSource,
              {
                credentialsProvider,
                format: {
                  fragmentRelativeVertices: false,
                  vertexPositionFormat: VertexPositionFormat.float32,
                },
                parameters: {
                  instance: this.instance,
                  volumeId: volumeId,
                  info: multi,
                  changeSpec: changeSpec,
                },
              },
            );
          }
          dataSource.subsources.push({
            id: meshName === undefined ? `/${mesh.name}` : "default",
            subsource: { mesh: meshSource },
            subsourceToModelSubspaceTransform:
              getNanometersToVoxelsTransform(multiscaleVolumeInfo),
            modelSubspaceDimensionIndices: [0, 1, 2],
            default: enabled,
          });
        };
        if (meshName !== undefined) {
          const mesh = allMeshes.find((x) => x.name === meshName);
          if (mesh === undefined) {
            throw new Error(
              `Mesh/skeleton source not found: ${JSON.stringify(mesh)}`,
            );
          }
          addMeshResource(mesh, true);
        } else {
          let isFirst = true;
          for (const mesh of allMeshes) {
            if (mesh.partOfMultiscale) continue;
            addMeshResource(mesh, isFirst);
            isFirst = false;
          }
        }
        if (changeSpec !== undefined) {
          dataSource.subsources.push({
            id: "spatials",
            default: true,
            modelSubspaceDimensionIndices: [0, 1, 2],
            subsource: {
              annotation: options.registry.chunkManager.getChunkSource(
                BrainmapsAnnotationSource,
                {
                  parameters: {
                    volumeId,
                    changestack: changeSpec.changeStackId,
                    instance: this.instance,
                    upperVoxelBound:
                      multiscaleVolumeInfo.scales[0].upperVoxelBound,
                  },
                  credentialsProvider,
                },
              ),
            },
          });
        }
        return dataSource;
      },
    );
  }

  getProjectList(
    registry: DataSourceRegistry,
    options: Partial<ProgressOptions>,
  ) {
    return registry.chunkManager.memoize.getAsync(
      { instance: this.instance, type: "brainmaps:getProjectList" },
      options,
      async (progressOptions) => {
        using _span = new ProgressSpan(progressOptions.progressListener, {
          message: `Retrieving ${this.instance.description} project list`,
        });
        const response = await makeRequest(
          this.instance,
          getCredentialsProvider(registry.credentialsManager),
          "/v1beta2/projects",
          progressOptions,
        );
        return parseProjectList(await response.json());
      },
    );
  }

  getDatasetList(
    registry: DataSourceRegistry,
    project: string,
    options: Partial<ProgressOptions>,
  ) {
    return registry.chunkManager.memoize.getAsync(
      { instance: this.instance, type: `brainmaps:${project}:getDatasetList` },
      options,
      async (progressOptions) => {
        using _span = new ProgressSpan(progressOptions.progressListener, {
          message: `Retrieving ${this.instance.description} dataset list for ${project}`,
        });
        const response = await makeRequest(
          this.instance,
          getCredentialsProvider(registry.credentialsManager),
          `/v1beta2/datasets?project_id=${project}`,
        );
        return parseAPIResponseList(await response.json(), "datasetIds");
      },
    );
  }

  getVolumeList(
    registry: DataSourceRegistry,
    project: string,
    dataset: string,
    options: Partial<ProgressOptions>,
  ) {
    return registry.chunkManager.memoize.getAsync(
      {
        instance: this.instance,
        type: `brainmaps:${project}:${dataset}:getVolumeList`,
      },
      options,
      async (progressOptions) => {
        using _span = new ProgressSpan(progressOptions.progressListener, {
          message: `Retrieving ${this.instance.description} volume list for ${project}:${dataset}`,
        });

        const response = await makeRequest(
          this.instance,
          getCredentialsProvider(registry.credentialsManager),
          `/v1beta2/volumes?project_id=${project}&dataset_id=${dataset}`,
          progressOptions,
        );
        const fullyQualifyiedVolumeList = parseAPIResponseList(
          await response.json(),
          "volumeId",
        );
        const splitPoint = project.length + dataset.length + 2;
        const volumeList = [];
        for (const volume of fullyQualifyiedVolumeList) {
          volumeList.push(volume.substring(splitPoint));
        }
        return volumeList;
      },
    );
  }

  getChangeStackList(
    registry: DataSourceRegistry,
    volumeId: string,
    options: Partial<ProgressOptions>,
  ) {
    return registry.chunkManager.memoize.getAsync(
      {
        instance: this.instance,
        type: "brainmaps:getChangeStackList",
        volumeId,
      },
      options,
      async (progressOptions) => {
        using _span = new ProgressSpan(progressOptions.progressListener, {
          message: `Retrieving ${this.instance.description} change stack list for ${volumeId}`,
        });
        const response = await makeRequest(
          this.instance,
          getCredentialsProvider(registry.credentialsManager),
          `/v1beta2/changes/${volumeId}/change_stacks`,
          progressOptions,
        );
        return parseChangeStackList(await response.json());
      },
    );
  }

  async completeUrl(options: CompleteUrlOptions) {
    const { providerUrl } = options;
    const m = providerUrl.match(
      /^([^:/?]*)(?::([^:/?]*)(?::([^:/?]*)(?::([^:/?]*))?(?:\/([^?]*))?(?:\?(.*))?)?)?$/,
    );
    if (m === null) throw null;
    const [, project, dataset, volume, changestack, meshName, query] = m;
    if (query !== undefined) {
      return applyCompletionOffset(
        providerUrl.length - query.length,
        await completeQueryStringParametersFromTable(
          query,
          supportedQueryParameters,
        ),
      );
    }
    if (meshName !== undefined) {
      const volumeId = `${project}:${dataset}:${volume}`;
      const meshes = await this.getMeshesInfo(
        options.registry,
        volumeId,
        options,
      );
      const results: CompletionWithDescription[] = [];
      const seenMultiscale = new Set<string>();
      for (const mesh of meshes) {
        if (!mesh.name.startsWith(meshName)) continue;
        switch (mesh.type) {
          case "LINE_SEGMENTS":
            results.push({ value: mesh.name, description: "Skeletons" });
            break;
          case "TRIANGLES": {
            results.push({
              value: mesh.name,
              description: "Mesh (single-resolution)",
            });
            const m = mesh.name.match(lodPattern);
            if (m !== null) {
              const key = m[1];
              if (seenMultiscale.has(key)) break;
              seenMultiscale.add(key);
              results.push({
                value: key,
                description: "Mesh (multi-resolution)",
              });
            }
            break;
          }
        }
      }
      results.sort((a, b) => defaultStringCompare(a.value, b.value));
      return {
        offset: providerUrl.length - meshName.length,
        completions: results,
      };
    }
    if (changestack !== undefined) {
      const volumeId = `${project}:${dataset}:${volume}`;
      const changeStacks = await this.getChangeStackList(
        options.registry,
        volumeId,
        options,
      );
      if (changeStacks === undefined) {
        throw null;
      }
      return {
        offset: providerUrl.length - changestack.length,
        completions: getPrefixMatches(changestack, changeStacks),
      };
    }
    if (volume !== undefined) {
      return {
        offset: providerUrl.length - volume.length,
        completions: getPrefixMatches(
          volume,
          await this.getVolumeList(options.registry, project, dataset, options),
        ),
      };
    }
    if (dataset !== undefined) {
      const datasets = await this.getDatasetList(
        options.registry,
        project,
        options,
      );
      return {
        offset: providerUrl.length - dataset.length,
        completions: getPrefixMatches(
          dataset,
          datasets.map((x) => `${x}:`),
        ),
      };
    }

    const projects = await this.getProjectList(options.registry, options);
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions(
        project,
        projects,
        (x) => `${x.id}:`,
        (x) => x.label,
      ),
    };
  }
}

export const productionInstance: BrainmapsInstance = {
  description: "Google Brain Maps",
  serverUrl: "https://brainmaps.googleapis.com",
};
