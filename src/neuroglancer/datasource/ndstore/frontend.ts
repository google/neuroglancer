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
import {registerDataSourceFactory, CompletionResult, Completion} from 'neuroglancer/datasource/factory';
import {DataType, VolumeType, VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {VolumeChunkSource as GenericVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {vec3} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {verifyOptionalString, verifyString, parseArray, parseFiniteVec, parseIntVec, stableStringify, parseQueryStringParameters} from 'neuroglancer/util/json';
import {cancellableThen, CancellablePromise} from 'neuroglancer/util/promise';

let serverDataTypes = new Map<string, DataType>();
serverDataTypes.set('uint8', DataType.UINT8);
serverDataTypes.set('uint16', DataType.UINT16);
serverDataTypes.set('uint32', DataType.UINT32);
serverDataTypes.set('uint64', DataType.UINT64);

let serverVolumeTypes = new Map<string, VolumeType>();
serverVolumeTypes.set('image', VolumeType.IMAGE);
serverVolumeTypes.set('annotation', VolumeType.SEGMENTATION);

const VALID_ENCODINGS = new Set<string>(['npz', 'raw', 'jpeg']);

export class VolumeChunkSource extends GenericVolumeChunkSource {
  constructor(
      chunkManager: ChunkManager, spec: VolumeChunkSpecification, public hostnames: string[],
      public key: string, public channel: string, public resolution: string,
      public encoding: string) {
    super(chunkManager, spec);
    this.initializeCounterpart(chunkManager.rpc, {
      'type': 'ndstore/VolumeChunkSource',
      'hostnames': hostnames,
      'key': key,
      'channel': channel,
      'resolution': resolution,
      'encoding': encoding,
    });
  }
  toString () {
    return `ndstore:volume:${this.hostnames[0]}/${this.key}/${this.channel}/${this.resolution}/${this.encoding}`;
  }
};


export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  numChannels: number;
  volumeType: VolumeType;

  /**
   * Ndstore channel name.
   */
  channel: string;

  constructor(
      public hostnames: string[], public key: string, public response: any, channel: string|undefined,
      public parameters: {[index: string]: any}) {
    let channelsObject = response['channels'];
    let channelNames = Object.keys(channelsObject);
    if (channel === undefined) {
      if (channelNames.length !== 1) {
        throw new Error(`Dataset contains multiple channels: ${JSON.stringify(channelNames)}`);
      }
      channel = channelNames[0];
    } else if (channelNames.indexOf(channel) === -1) {
      throw new Error(
          `Specified channel ${JSON.stringify(channel)} is not one of the supported channels ${JSON.stringify(channelNames)}`);
    }
    this.channel = channel;
    let channelObject = channelsObject[channel];
    let volumeType = serverVolumeTypes.get(channelObject['channel_type']);
    if (volumeType === undefined) {
      volumeType = VolumeType.UNKNOWN;
    }
    this.volumeType = volumeType;
    let dataTypeStr = channelObject['datatype'];
    let dataType = this.dataType = serverDataTypes.get(dataTypeStr);
    if (dataType === undefined) {
      throw new Error(`Unsupported data type ${JSON.stringify(dataTypeStr)}`);
    }
    this.numChannels = 1;
  }

  getSources(chunkManager: ChunkManager) {
    let sources: VolumeChunkSource[][] = [];
    const {response, volumeType} = this;
    const datasetObject = response['dataset'];
    let encoding = verifyOptionalString(this.parameters['encoding']);
    if (encoding === undefined) {
      encoding = volumeType === VolumeType.IMAGE ? 'jpeg' : 'npz';
    } else {
      if (!VALID_ENCODINGS.has(encoding)) {
        throw new Error(`Invalid encoding: ${JSON.stringify(encoding)}.`);
      }
    }
    for (let resolution of Object.keys(datasetObject['neariso_imagesize'])) {
      let imageSize = parseIntVec(vec3.create(), datasetObject['neariso_imagesize'][resolution]);
      let voxelSize = parseFiniteVec(vec3.create(), datasetObject['neariso_voxelres'][resolution]);
      let chunkSize = parseIntVec(vec3.create(), datasetObject['cube_dimension'][resolution]);
      let alternatives: VolumeChunkSource[] = [];
      sources.push(alternatives);
      // The returned offset for downsampled resolutions can have non-integer components.  It
      // appears that the true offset is obtained by rounding up.
      let origLowerVoxelBound =
          parseFiniteVec(vec3.create(), datasetObject['neariso_offset'][resolution]);
      let lowerVoxelBound = vec3.create();
      let upperVoxelBound = vec3.create();
      for (let i = 0; i < 3; ++i) {
        let origLower = origLowerVoxelBound[i];
        lowerVoxelBound[i] = Math.ceil(origLower);
        upperVoxelBound[i] = Math.floor(origLower + imageSize[i]);
      }
      for (let spec of VolumeChunkSpecification.getDefaults({
             volumeType,
             voxelSize,
             dataType: this.dataType, lowerVoxelBound, upperVoxelBound,
             chunkDataSizes: [ chunkSize ]
           })) {
        let cacheKey = stableStringify(
            {'spec': spec, key: this.key, channel: this.channel, resolution: resolution});
        alternatives.push(chunkManager.getChunkSource(
            VolumeChunkSource, cacheKey,
            () => new VolumeChunkSource(
                chunkManager, spec, this.hostnames, this.key, this.channel, resolution, encoding)));
      }
    }
    return sources;
  }

  /**
   * Meshes are not supported.
   */
  getMeshSource(chunkManager: ChunkManager): null { return null; }
};

const pathPattern = /^([^\/?]+)(?:\/([^\/?]+))?(?:\?(.*))?$/;

let existingVolumeResponses = new Map<string, Promise<any>>();
export function getVolumeInfo(hostnames: string[], token: string) {
  let fullKey = JSON.stringify({'hostnames': hostnames, 'token': token});
  let result = existingVolumeResponses.get(fullKey);
  if (result !== undefined) {
    return result;
  }
  let promise = sendHttpRequest(openShardedHttpRequest(hostnames, `/ocp/ca/${token}/info/`), 'json');
  existingVolumeResponses.set(fullKey, promise);
  return promise;
}

let existingVolumes = new Map<string, Promise<MultiscaleVolumeChunkSource>>();
export function getShardedVolume(hostnames: string[], path: string) {
  let match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid volume path ${JSON.stringify(path)}`);
  }
  // Warning: If additional arguments are added, fullKey should be updated as well.
  let fullKey = stableStringify({'hostnames': hostnames, 'path': path});
  let existingResult = existingVolumes.get(fullKey);
  if (existingResult !== undefined) {
    return existingResult;
  }
  let key = match[1];
  let channel = match[2];
  let parameters = parseQueryStringParameters(match[3] || '');
  let promise = getVolumeInfo(hostnames, key)
                    .then(
                        response => new MultiscaleVolumeChunkSource(
                            hostnames, key, response, channel, parameters));
  existingVolumes.set(fullKey, promise);
  return promise;
}

const urlPattern = /^((?:http|https):\/\/[^\/?]+)\/(.*)$/;

export function getVolume(path: string) {
  let match = path.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid ndstore volume path: ${JSON.stringify(path)}`);
  }
  return getShardedVolume([match[1]], match[2]);
}

