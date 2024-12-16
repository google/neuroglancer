/**
 * @license
 * Copyright 2017 Google Inc.
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
 * Support for The Boss (https://github.com/jhuapl-boss) web services.
 */

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
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
import type { BossToken } from "#src/datasource/boss/api.js";
import {
  credentialsKey,
  fetchWithBossCredentials,
} from "#src/datasource/boss/api.js";
import {
  MeshSourceParameters,
  VolumeChunkSourceParameters,
} from "#src/datasource/boss/base.js";
import type {
  CompleteUrlOptions,
  CompletionResult,
  DataSource,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import { DataSourceProvider } from "#src/datasource/index.js";
import { MeshSource } from "#src/mesh/frontend.js";
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
import { vec2, vec3 } from "#src/util/geom.js";
import {
  parseArray,
  parseQueryStringParameters,
  verify3dDimensions,
  verify3dScale,
  verifyEnumString,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyInt,
  verifyObject,
  verifyObjectAsMap,
  verifyObjectProperty,
  verifyOptionalString,
  verifyString,
} from "#src/util/json.js";

class BossVolumeChunkSource extends WithParameters(
  WithCredentialsProvider<BossToken>()(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {}

class BossMeshSource extends WithParameters(
  WithCredentialsProvider<BossToken>()(MeshSource),
  MeshSourceParameters,
) {}

const serverVolumeTypes = new Map<string, VolumeType>();
serverVolumeTypes.set("image", VolumeType.IMAGE);
serverVolumeTypes.set("annotation", VolumeType.SEGMENTATION);

const VALID_ENCODINGS = new Set<string>(["npz", "jpeg"]);

const DEFAULT_CUBOID_SIZE = Uint32Array.of(512, 512, 16);

interface ChannelInfo {
  channelType: string;
  volumeType: VolumeType;
  dataType: DataType;
  downsampled: boolean;
  scales: ScaleInfo[];
  description: string;
  key: string;
  baseResolution: number;
}

interface CoordinateFrameInfo {
  names: string[];
  voxelSizeBaseInOriginalUnits: Float32Array;
  voxelSizeBaseInMeters: Float64Array;
  voxelOffsetBase: Float64Array;
  imageSizeBase: Float64Array;
  voxelUnit: VoxelUnitType;
}

enum VoxelUnitType {
  NANOMETERS = 0,
  MICROMETERS = 1,
  MILLIMETERS = 2,
  CENTIMETERS = 3,
}

interface ScaleInfo {
  downsampleFactors: Float32Array;
  imageSize: vec3;
  key: string;
}

interface ExperimentInfo {
  channels: Map<string, ChannelInfo>;
  scalingLevels: number;
  coordFrameKey: string;
  coordFrame?: CoordinateFrameInfo;
  key: string;
  collection: string;
}

function getVoxelUnitInvScale(voxelUnit: VoxelUnitType): number {
  switch (voxelUnit) {
    case VoxelUnitType.MICROMETERS:
      return 1e6;
    case VoxelUnitType.MILLIMETERS:
      return 1e3;
    case VoxelUnitType.CENTIMETERS:
      return 1e2;
    case VoxelUnitType.NANOMETERS:
      return 1e9;
  }
}

/**
 * This function adds scaling info by processing coordinate frame object and adding it to the
 * experiment.
 */
function parseCoordinateFrame(
  coordFrame: any,
  experimentInfo: ExperimentInfo,
): ExperimentInfo {
  verifyObject(coordFrame);

  const voxelUnit = verifyObjectProperty(coordFrame, "voxel_unit", (x) =>
    verifyEnumString(x, VoxelUnitType),
  );

  const voxelSizeBaseInvScale = getVoxelUnitInvScale(voxelUnit);

  const voxelSizeBaseInOriginalUnits = new Float32Array(3);
  const voxelSizeBaseInMeters = new Float64Array(3);
  const voxelOffsetBase = new Float64Array(3);
  const imageSizeBase = new Float64Array(3);
  const dimNames = ["x", "y", "z"];
  for (let i = 0; i < 3; ++i) {
    const dimName = dimNames[i];
    voxelSizeBaseInOriginalUnits[i] = verifyObjectProperty(
      coordFrame,
      `${dimName}_voxel_size`,
      verifyFinitePositiveFloat,
    );
    voxelSizeBaseInMeters[i] =
      voxelSizeBaseInOriginalUnits[i] / voxelSizeBaseInvScale;
    voxelOffsetBase[i] = verifyObjectProperty(
      coordFrame,
      `${dimName}_start`,
      verifyInt,
    );
    imageSizeBase[i] = verifyObjectProperty(
      coordFrame,
      `${dimName}_stop`,
      verifyInt,
    );
  }
  experimentInfo.coordFrame = {
    voxelSizeBaseInMeters,
    voxelSizeBaseInOriginalUnits,
    voxelOffsetBase,
    imageSizeBase,
    voxelUnit,
    names: dimNames,
  };
  return experimentInfo;
}

function getVolumeTypeFromChannelType(channelType: string) {
  let volumeType = serverVolumeTypes.get(channelType);
  if (volumeType === undefined) {
    volumeType = VolumeType.UNKNOWN;
  }
  return volumeType;
}

function parseChannelInfo(obj: any): ChannelInfo {
  verifyObject(obj);
  const channelType = verifyObjectProperty(obj, "type", verifyString);
  let downsampleStatus = false;
  const downsampleStr = verifyObjectProperty(
    obj,
    "downsample_status",
    verifyString,
  );
  if (downsampleStr === "DOWNSAMPLED") {
    downsampleStatus = true;
  }

  return {
    channelType,
    description: verifyObjectProperty(obj, "description", verifyString),
    volumeType: getVolumeTypeFromChannelType(channelType),
    dataType: verifyObjectProperty(obj, "datatype", (x) =>
      verifyEnumString(x, DataType),
    ),
    downsampled: downsampleStatus,
    scales: [],
    key: verifyObjectProperty(obj, "name", verifyString),
    baseResolution: verifyObjectProperty(obj, "base_resolution", verifyInt),
  };
}

function parseExperimentInfo(
  obj: any,
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
  collection: string,
  experiment: string,
): Promise<ExperimentInfo> {
  verifyObject(obj);

  const channelPromiseArray = verifyObjectProperty(obj, "channels", (x) =>
    parseArray(x, (ch) =>
      getChannelInfo(
        chunkManager,
        hostname,
        credentialsProvider,
        experiment,
        collection,
        ch,
      ),
    ),
  );
  return Promise.all(channelPromiseArray).then((channelArray) => {
    // Parse out channel information
    const channels: Map<string, ChannelInfo> = new Map<string, ChannelInfo>();
    channelArray.forEach((channel) => {
      channels.set(channel.key, channel);
    });

    const experimentInfo = {
      channels: channels,
      scalingLevels: verifyObjectProperty(
        obj,
        "num_hierarchy_levels",
        verifyInt,
      ),
      coordFrameKey: verifyObjectProperty(obj, "coord_frame", verifyString),
      coordFrame: undefined,
      key: verifyObjectProperty(obj, "name", verifyString),
      collection: verifyObjectProperty(obj, "collection", verifyString),
    };

    // Get and parse the coordinate frame
    return getCoordinateFrame(
      chunkManager,
      hostname,
      credentialsProvider,
      experimentInfo,
    );
  });
}

export class BossMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return this.channelInfo.dataType;
  }
  get volumeType() {
    return this.channelInfo.volumeType;
  }

  /**
   * The Boss experiment name
   */
  experiment: string;

  /**
   * The Boss channel/layer name.
   */
  channel: string;

  /**
   * Parameters for getting 3D meshes alongside segmentations
   */
  meshPath?: string = undefined;
  meshUrl?: string = undefined;

  channelInfo: ChannelInfo;
  scales: ScaleInfo[];
  coordinateFrame: CoordinateFrameInfo;

  encoding: string;
  window: vec2 | undefined;

  get rank() {
    return 3;
  }

  constructor(
    chunkManager: ChunkManager,
    public baseUrl: string,
    public credentialsProvider: CredentialsProvider<BossToken>,
    public experimentInfo: ExperimentInfo,
    channel: string | undefined,
    public parameters: { [index: string]: any },
  ) {
    super(chunkManager);
    if (channel === undefined) {
      const channelNames = Array.from(experimentInfo.channels.keys());
      if (channelNames.length !== 1) {
        throw new Error(
          `Experiment contains multiple channels: ${JSON.stringify(
            channelNames,
          )}`,
        );
      }
      channel = channelNames[0];
    }
    const channelInfo = experimentInfo.channels.get(channel);
    if (channelInfo === undefined) {
      throw new Error(
        `Specified channel ${JSON.stringify(
          channel,
        )} is not one of the supported channels ${JSON.stringify(
          Array.from(experimentInfo.channels.keys()),
        )}`,
      );
    }
    this.channel = channel;
    this.channelInfo = channelInfo;
    this.scales = channelInfo.scales;

    if (experimentInfo.coordFrame === undefined) {
      throw new Error(
        `Specified experiment ${JSON.stringify(
          experimentInfo.key,
        )} does not have a valid coordinate frame`,
      );
    }
    this.coordinateFrame = experimentInfo.coordFrame;

    if (this.channelInfo.downsampled === false) {
      this.scales = [channelInfo.scales[0]];
    }
    this.experiment = experimentInfo.key;

    const window = verifyOptionalString(parameters.window);
    if (window !== undefined) {
      const windowobj = vec2.create();
      const parts = window.split(/,/);
      if (parts.length === 2) {
        windowobj[0] = verifyFiniteFloat(parts[0]);
        windowobj[1] = verifyFiniteFloat(parts[1]);
      } else if (parts.length === 1) {
        windowobj[0] = 0;
        windowobj[1] = verifyFiniteFloat(parts[1]);
      } else {
        throw new Error(
          `Invalid window. Must be either one value or two comma separated values: ${JSON.stringify(
            window,
          )}`,
        );
      }
      this.window = windowobj;
      if (this.window[0] === this.window[1]) {
        throw new Error(
          `Invalid window. First element must be different from second: ${JSON.stringify(
            window,
          )}.`,
        );
      }
    }

    const meshUrl = verifyOptionalString(parameters.meshurl);
    if (meshUrl !== undefined) {
      this.meshUrl = meshUrl;
    }

    let encoding = verifyOptionalString(parameters.encoding);
    if (encoding === undefined) {
      // 8-bit image encoded in JPEG filmstrips.
      encoding = this.dataType === DataType.UINT8 ? "jpeg" : "npz";
    } else {
      if (!VALID_ENCODINGS.has(encoding)) {
        throw new Error(`Invalid encoding: ${JSON.stringify(encoding)}.`);
      }
    }
    this.encoding = encoding;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    // Hannah change Feb 2021
    // Replaced scale calculations with those from ../precomputed
    const modelResolution = this.scales[0].downsampleFactors;
    const { rank } = this;
    return transposeNestedArrays(
      this.scales.map((scaleInfo) => {
        const voxelOffset = this.coordinateFrame.voxelOffsetBase;
        const baseVoxelOffset = vec3.create();
        for (let i = 0; i < 3; ++i) {
          baseVoxelOffset[i] = Math.ceil(voxelOffset[i]);
        }
        const resolution = scaleInfo.downsampleFactors;
        const stride = rank + 1;
        const chunkToMultiscaleTransform = new Float32Array(stride * stride);
        chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
        for (let i = 0; i < 3; ++i) {
          const relativeScale = resolution[i] / modelResolution[i];
          chunkToMultiscaleTransform[stride * i + i] = relativeScale;
          chunkToMultiscaleTransform[stride * rank + i] =
            baseVoxelOffset[i] * relativeScale;
        }
        if (rank === 4) {
          chunkToMultiscaleTransform[stride * 3 + 3] = 1;
        }
        const imageSize = scaleInfo.imageSize;
        return makeDefaultVolumeChunkSpecifications({
          rank: 3,
          volumeType: this.volumeType,
          dataType: this.dataType,
          chunkToMultiscaleTransform: chunkToMultiscaleTransform,
          chunkDataSizes: [DEFAULT_CUBOID_SIZE],
          baseVoxelOffset: baseVoxelOffset,
          upperVoxelBound: imageSize,
          volumeSourceOptions,
        }).map(
          (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
            chunkSource: this.chunkManager.getChunkSource(
              BossVolumeChunkSource,
              {
                credentialsProvider: this.credentialsProvider,
                spec,
                parameters: {
                  baseUrl: this.baseUrl,
                  collection: this.experimentInfo.collection,
                  experiment: this.experimentInfo.key,
                  channel: this.channel,
                  resolution: scaleInfo.key,
                  encoding: this.encoding,
                  window: this.window,
                },
              },
            ),
            chunkToMultiscaleTransform,
          }),
        );
      }),
    );
  }

  getMeshSource() {
    if (this.meshUrl !== undefined) {
      return this.chunkManager.getChunkSource(BossMeshSource, {
        credentialsProvider: this.credentialsProvider,
        parameters: { baseUrl: this.meshUrl },
      });
    }
    return null;
  }
}

