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
 * Support for The Boss (https://github.com/jhuapl-boss) services.
 */

import 'neuroglancer/datasource/boss/api_frontend';

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CompletionResult, registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {makeRequest} from 'neuroglancer/datasource/boss/api';
import {VolumeChunkSourceParameters, MeshSourceParameters} from 'neuroglancer/datasource/boss/base';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {defineParameterizedVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {defineParameterizedMeshSource} from 'neuroglancer/mesh/frontend';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {mat4, vec3, vec2} from 'neuroglancer/util/geom';
import {parseArray, parseQueryStringParameters, verify3dDimensions, verify3dScale, verifyEnumString, verifyInt, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyOptionalString, verifyString, verifyFiniteFloat} from 'neuroglancer/util/json';

let serverVolumeTypes = new Map<string, VolumeType>();
serverVolumeTypes.set('image', VolumeType.IMAGE);
serverVolumeTypes.set('annotation', VolumeType.SEGMENTATION);

const VALID_ENCODINGS = new Set<string>(['npz', 'jpeg']);  //, 'raw', 'jpeg']);

const DEFAULT_CUBOID_SIZE = vec3.fromValues(512, 512, 16);

const VolumeChunkSource = defineParameterizedVolumeChunkSource(VolumeChunkSourceParameters);
const MeshSource = defineParameterizedMeshSource(MeshSourceParameters);

interface ChannelInfo {
  channelType: string;
  volumeType: VolumeType;
  dataType: DataType;
  downsampled: boolean;
  description: string;
  key: string;
}

interface CoordinateFrameInfo {
  voxelSizeBase: vec3;
  voxelOffsetBase: vec3;
  imageSizeBase: vec3;
}

interface ScaleInfo {
  voxelSize: vec3;
  imageSize: vec3;
  key: string;
}

interface ExperimentInfo {
  channels: Map<string, ChannelInfo>;
  scalingLevels: number;
  coordFrameKey: string;
  coordFrame: CoordinateFrameInfo;
  scales: ScaleInfo[];
  key: string;
  collection: string;
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

  experimentInfo.coordFrame = {voxelSizeBase, voxelOffsetBase, imageSizeBase};
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
    key: verifyObjectProperty(obj, 'name', verifyString),
  };
}

function parseExperimentInfo(
    obj: any, chunkManager: ChunkManager, hostnames: string[], authServer: string, collection: string,
    experiment: string): Promise<ExperimentInfo> {
  verifyObject(obj);

  let channelPromiseArray = verifyObjectProperty(
      obj, 'channels',
      x => parseArray(
          x, x => getChannelInfo(chunkManager, hostnames, authServer, experiment, collection, x)));
  return Promise.all(channelPromiseArray)
    .then(channelArray => {
      let channels: Map<string, ChannelInfo> = new Map<string, ChannelInfo>();
      channelArray.forEach(channel => {channels.set(channel.key, channel)});
      let firstChannel = channels.values().next().value;
      
      return getDownsampleInfo(chunkManager, hostnames, authServer, collection, experiment, firstChannel.key).then(downsampleInfo => { return {
        channels: channels,
            scalingLevels: verifyObjectProperty(obj, 'num_hierarchy_levels', verifyInt),
            coordFrameKey: verifyObjectProperty(obj, 'coord_frame', verifyString), scales: downsampleInfo,
            key: verifyObjectProperty(obj, 'name', verifyString),
            collection: verifyObjectProperty(obj, 'collection', verifyString),
      }});
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
  window: vec2 | undefined;

  constructor(
      public chunkManager: ChunkManager, public baseUrls: string[], public authServer: string,
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
          `Specified channel ${JSON.stringify(channel)} is not one of the supported channels ${JSON.stringify(Array.from(experimentInfo.channels.keys()))}`);
    }
    this.channel = channel;
    this.channelInfo = channelInfo;
    this.scales = experimentInfo.scales;
    this.coordinateFrame = experimentInfo.coordFrame;
    if (this.channelInfo.downsampled === false) {
      this.scales = [experimentInfo.scales[0]]; 
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
        throw new Error(`Invalid window. Must be either one value or two comma separated values: ${JSON.stringify(window)}`);
      }
      this.window = windowobj;
      if (this.window[0] === this.window[1]) {
        throw new Error(`Invalid window. First element must be different from second: ${JSON.stringify(window)}.`);
      }
    }

    let meshUrl = verifyOptionalString(parameters['meshurl']);
    if (meshUrl !== undefined) {
      this.meshUrl = meshUrl; 
    }
    let meshPath = verifyOptionalString(parameters['meshpath']);
    if (meshPath !== undefined) {
      if (meshPath[0] !== '/') {
        meshPath = `/${meshPath}`;
      }
      this.meshPath = meshPath; 
    }
    
    /*
    this.cuboidSize = DEFAULT_CUBOID_SIZE;
    let cuboidXY = verifyOptionalString(parameters['xySize']);
    if (cuboidXY !== undefined) {
      this.cuboidSize[0] = this.cuboidSize[1] = verifyInt(cuboidXY);
    }
    let cuboidZ = verifyOptionalString(parameters['zSize']);
    if (cuboidZ !== undefined) {
      this.cuboidSize[2] = verifyInt(cuboidZ);
    }
    */
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
      let {voxelSize, imageSize} = scaleInfo;
      let voxelOffset = this.coordinateFrame.voxelOffsetBase;
      let baseVoxelOffset = vec3.create();
      for (let i = 0; i < 3; ++i) {
        baseVoxelOffset[i] = Math.ceil(voxelOffset[i]);
      }
      return VolumeChunkSpecification
          .getDefaults({
            numChannels: this.numChannels,
            volumeType: this.volumeType,
            dataType: this.dataType, voxelSize,
            chunkDataSizes: [DEFAULT_CUBOID_SIZE],
            transform: mat4.fromTranslation(
                mat4.create(), vec3.multiply(vec3.create(), voxelOffset, voxelSize)),
            baseVoxelOffset,
            upperVoxelBound: imageSize, volumeSourceOptions,
          })
          .map(spec => VolumeChunkSource.get(this.chunkManager, spec, {
            baseUrls: this.baseUrls,
            authServer: this.authServer,
            collection: this.experimentInfo.collection,
            experiment: this.experimentInfo.key,
            channel: this.channel,
            resolution: scaleInfo.key,
            encoding: this.encoding,
            token: 'null',
            window: this.window,
          }));
    });
  }

  getMeshSource() { 
    if (this.meshPath !== undefined) {
      if (this.meshUrl === undefined) {
        this.meshUrl = 'https://api.theboss.io';
      }
      return MeshSource.get(this.chunkManager, {'baseUrls': [this.meshUrl], 'path': this.meshPath}); 
    }
    return null; 
  }
};

