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
 * Support for NDstore (https://github.com/neurodata/ndstore) servers.
 */

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CompletionResult, registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {VolumeChunkSourceParameters, NDSTORE_URL_PREFIX, LEGACY_URL_PREFIX} from 'neuroglancer/datasource/ndstore/base';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/base';
import {defineParameterizedVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {parseArray, parseQueryStringParameters, verify3dDimensions, verify3dScale, verify3dVec, verifyEnumString, verifyInt, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';

let serverVolumeTypes = new Map<string, VolumeType>();
serverVolumeTypes.set('image', VolumeType.IMAGE);
serverVolumeTypes.set('annotation', VolumeType.SEGMENTATION);

const VALID_ENCODINGS = new Set<string>(['npz', 'raw', 'jpeg']);

const VolumeChunkSource = defineParameterizedVolumeChunkSource(VolumeChunkSourceParameters);

interface ChannelInfo {
  channelType: string;
  volumeType: VolumeType;
  dataType: DataType;
  description: string;
}

interface ScaleInfo {
  voxelSize: vec3;
  voxelOffset: vec3;
  imageSize: vec3;
  key: string;
}

function parseScales(datasetObj: any): ScaleInfo[] {
  verifyObject(datasetObj);
  let voxelSizes = verifyObjectProperty(
      datasetObj, 'neariso_voxelres', x => verifyObjectAsMap(x, verify3dScale));
  let imageSizes = verifyObjectProperty(
      datasetObj, 'neariso_imagesize', x => verifyObjectAsMap(x, verify3dDimensions));
  let voxelOffsets =
      verifyObjectProperty(datasetObj, 'neariso_offset', x => verifyObjectAsMap(x, verify3dVec));
  let resolutions = verifyObjectProperty(datasetObj, 'resolutions', x => parseArray(x, verifyInt));
  return resolutions.map(resolution => {
    const key = '' + resolution;
    const voxelSize = voxelSizes.get(key);
    const imageSize = imageSizes.get(key);
    let voxelOffset = voxelOffsets.get(key);
    if (voxelSize === undefined || imageSize === undefined || voxelOffset === undefined) {
      throw new Error(
          `Missing neariso_voxelres/neariso_imagesize/neariso_offset for resolution ${resolution}.`);
    }
    return {key, voxelSize, imageSize, voxelOffset};
  });
}

interface TokenInfo {
  channels: Map<string, ChannelInfo>;
  scales: ScaleInfo[];
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
  let channelType = verifyObjectProperty(obj, 'channel_type', verifyString);
  return {
    channelType,
    description: verifyObjectProperty(obj, 'description', verifyString),
    volumeType: getVolumeTypeFromChannelType(channelType),
    dataType: verifyObjectProperty(obj, 'datatype', x => verifyEnumString(x, DataType)),
  };
}

function parseTokenInfo(obj: any): TokenInfo {
  verifyObject(obj);
  return {
    channels: verifyObjectProperty(obj, 'channels', x => verifyObjectAsMap(x, parseChannelInfo)),
    scales: verifyObjectProperty(obj, 'dataset', parseScales),
  };
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  get dataType() { return this.channelInfo.dataType; }
  get numChannels() { return 1; }
  get volumeType() { return this.channelInfo.volumeType; }

  /**
   * Ndstore channel name.
   */
  channel: string;

  channelInfo: ChannelInfo;
  scales: ScaleInfo[];

  urlPrefix: string = NDSTORE_URL_PREFIX;
  neariso: boolean = true;
  encoding: string;

  constructor(
      public chunkManager: ChunkManager, public baseUrls: string[], public key: string,
      public tokenInfo: TokenInfo, channel: string|undefined, urlprefix: string|undefined,
      public parameters: {[index: string]: any}) {
    if (channel === undefined) {
      const channelNames = Array.from(tokenInfo.channels.keys());
      if (channelNames.length !== 1) {
        throw new Error(`Dataset contains multiple channels: ${JSON.stringify(channelNames)}`);
      }
      channel = channelNames[0];
    }
    const channelInfo = tokenInfo.channels.get(channel);
    if (channelInfo === undefined) {
      throw new Error(
          `Specified channel ${JSON.stringify(channel)} is not one of the supported channels ${JSON.stringify(Array.from(tokenInfo.channels.keys()))}`);
    }
    this.channel = channel;
    this.channelInfo = channelInfo;
    this.scales = tokenInfo.scales;

    if (urlprefix !== undefined) {
      this.urlPrefix = urlprefix;
    }

    let neariso = verifyOptionalString(parameters['neariso']);
    if (neariso === 'false') {
      this.neariso = false;
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
      let {voxelOffset, voxelSize} = scaleInfo;
      let baseVoxelOffset = vec3.create();
      for (let i = 0; i < 3; ++i) {
        baseVoxelOffset[i] = Math.ceil(voxelOffset[i]);
      }
      return VolumeChunkSpecification
          .getDefaults({
            numChannels: this.numChannels,
            volumeType: this.volumeType,
            dataType: this.dataType, voxelSize,
            transform: mat4.fromTranslation(
                mat4.create(), vec3.multiply(vec3.create(), voxelOffset, voxelSize)),
            baseVoxelOffset,
            upperVoxelBound: scaleInfo.imageSize, volumeSourceOptions,
          })
          .map(spec => VolumeChunkSource.get(this.chunkManager, spec, {
            baseUrls: this.baseUrls,
            urlPrefix: this.urlPrefix,
            key: this.key,
            channel: this.channel,
            resolution: scaleInfo.key,
            encoding: this.encoding,
            neariso: this.neariso
          }));
    });
  }

  /**
   * Meshes are not supported.
   */
  getMeshSource(): null { return null; }
};

const pathPattern = /^([^\/?]+)(?:\/([^\/?]+))?(?:\?(.*))?$/;

export function getTokenInfo(chunkManager: ChunkManager, hostnames: string[], token: string, urlprefix: string): Promise<TokenInfo> {
  return chunkManager.memoize.getUncounted(
      {type: 'ndstore:getTokenInfo', hostnames, token},
      () => sendHttpRequest(openShardedHttpRequest(hostnames, `${urlprefix}/${token}/info/`), 'json')
                .then(parseTokenInfo));
}

export function getShardedVolume(chunkManager: ChunkManager, hostnames: string[], path: string, urlprefix: string) {
  const match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid volume path ${JSON.stringify(path)}`);
  }
  const key = match[1];
  const channel = match[2];
  const parameters = parseQueryStringParameters(match[3] || '');

  // Warning: If additional arguments are added, the cache key should be updated as well.
  return chunkManager.memoize.getUncounted(
      {type: 'ndstore:MultiscaleVolumeChunkSource', hostnames, path},
      () => getTokenInfo(chunkManager, hostnames, key, urlprefix)
                .then(
                    tokenInfo => new MultiscaleVolumeChunkSource(
                        chunkManager, hostnames, key, tokenInfo, channel, urlprefix, parameters)));
}

const urlPattern = /^((?:http|https):\/\/[^\/?]+)\/(.*)$/;

export function getVolume(chunkManager: ChunkManager, path: string) {
  let match = path.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid ndstore volume path: ${JSON.stringify(path)}`);
  }
  return getShardedVolume(chunkManager, [match[1]], match[2], NDSTORE_URL_PREFIX);
}

