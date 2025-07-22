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

/**
 * @file
 * Support for DVID (https://github.com/janelia-flyem/dvid) servers.
 */

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { BoundingBox } from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import { WithCredentialsProvider } from "#src/credentials_provider/chunk_source_frontend.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import type { DVIDToken } from "#src/datasource/dvid/api.js";
import {
  credentialsKey,
  fetchWithDVIDCredentials,
} from "#src/datasource/dvid/api.js";
import type { DVIDSourceParameters } from "#src/datasource/dvid/base.js";
import {
  MeshSourceParameters,
  SkeletonSourceParameters,
  VolumeChunkEncoding,
  VolumeChunkSourceParameters,
} from "#src/datasource/dvid/base.js";
import type {
  CompleteUrlOptions,
  CompletionResult,
  DataSource,
  GetDataSourceOptions,
  DataSourceProvider,
} from "#src/datasource/index.js";
import { MeshSource } from "#src/mesh/frontend.js";
import { SkeletonSource } from "#src/skeleton/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import {
  applyCompletionOffset,
  getPrefixMatchesWithDescriptions,
} from "#src/util/completion.js";
import { mat4, vec3 } from "#src/util/geom.js";
import {
  parseArray,
  parseFixedLengthArray,
  parseIntVec,
  parseQueryStringParameters,
  verifyFinitePositiveFloat,
  verifyMapKey,
  verifyObject,
  verifyObjectAsMap,
  verifyObjectProperty,
  verifyPositiveInt,
  verifyString,
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

const serverDataTypes = new Map<string, DataType>();
serverDataTypes.set("uint8", DataType.UINT8);
serverDataTypes.set("uint32", DataType.UINT32);
serverDataTypes.set("uint64", DataType.UINT64);

export class DataInstanceBaseInfo {
  get typeName(): string {
    return this.obj.TypeName;
  }

  get compressionName(): string {
    return this.obj.Compression;
  }

  constructor(public obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, "TypeName", verifyString);
  }
}

export class DataInstanceInfo {
  lowerVoxelBound: vec3;
  upperVoxelBoundInclusive: vec3;
  voxelSize: vec3;
  blockSize: vec3;
  numLevels: number;

  constructor(
    public obj: any,
    public name: string,
    public base: DataInstanceBaseInfo,
  ) {}
}