const pathPattern = /^([^\/?]+)\/([^\/?]+)(?:\/([^\/?]+))?(?:\?(.*))?$/;

export function getExperimentInfo(
    chunkManager: ChunkManager, hostnames: string[], authServer: string, experiment: string,
    collection: string): Promise<ExperimentInfo> {
  return chunkManager.memoize.getUncounted(
      {'hostnames': hostnames, 'experiment': experiment, 'collection': collection},
      () => makeRequest(
                hostnames, authServer, {method: 'GET', path: `/latest/collection/${collection}/experiment/${experiment}/`, responseType: 'json'})
                .then(
                    value => parseExperimentInfo(
                        value, chunkManager, hostnames, authServer, collection, experiment)));
}

export function getChannelInfo(
    chunkManager: ChunkManager, hostnames: string[], authServer: string, experiment: string,
    collection: string, channel: string): Promise<ChannelInfo> {
  return chunkManager.memoize.getUncounted(
      {
        'hostnames': hostnames,
        'collection': collection,
        'experiment': experiment,
        'channel': channel
      },
      () => makeRequest(
                hostnames, authServer, {method: 'GET', path: 
                `/latest/collection/${collection}/experiment/${experiment}/channel/${channel}/`, responseType: 'json'})
                .then(parseChannelInfo))
}

export function getDownsampleInfo(chunkManager: ChunkManager, hostnames: string[], authServer: string, collection: string, experiment: string, channel: string): Promise<any> {
  return chunkManager.memoize.getUncounted({
    'hostnames': hostnames,
    'collection': collection,
    'experiment': experiment,
    'channel': channel,
    'downsample': true
  },
  () => makeRequest(
    hostnames, authServer, {method: 'GET', path: `/latest/downsample/${collection}/${experiment}/${channel}/`, responseType: 'json'})
  ).then(parseDownsampleInfo);
}

export function parseDownsampleInfo(downsampleObj: any): ScaleInfo[] {
  verifyObject(downsampleObj);

  let voxelSizes = verifyObjectProperty(downsampleObj, 'voxel_size', x => verifyObjectAsMap(x, verify3dScale));
  let imageSizes = verifyObjectProperty(downsampleObj, 'extent', x => verifyObjectAsMap(x, verify3dDimensions));

  let num_hierarchy_levels = verifyObjectProperty(downsampleObj, 'num_hierarchy_levels', verifyInt);  

  let scaleInfo = new Array<ScaleInfo>();
  for(let i=0 ; i<num_hierarchy_levels ; i++) {
    let key: string = String(i);
    const voxelSize = voxelSizes.get(key);
    const imageSize = imageSizes.get(key);
    if (voxelSize === undefined || imageSize === undefined) {
      throw new Error(
          `Missing voxel_size/extent for resolution ${key}.`);
    }
    scaleInfo[i] = {voxelSize, imageSize, key};
  }
  return scaleInfo;
}