const pathPattern = /^([^/?]+)\/([^/?]+)(?:\/([^/?]+))?(?:\?(.*))?$/;

export function getExperimentInfo(
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
  experiment: string,
  collection: string,
): Promise<ExperimentInfo> {
  return chunkManager.memoize.getUncounted(
    {
      hostname: hostname,
      collection: collection,
      experiment: experiment,
      type: "boss:getExperimentInfo",
    },
    () =>
      fetchWithBossCredentials(
        credentialsProvider,
        `${hostname}/latest/collection/${collection}/experiment/${experiment}/`,
        {},
      )
        .then((response) => response.json())
        .then((value) =>
          parseExperimentInfo(
            value,
            chunkManager,
            hostname,
            credentialsProvider,
            collection,
            experiment,
          ),
        ),
  );
}

export function getChannelInfo(
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
  experiment: string,
  collection: string,
  channel: string,
): Promise<ChannelInfo> {
  return chunkManager.memoize.getUncounted(
    {
      hostname: hostname,
      collection: collection,
      experiment: experiment,
      channel: channel,
      type: "boss:getChannelInfo",
    },
    () =>
      fetchWithBossCredentials(
        credentialsProvider,
        `${hostname}/latest/collection/${collection}/experiment/${experiment}/channel/${channel}/`,
        {},
      )
        .then((response) => response.json())
        .then(parseChannelInfo),
  );
}