class DVIDVolumeChunkSource extends WithParameters(
  WithCredentialsProvider<DVIDToken>()(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {}

class DVIDSkeletonSource extends WithParameters(
  WithCredentialsProvider<DVIDToken>()(SkeletonSource),
  SkeletonSourceParameters,
) {}

class DVIDMeshSource extends WithParameters(
  WithCredentialsProvider<DVIDToken>()(MeshSource),
  MeshSourceParameters,
) {}

export class VolumeDataInstanceInfo extends DataInstanceInfo {
  dataType: DataType;
  meshSrc: string;
  skeletonSrc: string;

  constructor(
    obj: any,
    name: string,
    base: DataInstanceBaseInfo,
    public encoding: VolumeChunkEncoding,
    instanceNames: Array<string>,
  ) {
    super(obj, name, base);
    const extended = verifyObjectProperty(obj, "Extended", verifyObject);
    const extendedValues = verifyObjectProperty(extended, "Values", (x) =>
      parseArray(x, verifyObject),
    );
    if (extendedValues.length < 1) {
      throw new Error(
        "Expected Extended.Values property to have length >= 1, but received: ${JSON.stringify(extendedValues)}.",
      );
    }
    this.numLevels = 1;

    const instSet = new Set<string>(instanceNames);
    if (encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
      // retrieve maximum downres level
      const maxdownreslevel = verifyObjectProperty(
        extended,
        "MaxDownresLevel",
        verifyPositiveInt,
      );
      this.numLevels = maxdownreslevel + 1;
    } else {
      // labelblk does not have explicit datatype support for multiscale but
      // by convention different levels are specified with unique
      // instances where levels are distinguished by the suffix '_LEVELNUM'
      while (instSet.has(name + "_" + this.numLevels.toString())) {
        this.numLevels += 1;
      }
    }

    if (instSet.has(name + "_meshes")) {
      this.meshSrc = name + "_meshes";
    } else {
      this.meshSrc = "";
    }

    if (instSet.has(name + "_skeletons")) {
      this.skeletonSrc = name + "_skeletons";
    } else {
      this.skeletonSrc = "";
    }

    this.dataType = verifyObjectProperty(extendedValues[0], "DataType", (x) =>
      verifyMapKey(x, serverDataTypes),
    );
    this.voxelSize = verifyObjectProperty(extended, "VoxelSize", (x) =>
      parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat),
    );
    this.blockSize = verifyObjectProperty(extended, "BlockSize", (x) =>
      parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat),
    );
    this.lowerVoxelBound = verifyObjectProperty(extended, "MinPoint", (x) =>
      parseIntVec(vec3.create(), x),
    );
    this.upperVoxelBoundInclusive = verifyObjectProperty(
      extended,
      "MaxPoint",
      (x) => parseIntVec(vec3.create(), x),
    );
  }

  get volumeType() {
    return this.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
      this.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY
      ? VolumeType.SEGMENTATION
      : VolumeType.IMAGE;
  }

  getSources(
    chunkManager: ChunkManager,
    parameters: DVIDSourceParameters,
    volumeSourceOptions: VolumeSourceOptions,
    credentialsProvider: CredentialsProvider<DVIDToken>,
  ) {
    const { encoding } = this;
    const sources: SliceViewSingleResolutionSource<VolumeChunkSource>[][] = [];

    // must be 64 block size to work with neuroglancer properly
    const blocksize = 64;
    for (let level = 0; level < this.numLevels; ++level) {
      const downsampleFactor = 2 ** level;
      const invDownsampleFactor = 2 ** -level;
      const lowerVoxelBound = vec3.create();
      const upperVoxelBound = vec3.create();
      for (let i = 0; i < 3; ++i) {
        const lowerVoxelNotAligned = Math.floor(
          this.lowerVoxelBound[i] * invDownsampleFactor,
        );
        // adjust min to be a multiple of blocksize
        lowerVoxelBound[i] =
          lowerVoxelNotAligned - (lowerVoxelNotAligned % blocksize);
        const upperVoxelNotAligned = Math.ceil(
          (this.upperVoxelBoundInclusive[i] + 1) * invDownsampleFactor,
        );
        upperVoxelBound[i] = upperVoxelNotAligned;
        // adjust max to be a multiple of blocksize
        if (upperVoxelNotAligned % blocksize !== 0) {
          upperVoxelBound[i] += blocksize - (upperVoxelNotAligned % blocksize);
        }
      }
      let dataInstanceKey = parameters.dataInstanceKey;

      if (encoding !== VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
        if (level > 0) {
          dataInstanceKey += "_" + level.toString();
        }
      }

      const volParameters: VolumeChunkSourceParameters = {
        baseUrl: parameters.baseUrl,
        nodeKey: parameters.nodeKey,
        dataInstanceKey: dataInstanceKey,
        dataScale: level.toString(),
        encoding: encoding,
      };
      const chunkToMultiscaleTransform = mat4.create();
      for (let i = 0; i < 3; ++i) {
        chunkToMultiscaleTransform[5 * i] = downsampleFactor;
        chunkToMultiscaleTransform[12 + i] =
          lowerVoxelBound[i] * downsampleFactor;
      }
      const alternatives = makeDefaultVolumeChunkSpecifications({
        rank: 3,
        chunkToMultiscaleTransform,
        dataType: this.dataType,

        baseVoxelOffset: lowerVoxelBound,
        upperVoxelBound: vec3.subtract(
          vec3.create(),
          upperVoxelBound,
          lowerVoxelBound,
        ),
        volumeType: this.volumeType,
        volumeSourceOptions,
        compressedSegmentationBlockSize:
          encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
          encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY
            ? vec3.fromValues(8, 8, 8)
            : undefined,
      }).map((spec) => ({
        chunkSource: chunkManager.getChunkSource(DVIDVolumeChunkSource, {
          spec,
          parameters: volParameters,
          credentialsProvider,
        }),
        chunkToMultiscaleTransform,
      }));
      sources.push(alternatives);
    }
    return transposeNestedArrays(sources);
  }
}