export function getShardedVolume(chunkManager: ChunkManager, hostnames: string[], authServer: string, path: string) {
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
        {'hostnames': hostnames, 'path': path},
        () => getExperimentInfo(chunkManager, hostnames, authServer, experiment, collection)
                  .then(
                      experimentInfo => getCoordinateFrame(
                                            chunkManager, hostnames, authServer,
                                            experimentInfo.coordFrameKey, experimentInfo)
                                            .then(
                                                experimentInfo => new MultiscaleVolumeChunkSource(
                                                    chunkManager, hostnames, authServer, experimentInfo,
                                                    channel, parameters))));
}

const urlPattern = /^((?:http|https):\/\/[^\/?]+)\/(.*)$/;

export function getVolume(chunkManager: ChunkManager, path: string) {
  let match = path.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid boss volume path: ${JSON.stringify(path)}`);
  }
  let authServer = getAuthServer(path);
  return getShardedVolume(chunkManager, [match[1]], authServer, match[2]);
}

export function getCollections(chunkManager: ChunkManager, hostnames: string[], authServer: string) {
  return chunkManager.memoize.getUncounted(
      hostnames,
      () => makeRequest(hostnames, authServer, {method: 'GET', path: '/latest/collection/', responseType: 'json'})
                .then(
                    value => verifyObjectProperty(
                        value, 'collections', x => parseArray(x, verifyString))));
}

export function getExperiments(
    chunkManager: ChunkManager, hostnames: string[], authServer: string, collection: string) {
  return chunkManager.memoize.getUncounted(
      {'hostnames': hostnames, 'collection': collection},
      () =>
          makeRequest(hostnames, authServer, {method: 'GET', path: `/latest/collection/${collection}/experiment/`, responseType: 'json'})
              .then(
                  value => verifyObjectProperty(
                    value, 'experiments', x => parseArray(x, verifyString))));
}

export function getCoordinateFrame(
    chunkManager: ChunkManager, hostnames: string[], authServer: string, key: string,
    experimentInfo: ExperimentInfo): Promise<ExperimentInfo> {
  return chunkManager.memoize.getUncounted(
      {'hostnames': hostnames, 'coordinateframe': key},
      () =>
          makeRequest(hostnames, authServer, {method: 'GET', path: `/latest/coord/${key}/`, responseType: 'json'})
              .then(
                  coordinateFrameObj => parseCoordinateFrame(coordinateFrameObj, experimentInfo)));
}

export function collectionExperimentChannelCompleter(
    chunkManager: ChunkManager, hostnames: string[], authServer: string,
    path: string): Promise<CompletionResult> {

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
      return getCollections(chunkManager, hostnames, authServer)
        .then(collections => {
          return {
            offset: 0,
            completions: getPrefixMatchesWithDescriptions(
                collectionPrefix, collections, x => x + '/', () => undefined)
          };
      });
    }
    if (channelMatch[3] === undefined) {
      let experimentPrefix = channelMatch[2] || '';
      return getExperiments(chunkManager, hostnames, authServer, channelMatch[1])
          .then(experiments => {
            return {
              offset: channelMatch![1].length + 1,
              completions: getPrefixMatchesWithDescriptions(
                  experimentPrefix, experiments, y => y + '/', () => undefined)
            };
          }); 
    }
    return getExperimentInfo(chunkManager, hostnames, authServer, channelMatch[2], channelMatch[1]).then(experimentInfo => {
      let completions = getPrefixMatchesWithDescriptions(
              channelMatch![3], experimentInfo.channels, x => x[0], x => {
                return `${x[1].channelType} (${DataType[x[1].dataType]})`;
              });
        return {offset: channelMatch![1].length + channelMatch![2].length + 2, completions};
    });
}

export function volumeCompleter(
    url: string, chunkManager: ChunkManager): Promise<CompletionResult> {
  let match = url.match(urlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let hostnames = [match[1]];
  let authServer = getAuthServer(match[1]);
  let path = match[2];
  return collectionExperimentChannelCompleter(chunkManager, hostnames, authServer, path)
    .then(completions => applyCompletionOffset(match![1].length + 1, completions));
}

function getAuthServer(endpoint: string): string {
  let baseHostName = endpoint.match(/^(?:https:\/\/[^.]+([^\/]+))/);
  if (baseHostName === null) {
    throw new Error(`Unable to construct auth server hostname from base hostname ${endpoint}.`);
  }
  let authServer = `https://auth${baseHostName[1]}/auth`;
  return authServer; 
}

registerDataSourceFactory('boss', {
  description: 'The Boss',
  volumeCompleter: volumeCompleter,
  getVolume: getVolume,
});