const publicTokenPromises = new Map<string, Promise<string[]>>();
export function getPublicTokens(hostnames: string[]) {
  let key = JSON.stringify(hostnames);
  let result = publicTokenPromises.get(key);
  if (result !== undefined) {
    return result;
  }
  let newResult =
      sendHttpRequest(openShardedHttpRequest(hostnames, '/ocp/ca/public_tokens/'), 'json')
          .then(value => parseArray(value, verifyString));
  publicTokenPromises.set(key, newResult);
  return newResult;
}

export function tokenAndChannelCompleter(hostnames: string[], path: string): CancellablePromise<CompletionResult> {
  let channelMatch = path.match(/^(?:([^\/]+)(?:\/([^\/]*))?)?$/);
  if (channelMatch === null) {
    // URL has incorrect format, don't return any results.
    return Promise.reject<CompletionResult>(null);
  }
  if (channelMatch[2] === undefined) {
    let keyPrefix = channelMatch[1] || '';
    // Try to complete the token.
    return getPublicTokens(hostnames).then(tokens => {
      return {
        offset: 0,
        completions:
            getPrefixMatchesWithDescriptions(keyPrefix, tokens, x => x + '/', x => undefined)
      };
    });
  }
  return cancellableThen(getVolumeInfo(hostnames, channelMatch[1]), response => {
    let completions: Completion[] = [];
    if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
      let channelsObject = response['channels'];
      if (typeof channelsObject === 'object' && channelsObject !== null &&
          !Array.isArray(channelsObject)) {
        let channelNames = Object.keys(channelsObject);
        completions =
            getPrefixMatchesWithDescriptions(channelMatch[2], channelNames, x => x, x => {
              let channelObject = channelsObject[x];
              return `${channelObject['channel_type']} (${channelObject['datatype']})`;

            });
      }
    }
    return {offset: channelMatch[1].length + 1, completions};
  });
}

export function volumeCompleter(url: string): CancellablePromise<CompletionResult> {
  let match = url.match(urlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let hostnames = [match[1]];
  let path = match[2];
  return cancellableThen(
      tokenAndChannelCompleter(hostnames, path),
      completions => applyCompletionOffset(match[1].length + 1, completions));
}

registerDataSourceFactory('ndstore', {
  description: 'NDstore',
  volumeCompleter: volumeCompleter,
  getVolume: getVolume,
});