export function getDownsampleInfoForChannel(
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
  collection: string,
  experimentInfo: ExperimentInfo,
  channel: string,
): Promise<ExperimentInfo> {
  return chunkManager.memoize
    .getUncounted(
      {
        hostname: hostname,
        collection: collection,
        experiment: experimentInfo.key,
        channel: channel,
        downsample: true,
        type: "boss:getDownsampleInfoForChannel",
      },
      () =>
        fetchWithBossCredentials(
          credentialsProvider,
          `${hostname}/latest/downsample/${collection}/${experimentInfo.key}/${channel}`,
          {},
        ).then((response) => response.json()),
    )
    .then((downsampleObj) => {
      return parseDownsampleInfoForChannel(
        downsampleObj,
        experimentInfo,
        channel,
      );
    });
}

export function parseDownsampleScales(
  downsampleObj: any,
  voxelSizeBaseInOriginalUnits: Float32Array,
): ScaleInfo[] {
  verifyObject(downsampleObj);

  const voxelSizes = verifyObjectProperty(downsampleObj, "voxel_size", (x) =>
    verifyObjectAsMap(x, verify3dScale),
  );

  const imageSizes = verifyObjectProperty(downsampleObj, "extent", (x) =>
    verifyObjectAsMap(x, verify3dDimensions),
  );

  const num_hierarchy_levels = verifyObjectProperty(
    downsampleObj,
    "num_hierarchy_levels",
    verifyInt,
  );

  const scaleInfo = new Array<ScaleInfo>();
  for (let i = 0; i < num_hierarchy_levels; i++) {
    const key: string = String(i);
    const voxelSize = voxelSizes.get(key);
    const imageSize = imageSizes.get(key);
    if (voxelSize === undefined || imageSize === undefined) {
      throw new Error(`Missing voxel_size/extent for resolution ${key}.`);
    }
    const downsampleFactors = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      downsampleFactors[i] = voxelSize[i] / voxelSizeBaseInOriginalUnits[i];
    }
    scaleInfo[i] = { downsampleFactors, imageSize, key };
  }
  return scaleInfo;
}

