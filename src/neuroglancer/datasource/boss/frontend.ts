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

import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CredentialsManager, CredentialsProvider} from 'neuroglancer/credentials_provider';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompletionResult, DataSource} from 'neuroglancer/datasource';
import {BossToken, credentialsKey, fetchWithBossCredentials} from 'neuroglancer/datasource/boss/api';
import {MeshSourceParameters, VolumeChunkSourceParameters} from 'neuroglancer/datasource/boss/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {mat4, vec2, vec3} from 'neuroglancer/util/geom';
import {responseJson} from 'neuroglancer/util/http_request';
import {parseArray, parseQueryStringParameters, verify3dDimensions, verify3dScale, verifyEnumString, verifyFiniteFloat, verifyInt, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';

class BossVolumeChunkSource extends
(WithParameters(WithCredentialsProvider<BossToken>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

class BossMeshSource extends
(WithParameters(WithCredentialsProvider<BossToken>()(MeshSource), MeshSourceParameters)) {}

let serverVolumeTypes = new Map<string, VolumeType>();
serverVolumeTypes.set('image', VolumeType.IMAGE);
serverVolumeTypes.set('annotation', VolumeType.SEGMENTATION);

const VALID_ENCODINGS = new Set<string>(['npz', 'jpeg']);

const DEFAULT_CUBOID_SIZE = vec3.fromValues(512, 512, 16);

interface ChannelInfo {
  channelType: string;
  volumeType: VolumeType;
  dataType: DataType;
  downsampled: boolean;
  scales: ScaleInfo[];
  description: string;
  key: string;
}

interface CoordinateFrameInfo {
  voxelSizeBaseNanometers: vec3;
  voxelOffsetBase: vec3;
  imageSizeBase: vec3;
  voxelUnit: VoxelUnitType;
}

enum VoxelUnitType {
  NANOMETERS = 0,
  MICROMETERS = 1,
  MILLIMETERS = 2,
  CENTIMETERS = 3
}

interface ScaleInfo {
  voxelSizeNanometers: vec3;
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

function getVoxelUnitInNanometers(voxelUnit: VoxelUnitType): number {
  switch (voxelUnit) {
    case VoxelUnitType.MICROMETERS:
      return 1.e3;
    case VoxelUnitType.MILLIMETERS:
      return 1.e6;
    case VoxelUnitType.CENTIMETERS:
      return 1.e7;
    default:
      return 1.0;
  }
}

/**
 * This function adds scaling info by processing coordinate frame object and adding it to the
 * experiment.
 */
function parseCoordinateFrame(coordFrame: any, experimentInfo: ExperimentInfo): ExperimentInfo {
  verifyObject(coordFrame);

  let voxelSizeBase = vec3.create(), voxelOffsetBase = vec3.create(), imageSizeBase = vec3.create();
  voxelSizeBase[0] = verifyObjectProperty(coordFrame, 'x_voxel_size', verifyInt);
  voxelSizeBase[1] = verifyObjectProperty(coordFrame, 'y_voxel_size', verifyInt);
  voxelSizeBase[2] = verifyObjectProperty(coordFrame, 'z_voxel_size', verifyInt);

  voxelOffsetBase[0] = verifyObjectProperty(coordFrame, 'x_start', verifyInt);
  voxelOffsetBase[1] = verifyObjectProperty(coordFrame, 'y_start', verifyInt);
  voxelOffsetBase[2] = verifyObjectProperty(coordFrame, 'z_start', verifyInt);

  imageSizeBase[0] = verifyObjectProperty(coordFrame, 'x_stop', verifyInt);
  imageSizeBase[1] = verifyObjectProperty(coordFrame, 'y_stop', verifyInt);
  imageSizeBase[2] = verifyObjectProperty(coordFrame, 'z_stop', verifyInt);

  let voxelUnit =
      verifyObjectProperty(coordFrame, 'voxel_unit', x => verifyEnumString(x, VoxelUnitType));

  let voxelSizeBaseNanometers: vec3 =
      vec3.scale(vec3.create(), voxelSizeBase, getVoxelUnitInNanometers(voxelUnit));

  experimentInfo.coordFrame = {voxelSizeBaseNanometers, voxelOffsetBase, imageSizeBase, voxelUnit};
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
  let channelType = verifyObjectProperty(obj, 'type', verifyString);
  let downsampleStatus: boolean = false;
  let downsampleStr = verifyObjectProperty(obj, 'downsample_status', verifyString);
  if (downsampleStr === 'DOWNSAMPLED') {
    downsampleStatus = true;
  }

  return {
    channelType,
    description: verifyObjectProperty(obj, 'description', verifyString),
    volumeType: getVolumeTypeFromChannelType(channelType),
    dataType: verifyObjectProperty(obj, 'datatype', x => verifyEnumString(x, DataType)),
    downsampled: downsampleStatus,
    scales: [],
    key: verifyObjectProperty(obj, 'name', verifyString),
  };
}

function parseExperimentInfo(
    obj: any, chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>, collection: string,
    experiment: string): Promise<ExperimentInfo> {
  verifyObject(obj);

  let channelPromiseArray = verifyObjectProperty(
      obj, 'channels',
      x => parseArray(
          x,
          ch => getChannelInfo(
              chunkManager, hostname, credentialsProvider, experiment, collection, ch)));
  return Promise.all(channelPromiseArray).then(channelArray => {
    // Parse out channel information
    let channels: Map<string, ChannelInfo> = new Map<string, ChannelInfo>();
    channelArray.forEach(channel => {
      channels.set(channel.key, channel);
    });

    let experimentInfo = {
      channels: channels,
      scalingLevels: verifyObjectProperty(obj, 'num_hierarchy_levels', verifyInt),
      coordFrameKey: verifyObjectProperty(obj, 'coord_frame', verifyString),
      coordFrame: undefined,
      key: verifyObjectProperty(obj, 'name', verifyString),
      collection: verifyObjectProperty(obj, 'collection', verifyString),
    };

    // Get and parse the coordinate frame
    return getCoordinateFrame(chunkManager, hostname, credentialsProvider, experimentInfo);
  });
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  get dataType() {
    if (this.channelInfo.dataType === DataType.UINT16) {
      // 16-bit channels automatically rescaled to uint8 by The Boss
      return DataType.UINT8;
    }
    return this.channelInfo.dataType;
  }
  get numChannels() {
    return 1;
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
  window: vec2|undefined;

  constructor(
      public chunkManager: ChunkManager, public baseUrl: string,
      public credentialsProvider: CredentialsProvider<BossToken>,
      public experimentInfo: ExperimentInfo, channel: string|undefined,
      public parameters: {[index: string]: any}) {
    if (channel === undefined) {
      const channelNames = Array.from(experimentInfo.channels.keys());
      if (channelNames.length !== 1) {
        throw new Error(`Experiment contains multiple channels: ${JSON.stringify(channelNames)}`);
      }
      channel = channelNames[0];
    }
    const channelInfo = experimentInfo.channels.get(channel);
    if (channelInfo === undefined) {
      throw new Error(
          `Specified channel ${JSON.stringify(channel)} is not one of the supported channels ${
              JSON.stringify(Array.from(experimentInfo.channels.keys()))}`);
    }
    this.channel = channel;
    this.channelInfo = channelInfo;
    this.scales = channelInfo.scales;

    if (experimentInfo.coordFrame === undefined) {
      throw new Error(`Specified experiment ${
          JSON.stringify(experimentInfo.key)} does not have a valid coordinate frame`);
    }
    this.coordinateFrame = experimentInfo.coordFrame;

    if (this.channelInfo.downsampled === false) {
      this.scales = [channelInfo.scales[0]];
    }
    this.experiment = experimentInfo.key;

    let window = verifyOptionalString(parameters['window']);
    if (window !== undefined) {
      let windowobj = vec2.create();
      let parts = window.split(/,/);
      if (parts.length === 2) {
        windowobj[0] = verifyFiniteFloat(parts[0]);
        windowobj[1] = verifyFiniteFloat(parts[1]);
      } else if (parts.length === 1) {
        windowobj[0] = 0.;
        windowobj[1] = verifyFiniteFloat(parts[1]);
      } else {
        throw new Error(`Invalid window. Must be either one value or two comma separated values: ${
            JSON.stringify(window)}`);
      }
      this.window = windowobj;
      if (this.window[0] === this.window[1]) {
        throw new Error(`Invalid window. First element must be different from second: ${
            JSON.stringify(window)}.`);
      }
    }

    let meshUrl = verifyOptionalString(parameters['meshurl']);
    if (meshUrl !== undefined) {
      this.meshUrl = meshUrl;
    }

    let encoding = verifyOptionalString(parameters['encoding']);
    if (encoding === undefined) {
      encoding = this.volumeType === VolumeType.IMAGE ? 'jpeg' : 'npz';
    } else {
      if (!VALID_ENCODINGS.has(encoding)) {
        throw new Error(`Invalid encoding: ${JSON.stringify(encoding)}.`);
      }
    }
    this.encoding = encoding;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.scales.map(scaleInfo => {
      let {voxelSizeNanometers, imageSize} = scaleInfo;
      let voxelOffset = this.coordinateFrame.voxelOffsetBase;
      let baseVoxelOffset = vec3.create();
      for (let i = 0; i < 3; ++i) {
        baseVoxelOffset[i] = Math.ceil(voxelOffset[i]);
      }
      return VolumeChunkSpecification
          .getDefaults({
            numChannels: this.numChannels,
            volumeType: this.volumeType,
            dataType: this.dataType,
            voxelSize: voxelSizeNanometers,
            chunkDataSizes: [DEFAULT_CUBOID_SIZE],
            transform: mat4.fromTranslation(
                mat4.create(), vec3.multiply(vec3.create(), voxelOffset, voxelSizeNanometers)),
            baseVoxelOffset,
            upperVoxelBound: imageSize,
            volumeSourceOptions,
          })
          .map(spec => this.chunkManager.getChunkSource(BossVolumeChunkSource, {
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
            }
          }));
    });
  }

  getMeshSource() {
    if (this.meshUrl !== undefined) {
      return this.chunkManager.getChunkSource(
          BossMeshSource,
          {credentialsProvider: this.credentialsProvider, parameters: {baseUrl: this.meshUrl}});
    }
    return null;
  }
}

const pathPattern = /^([^\/?]+)\/([^\/?]+)(?:\/([^\/?]+))?(?:\?(.*))?$/;

export function getExperimentInfo(
    chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>, experiment: string,
    collection: string): Promise<ExperimentInfo> {
  return chunkManager.memoize.getUncounted(
      {
        hostname: hostname,
        collection: collection,
        experiment: experiment,
        type: 'boss:getExperimentInfo'
      },
      () =>
          fetchWithBossCredentials(
              credentialsProvider,
              `${hostname}/latest/collection/${collection}/experiment/${experiment}/`, {},
              responseJson)
              .then(
                  value => parseExperimentInfo(
                      value, chunkManager, hostname, credentialsProvider, collection, experiment)));
}

export function getChannelInfo(
    chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>, experiment: string, collection: string,
    channel: string): Promise<ChannelInfo> {
  return chunkManager.memoize.getUncounted(
      {
        hostname: hostname,
        collection: collection,
        experiment: experiment,
        channel: channel,
        type: 'boss:getChannelInfo'
      },
      () => fetchWithBossCredentials(
                credentialsProvider,
                `${hostname}/latest/collection/${collection}/experiment/${experiment}/channel/${
                    channel}/`,
                {}, responseJson)
                .then(parseChannelInfo));
}

export function getDownsampleInfoForChannel(
    chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>, collection: string,
    experimentInfo: ExperimentInfo, channel: string): Promise<ExperimentInfo> {
  return chunkManager.memoize
      .getUncounted(
          {
            hostname: hostname,
            collection: collection,
            experiment: experimentInfo.key,
            channel: channel,
            downsample: true,
            type: 'boss:getDownsampleInfoForChannel'
          },
          () => fetchWithBossCredentials(
              credentialsProvider,
              `${hostname}/latest/downsample/${collection}/${experimentInfo.key}/${channel}/`, {},
              responseJson))
      .then(downsampleObj => {
        return parseDownsampleInfoForChannel(downsampleObj, experimentInfo, channel);
      });
}

export function parseDownsampleScales(downsampleObj: any, voxelUnit: VoxelUnitType): ScaleInfo[] {
  verifyObject(downsampleObj);

  let voxelSizes =
      verifyObjectProperty(downsampleObj, 'voxel_size', x => verifyObjectAsMap(x, verify3dScale));

  let imageSizes =
      verifyObjectProperty(downsampleObj, 'extent', x => verifyObjectAsMap(x, verify3dDimensions));

  let num_hierarchy_levels = verifyObjectProperty(downsampleObj, 'num_hierarchy_levels', verifyInt);

  let scaleInfo = new Array<ScaleInfo>();
  for (let i = 0; i < num_hierarchy_levels; i++) {
    let key: string = String(i);
    const voxelSize = voxelSizes.get(key);
    const imageSize = imageSizes.get(key);
    if (voxelSize === undefined || imageSize === undefined) {
      throw new Error(`Missing voxel_size/extent for resolution ${key}.`);
    }
    let voxelSizeNanometers =
        vec3.scale(vec3.create(), voxelSize, getVoxelUnitInNanometers(voxelUnit));
    scaleInfo[i] = {voxelSizeNanometers, imageSize, key};
  }
  return scaleInfo;
}

export function parseDownsampleInfoForChannel(
    downsampleObj: any, experimentInfo: ExperimentInfo, channel: string): ExperimentInfo {
  let coordFrame = experimentInfo.coordFrame;
  if (coordFrame === undefined) {
    throw new Error(`Missing coordinate frame information for experiment ${
        experimentInfo
            .key}. A valid coordinate frame is required to retrieve downsampling information.`);
  }
  let channelInfo = experimentInfo.channels.get(channel);
  if (channelInfo === undefined) {
    throw new Error(
        `Specified channel ${JSON.stringify(channel)} is not one of the supported channels ${
            JSON.stringify(Array.from(experimentInfo.channels.keys()))}`);
  }
  channelInfo.scales = parseDownsampleScales(downsampleObj, coordFrame.voxelUnit);
  experimentInfo.channels.set(channel, channelInfo);
  return experimentInfo;
}

export function getVolume(
    chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>, path: string) {
  const match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid volume path ${JSON.stringify(path)}`);
  }
  const collection = match[1];
  const experiment = match[2];
  const channel = match[3];
  const parameters = parseQueryStringParameters(match[4] || '');
  // Warning: If additional arguments are added, the cache key should be updated as well.
  return chunkManager.memoize.getUncounted(
      {hostname: hostname, path: path, type: 'boss:getVolume'},
      () => getExperimentInfo(chunkManager, hostname, credentialsProvider, experiment, collection)
                .then(experimentInfo => {
                  return getDownsampleInfoForChannel(
                             chunkManager, hostname, credentialsProvider, collection,
                             experimentInfo, channel)
                      .then(
                          experimentInfoWithDownsample => new MultiscaleVolumeChunkSource(
                              chunkManager, hostname, credentialsProvider,
                              experimentInfoWithDownsample, channel, parameters));
                }));
}

const urlPattern = /^((?:http|https):\/\/[^\/?]+)\/(.*)$/;

export function getCollections(
    chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>) {
  return chunkManager.memoize.getUncounted(
      {hostname: hostname, type: 'boss:getCollections'},
      () => fetchWithBossCredentials(
                credentialsProvider, `${hostname}/latest/collection/`, {}, responseJson)
                .then(
                    value => verifyObjectProperty(
                        value, 'collections', x => parseArray(x, verifyString))));
}

export function getExperiments(
    chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>, collection: string) {
  return chunkManager.memoize.getUncounted(
      {hostname: hostname, collection: collection, type: 'boss:getExperiments'},
      () => fetchWithBossCredentials(
                credentialsProvider, `${hostname}/latest/collection/${collection}/experiment/`, {},
                responseJson)
                .then(
                    value => verifyObjectProperty(
                        value, 'experiments', x => parseArray(x, verifyString))));
}

export function getCoordinateFrame(
    chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>,
    experimentInfo: ExperimentInfo): Promise<ExperimentInfo> {
  let key = experimentInfo.coordFrameKey;
  return chunkManager.memoize.getUncounted(
      {
        hostname: hostname,
        coordinateframe: key,
        experimentInfo: experimentInfo,
        type: 'boss:getCoordinateFrame'
      },
      () =>
          fetchWithBossCredentials(
              credentialsProvider, `${hostname}/latest/coord/${key}/`, {}, responseJson)
              .then(
                  coordinateFrameObj => parseCoordinateFrame(coordinateFrameObj, experimentInfo)));
}

export function collectionExperimentChannelCompleter(
    chunkManager: ChunkManager, hostname: string,
    credentialsProvider: CredentialsProvider<BossToken>, path: string): Promise<CompletionResult> {
  let channelMatch = path.match(/^(?:([^\/]+)(?:\/?([^\/]*)(?:\/?([^\/]*)(?:\/?([^\/]*)?))?)?)?$/);
  if (channelMatch === null) {
    // URL has incorrect format, don't return any results.
    return Promise.reject<CompletionResult>(null);
  }
  if (channelMatch[1] === undefined) {
    // No collection. Reject.
    return Promise.reject<CompletionResult>(null);
  }
  if (channelMatch[2] === undefined) {
    let collectionPrefix = channelMatch[1] || '';
    // Try to complete the collection.
    return getCollections(chunkManager, hostname, credentialsProvider).then(collections => {
      return {
        offset: 0,
        completions: getPrefixMatchesWithDescriptions(
            collectionPrefix, collections, x => x + '/', () => undefined)
      };
    });
  }
  if (channelMatch[3] === undefined) {
    let experimentPrefix = channelMatch[2] || '';
    return getExperiments(chunkManager, hostname, credentialsProvider, channelMatch[1])
        .then(experiments => {
          return {
            offset: channelMatch![1].length + 1,
            completions: getPrefixMatchesWithDescriptions(
                experimentPrefix, experiments, y => y + '/', () => undefined)
          };
        });
  }
  return getExperimentInfo(
             chunkManager, hostname, credentialsProvider, channelMatch[2], channelMatch[1])
      .then(experimentInfo => {
        let completions = getPrefixMatchesWithDescriptions(
            channelMatch![3], experimentInfo.channels, x => x[0], x => {
              return `${x[1].channelType} (${DataType[x[1].dataType]})`;
            });
        return {offset: channelMatch![1].length + channelMatch![2].length + 2, completions};
      });
}

function getAuthServer(endpoint: string): string {
  let baseHostName = endpoint.match(/^(?:https:\/\/[^.]+([^\/]+))/);
  if (baseHostName === null) {
    throw new Error(`Unable to construct auth server hostname from base hostname ${endpoint}.`);
  }
  let authServer = `https://auth${baseHostName[1]}/auth`;
  return authServer;
}

export class BossDataSource extends DataSource {
  constructor(public credentialsManager: CredentialsManager) {
    super();
  }

  get description() {
    return 'The Boss';
  }

  getCredentialsProvider(path: string) {
    let authServer = getAuthServer(path);
    return this.credentialsManager.getCredentialsProvider<BossToken>(credentialsKey, authServer);
  }

  getVolume(chunkManager: ChunkManager, path: string) {
    let match = path.match(urlPattern);
    if (match === null) {
      throw new Error(`Invalid boss volume path: ${JSON.stringify(path)}`);
    }
    let credentialsProvider = this.getCredentialsProvider(path);

    return getVolume(chunkManager, match[1], credentialsProvider, match[2]);
  }

  volumeCompleter(url: string, chunkManager: ChunkManager) {
    let match = url.match(urlPattern);
    if (match === null) {
      // We don't yet have a full hostname.
      return Promise.reject<CompletionResult>(null);
    }
    let hostname = match[1];
    let credentialsProvider = this.getCredentialsProvider(match[1]);
    let path = match[2];
    return collectionExperimentChannelCompleter(chunkManager, hostname, credentialsProvider, path)
        .then(completions => applyCompletionOffset(match![1].length + 1, completions));
  }
}