export function parseDataInstance(
  obj: any,
  name: string,
  instanceNames: Array<string>,
): DataInstanceInfo {
  verifyObject(obj);
  const baseInfo = verifyObjectProperty(
    obj,
    "Base",
    (x) => new DataInstanceBaseInfo(x),
  );
  switch (baseInfo.typeName) {
    case "uint8blk":
    case "grayscale8": {
      const isjpegcompress = baseInfo.compressionName.indexOf("jpeg") !== -1;
      return new VolumeDataInstanceInfo(
        obj,
        name,
        baseInfo,
        isjpegcompress ? VolumeChunkEncoding.JPEG : VolumeChunkEncoding.RAW,
        instanceNames,
      );
    }
    case "labels64":
    case "labelblk":
      return new VolumeDataInstanceInfo(
        obj,
        name,
        baseInfo,
        VolumeChunkEncoding.COMPRESSED_SEGMENTATION,
        instanceNames,
      );
    case "labelarray":
    case "labelmap":
      return new VolumeDataInstanceInfo(
        obj,
        name,
        baseInfo,
        VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY,
        instanceNames,
      );
    default:
      throw new Error(
        `DVID data type ${JSON.stringify(baseInfo.typeName)} is not supported.`,
      );
  }
}

export class RepositoryInfo {
  alias: string;
  description: string;
  errors: string[] = [];
  dataInstances = new Map<string, DataInstanceInfo>();
  uuid: string;
  vnodes = new Set<string>();
  constructor(obj: any) {
    if (obj instanceof RepositoryInfo) {
      this.alias = obj.alias;
      this.description = obj.description;
      // just copy references
      this.errors = obj.errors;
      this.dataInstances = obj.dataInstances;
      return;
    }
    verifyObject(obj);
    this.alias = verifyObjectProperty(obj, "Alias", verifyString);
    this.description = verifyObjectProperty(obj, "Description", verifyString);
    const dataInstanceObjs = verifyObjectProperty(
      obj,
      "DataInstances",
      verifyObject,
    );
    const instanceKeys = Object.keys(dataInstanceObjs);
    for (const key of instanceKeys) {
      try {
        this.dataInstances.set(
          key,
          parseDataInstance(dataInstanceObjs[key], key, instanceKeys),
        );
      } catch (parseError) {
        const message = `Failed to parse data instance ${JSON.stringify(
          key,
        )}: ${parseError.message}`;
        console.log(message);
        this.errors.push(message);
      }
    }

    const dagObj = verifyObjectProperty(obj, "DAG", verifyObject);
    const nodeObjs = verifyObjectProperty(dagObj, "Nodes", verifyObject);
    for (const key of Object.keys(nodeObjs)) {
      this.vnodes.add(key);
    }
  }
}

export function parseRepositoriesInfo(obj: any) {
  try {
    const result = verifyObjectAsMap(obj, (x) => new RepositoryInfo(x));

    // make all versions available for viewing
    const allVersions = new Map<string, RepositoryInfo>();
    for (const [key, info] of result) {
      allVersions.set(key, info);
      for (const key2 of info.vnodes) {
        if (key2 !== key) {
          // create new repo
          const rep = new RepositoryInfo(info);
          allVersions.set(key2, rep);
        }
      }
    }

    for (const [key, info] of allVersions) {
      info.uuid = key;
    }
    return allVersions;
  } catch (parseError) {
    throw new Error(
      `Failed to parse DVID repositories info: ${parseError.message}`,
    );
  }
}

export class ServerInfo {
  repositories: Map<string, RepositoryInfo>;
  constructor(obj: any) {
    this.repositories = parseRepositoriesInfo(obj);
  }

  getNode(nodeKey: string): RepositoryInfo {
    // FIXME: Support non-root nodes.
    const matches: string[] = [];
    for (const key of this.repositories.keys()) {
      if (key.startsWith(nodeKey)) {
        matches.push(key);
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `Node key ${JSON.stringify(nodeKey)} matches ${JSON.stringify(
          matches,
        )} nodes.`,
      );
    }
    return this.repositories.get(matches[0])!;
  }
}