export function parseDownsampleInfoForChannel(
  downsampleObj: any,
  experimentInfo: ExperimentInfo,
  channel: string,
): ExperimentInfo {
  const coordFrame = experimentInfo.coordFrame;
  if (coordFrame === undefined) {
    throw new Error(
      `Missing coordinate frame information for experiment ${experimentInfo.key}. A valid coordinate frame is required to retrieve downsampling information.`,
    );
  }
  const channelInfo = experimentInfo.channels.get(channel);
  if (channelInfo === undefined) {
    throw new Error(
      `Specified channel ${JSON.stringify(
        channel,
      )} is not one of the supported channels ${JSON.stringify(
        Array.from(experimentInfo.channels.keys()),
      )}`,
    );
  }
  channelInfo.scales = parseDownsampleScales(
    downsampleObj,
    coordFrame.voxelSizeBaseInOriginalUnits,
  );
  experimentInfo.channels.set(channel, channelInfo);
  return experimentInfo;
}

export function getDataSource(
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
  path: string,
) {
  const match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid volume path ${JSON.stringify(path)}`);
  }
  const collection = match[1];
  const experiment = match[2];
  const channel = match[3];
  const parameters = parseQueryStringParameters(match[4] || "");
  // Warning: If additional arguments are added, the cache key should be updated as well.
  return chunkManager.memoize.getUncounted(
    { hostname: hostname, path: path, type: "boss:getVolume" },
    async () => {
      const experimentInfo = await getExperimentInfo(
        chunkManager,
        hostname,
        credentialsProvider,
        experiment,
        collection,
      );
      const experimentInfoWithDownsample = await getDownsampleInfoForChannel(
        chunkManager,
        hostname,
        credentialsProvider,
        collection,
        experimentInfo,
        channel,
      );
      const volume = new BossMultiscaleVolumeChunkSource(
        chunkManager,
        hostname,
        credentialsProvider,
        experimentInfoWithDownsample,
        channel,
        parameters,
      );
      const coordFrame = experimentInfoWithDownsample.coordFrame!;
      const box = {
        lowerBounds: coordFrame.voxelOffsetBase,
        upperBounds: Float64Array.from(
          coordFrame.imageSizeBase,
          (x, i) => coordFrame.voxelOffsetBase[i] + x,
        ),
      };
      const modelSpace = makeCoordinateSpace({
        rank: 3,
        names: coordFrame.names,
        units: ["m", "m", "m"],
        scales: coordFrame.voxelSizeBaseInMeters,
        boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
      });
      const dataSource: DataSource = {
        modelTransform: makeIdentityTransform(modelSpace),
        subsources: [
          {
            id: "default",
            default: true,
            subsource: { volume },
          },
          {
            id: "bounds",
            default: true,
            subsource: {
              staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(box),
            },
          },
        ],
      };
      return dataSource;
    },
  );
}

const urlPattern = /^((?:http|https):\/\/[^/?]+)\/(.*)$/;

export function getCollections(
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
) {
  return chunkManager.memoize.getUncounted(
    { hostname: hostname, type: "boss:getCollections" },
    () =>
      fetchWithBossCredentials(
        credentialsProvider,
        `${hostname}/latest/collection/`,
        {},
      )
        .then((response) => response.json())
        .then((value) =>
          verifyObjectProperty(value, "collections", (x) =>
            parseArray(x, verifyString),
          ),
        ),
  );
}

export function getExperiments(
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
  collection: string,
) {
  return chunkManager.memoize.getUncounted(
    { hostname: hostname, collection: collection, type: "boss:getExperiments" },
    () =>
      fetchWithBossCredentials(
        credentialsProvider,
        `${hostname}/latest/collection/${collection}/experiment/`,
        {},
      )
        .then((response) => response.json())
        .then((value) =>
          verifyObjectProperty(value, "experiments", (x) =>
            parseArray(x, verifyString),
          ),
        ),
  );
}

export function getCoordinateFrame(
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
  experimentInfo: ExperimentInfo,
): Promise<ExperimentInfo> {
  const key = experimentInfo.coordFrameKey;
  return chunkManager.memoize.getUncounted(
    {
      hostname: hostname,
      coordinateframe: key,
      experimentInfo: experimentInfo,
      type: "boss:getCoordinateFrame",
    },
    () =>
      fetchWithBossCredentials(
        credentialsProvider,
        `${hostname}/latest/coord/${key}/`,
        {},
      )
        .then((response) => response.json())
        .then((coordinateFrameObj) =>
          parseCoordinateFrame(coordinateFrameObj, experimentInfo),
        ),
  );
}

export function collectionExperimentChannelCompleter(
  chunkManager: ChunkManager,
  hostname: string,
  credentialsProvider: CredentialsProvider<BossToken>,
  path: string,
): Promise<CompletionResult> {
  const channelMatch = path.match(
    /^(?:([^/]+)(?:\/?([^/]*)(?:\/?([^/]*)(?:\/?([^/]*)?))?)?)?$/,
  );
  if (channelMatch === null) {
    // URL has incorrect format, don't return any results.
    return Promise.reject<CompletionResult>(null);
  }
  if (channelMatch[1] === undefined) {
    // No collection. Reject.
    return Promise.reject<CompletionResult>(null);
  }
  if (channelMatch[2] === undefined) {
    const collectionPrefix = channelMatch[1] || "";
    // Try to complete the collection.
    return getCollections(chunkManager, hostname, credentialsProvider).then(
      (collections) => {
        return {
          offset: 0,
          completions: getPrefixMatchesWithDescriptions(
            collectionPrefix,
            collections,
            (x) => x + "/",
            () => undefined,
          ),
        };
      },
    );
  }
  if (channelMatch[3] === undefined) {
    const experimentPrefix = channelMatch[2] || "";
    return getExperiments(
      chunkManager,
      hostname,
      credentialsProvider,
      channelMatch[1],
    ).then((experiments) => {
      return {
        offset: channelMatch![1].length + 1,
        completions: getPrefixMatchesWithDescriptions(
          experimentPrefix,
          experiments,
          (y) => y + "/",
          () => undefined,
        ),
      };
    });
  }
  return getExperimentInfo(
    chunkManager,
    hostname,
    credentialsProvider,
    channelMatch[2],
    channelMatch[1],
  ).then((experimentInfo) => {
    const completions = getPrefixMatchesWithDescriptions(
      channelMatch![3],
      experimentInfo.channels,
      (x) => x[0],
      (x) => {
        return `${x[1].channelType} (${DataType[x[1].dataType]})`;
      },
    );
    return {
      offset: channelMatch![1].length + channelMatch![2].length + 2,
      completions,
    };
  });
}

function getAuthServer(endpoint: string): string {
  const baseHostName = endpoint.match(/^(?:https:\/\/[^.]+([^/]+))/);
  if (baseHostName === null) {
    throw new Error(
      `Unable to construct auth server hostname from base hostname ${endpoint}.`,
    );
  }
  const authServer = `https://auth${baseHostName[1]}/auth`;
  return authServer;
}