export function getPublicTokens(chunkManager: ChunkManager, hostnames: string[], urlprefix: string) {
  return chunkManager.memoize.getUncounted(
      {type: 'dvid:getPublicTokens', hostnames},
      () => sendHttpRequest(openShardedHttpRequest(hostnames, `${urlprefix}/public_tokens/`), 'json')
                .then(value => parseArray(value, verifyString)));
}

export function tokenAndChannelCompleter(
    chunkManager: ChunkManager, hostnames: string[], path: string, urlprefix: string): Promise<CompletionResult> {
  let channelMatch = path.match(/^(?:([^\/]+)(?:\/([^\/]*))?)?$/);
  if (channelMatch === null) {
    // URL has incorrect format, don't return any results.
    return Promise.reject<CompletionResult>(null);
  }
  if (channelMatch[2] === undefined) {
    let keyPrefix = channelMatch[1] || '';
    // Try to complete the token.
    return getPublicTokens(chunkManager, hostnames, urlprefix).then(tokens => {
      return {
        offset: 0,
        completions:
            getPrefixMatchesWithDescriptions(keyPrefix, tokens, x => x + '/', () => undefined)
      };
    });
  }
  return getTokenInfo(chunkManager, hostnames, channelMatch[1], urlprefix).then(tokenInfo => {
    let completions =
        getPrefixMatchesWithDescriptions(channelMatch![2], tokenInfo.channels, x => x[0], x => {
          return `${x[1].channelType} (${DataType[x[1].dataType]})`;
        });
    return {offset: channelMatch![1].length + 1, completions};
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
  let path = match[2];
  return tokenAndChannelCompleter(chunkManager, hostnames, path, NDSTORE_URL_PREFIX)
      .then(completions => applyCompletionOffset(match![1].length + 1, completions));
}

registerDataSourceFactory('ndstore', {
  description: 'NDstore',
  volumeCompleter: volumeCompleter,
  getVolume: getVolume,
});