export function getServerInfo(
  chunkManager: ChunkManager,
  baseUrl: string,
  credentialsProvider: CredentialsProvider<DVIDToken>,
  options: Partial<ProgressOptions>,
) {
  return chunkManager.memoize.getAsync(
    { type: "dvid:getServerInfo", baseUrl },
    options,
    async (progressOptions) => {
      using _span = new ProgressSpan(progressOptions.progressListener, {
        message: `Retrieving repository info for DVID server ${baseUrl}`,
      });
      const response = await fetchWithDVIDCredentials(
        credentialsProvider,
        `${baseUrl}/api/repos/info`,
        progressOptions,
      );
      return new ServerInfo(await response.json());
    },
  );
}

class DvidMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return this.info.dataType;
  }
  get volumeType() {
    return this.info.volumeType;
  }

  get rank() {
    return 3;
  }

  constructor(
    chunkManager: ChunkManager,
    public baseUrl: string,
    public nodeKey: string,
    public dataInstanceKey: string,
    public info: VolumeDataInstanceInfo,
    public credentialsProvider: CredentialsProvider<DVIDToken>,
  ) {
    super(chunkManager);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.info.getSources(
      this.chunkManager,
      {
        baseUrl: this.baseUrl,
        nodeKey: this.nodeKey,
        dataInstanceKey: this.dataInstanceKey,
      },
      volumeSourceOptions,
      this.credentialsProvider,
    );
  }
}

const urlPattern = /^((?:http|https):\/\/[^/]+)\/([^/]+)\/([^/]+)(\?.*)?$/;

function getDefaultAuthServer(baseUrl: string) {
  if (baseUrl.startsWith("https")) {
    // Use default token API for DVID https to make completeUrl work properly
    return baseUrl + "/api/server/token";
  }
  return undefined;
}

function parseSourceUrl(url: string): DVIDSourceParameters {
  const match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }

  const sourceParameters: DVIDSourceParameters = {
    baseUrl: match[1],
    nodeKey: match[2],
    dataInstanceKey: match[3],
  };

  const queryString = match[4];
  if (queryString && queryString.length > 1) {
    const parameters = parseQueryStringParameters(queryString.substring(1));
    if (parameters.user) {
      sourceParameters.user = parameters.user;
    }
  }
  sourceParameters.authServer = getDefaultAuthServer(sourceParameters.baseUrl);
  return sourceParameters;
}

function getVolumeSource(
  options: GetDataSourceOptions,
  sourceParameters: DVIDSourceParameters,
  dataInstanceInfo: DataInstanceInfo,
  credentialsProvider: CredentialsProvider<DVIDToken>,
) {
  const baseUrl = sourceParameters.baseUrl;
  const nodeKey = sourceParameters.nodeKey;
  const dataInstanceKey = sourceParameters.dataInstanceKey;

  const info = <VolumeDataInstanceInfo>dataInstanceInfo;

  const box: BoundingBox = {
    lowerBounds: new Float64Array(info.lowerVoxelBound),
    upperBounds: Float64Array.from(info.upperVoxelBoundInclusive, (x) => x + 1),
  };
  const modelSpace = makeCoordinateSpace({
    rank: 3,
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    scales: Float64Array.from(info.voxelSize, (x) => x / 1e9),
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });

  const volume = new DvidMultiscaleVolumeChunkSource(
    options.registry.chunkManager,
    baseUrl,
    nodeKey,
    dataInstanceKey,
    info,
    credentialsProvider,
  );

  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources: [
      {
        id: "default",
        subsource: { volume },
        default: true,
      },
    ],
  };
  if (info.meshSrc) {
    const subsourceToModelSubspaceTransform = mat4.create();
    for (let i = 0; i < 3; ++i) {
      subsourceToModelSubspaceTransform[5 * i] = 1 / info.voxelSize[i];
    }
    dataSource.subsources.push({
      id: "meshes",
      default: true,
      subsource: {
        mesh: options.registry.chunkManager.getChunkSource(DVIDMeshSource, {
          parameters: {
            ...sourceParameters,
            dataInstanceKey: info.meshSrc,
          },
          credentialsProvider: credentialsProvider,
        }),
      },
      subsourceToModelSubspaceTransform,
    });
  }
  if (info.skeletonSrc) {
    dataSource.subsources.push({
      id: "skeletons",
      default: true,
      subsource: {
        mesh: options.registry.chunkManager.getChunkSource(DVIDSkeletonSource, {
          parameters: {
            ...sourceParameters,
            dataInstanceKey: info.skeletonSrc,
          },
          credentialsProvider: credentialsProvider,
        }),
      },
    });
  }
  dataSource.subsources.push({
    id: "bounds",
    subsource: {
      staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(box),
    },
    default: true,
  });

  return dataSource;
}