export class BossDataSource extends DataSourceProvider {
  constructor(public credentialsManager: CredentialsManager) {
    super();
  }

  get description() {
    return "bossDB: Block & Object Storage System";
  }

  getCredentialsProvider(path: string) {
    const authServer = getAuthServer(path);
    return this.credentialsManager.getCredentialsProvider<BossToken>(
      credentialsKey,
      authServer,
    );
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const match = options.providerUrl.match(urlPattern);
    if (match === null) {
      throw new Error(
        `Invalid boss volume path: ${JSON.stringify(options.providerUrl)}`,
      );
    }
    const credentialsProvider = this.getCredentialsProvider(
      options.providerUrl,
    );
    return getDataSource(
      options.chunkManager,
      match[1],
      credentialsProvider,
      match[2],
    );
  }

  async completeUrl(options: CompleteUrlOptions) {
    const match = options.providerUrl.match(urlPattern);
    if (match === null) {
      // We don't yet have a full hostname.
      throw null;
    }
    const hostname = match[1];
    const credentialsProvider = this.getCredentialsProvider(match[1]);
    const path = match[2];
    const completions = await collectionExperimentChannelCompleter(
      options.chunkManager,
      hostname,
      credentialsProvider,
      path,
    );
    return applyCompletionOffset(match![1].length + 1, completions);
  }
}