export function getDataSource(
  options: GetDataSourceOptions,
): Promise<DataSource> {
  const sourceParameters = parseSourceUrl(options.providerUrl);
  const { baseUrl, nodeKey, dataInstanceKey } = sourceParameters;

  return options.registry.chunkManager.memoize.getAsync(
    {
      type: "dvid:MultiscaleVolumeChunkSource",
      baseUrl,
      nodeKey: nodeKey,
      dataInstanceKey,
    },
    options,
    async (progressOptions) => {
      const credentailsProvider =
        options.registry.credentialsManager.getCredentialsProvider<DVIDToken>(
          credentialsKey,
          {
            dvidServer: sourceParameters.baseUrl,
            authServer: sourceParameters.authServer,
          },
        );
      const serverInfo = await getServerInfo(
        options.registry.chunkManager,
        baseUrl,
        credentailsProvider,
        progressOptions,
      );

      // To support special nodes like "<UUID>:master" (which  means "the most distant unlocked
      // descendant of <UUID>"), use only "<UUID>" for the validity lookup, below.  If it is
      // valid, then DVID itself will resolve the part after the ":".
      const i = nodeKey.indexOf(":");
      const nodeKeyForLookup = i !== -1 ? nodeKey.slice(0, i) : nodeKey;

      const repositoryInfo = serverInfo.getNode(nodeKeyForLookup);
      if (repositoryInfo === undefined) {
        throw new Error(`Invalid node: ${JSON.stringify(nodeKey)}.`);
      }
      const dataInstanceInfo =
        repositoryInfo.dataInstances.get(dataInstanceKey);
      if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo)) {
        throw new Error(`Invalid data instance ${dataInstanceKey}.`);
      }

      return getVolumeSource(
        options,
        sourceParameters,
        dataInstanceInfo,
        credentailsProvider,
      );
    },
  );
}

export function completeInstanceName(
  repositoryInfo: RepositoryInfo,
  prefix: string,
): CompletionResult {
  return {
    offset: 0,
    completions: getPrefixMatchesWithDescriptions<DataInstanceInfo>(
      prefix,
      repositoryInfo.dataInstances.values(),
      (instance) => instance.name,
      (instance) => {
        return `${instance.base.typeName}`;
      },
    ),
  };
}

export function completeNodeAndInstance(
  serverInfo: ServerInfo,
  prefix: string,
): CompletionResult {
  const match = prefix.match(/^(?:([^/]+)(?:\/([^/]*))?)?$/);
  if (match === null) {
    throw new Error("Invalid DVID URL syntax.");
  }
  if (match[2] === undefined) {
    // Try to complete the node name.
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions<RepositoryInfo>(
        prefix,
        serverInfo.repositories.values(),
        (repository) => repository.uuid + "/",
        (repository) => `${repository.alias}: ${repository.description}`,
      ),
    };
  }
  const nodeKey = match[1];
  const repositoryInfo = serverInfo.getNode(nodeKey);
  return applyCompletionOffset(
    nodeKey.length + 1,
    completeInstanceName(repositoryInfo, match[2]),
  );
}

export async function completeUrl(
  options: CompleteUrlOptions,
): Promise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^/]+)\/([^?]*).*$/;
  const url = options.providerUrl;

  const match = url.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    throw null;
  }
  const baseUrl = match[1];
  const path = match[2];
  const authServer = getDefaultAuthServer(baseUrl);

  const serverInfo = await getServerInfo(
    options.registry.chunkManager,
    baseUrl,
    options.registry.credentialsManager.getCredentialsProvider<DVIDToken>(
      credentialsKey,
      { dvidServer: baseUrl, authServer },
    ),
    options,
  );
  return applyCompletionOffset(
    baseUrl.length + 1,
    completeNodeAndInstance(serverInfo, path),
  );
}

export class DVIDDataSource implements DataSourceProvider {
  get scheme() {
    return "dvid";
  }
  get description() {
    return "DVID";
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options);
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeUrl(options);
  }
}
