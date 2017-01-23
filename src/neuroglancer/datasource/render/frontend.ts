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
 * Support for Render (https://github.com/saalfeldlab/render) servers.
 */

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CompletionResult, registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {TileChunkSourceParameters} from 'neuroglancer/datasource/render/base';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/base';
import {defineParameterizedVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {vec3} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {parseArray, parseQueryStringParameters, verifyFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {CancellablePromise, cancellableThen} from 'neuroglancer/util/promise';

const VALID_ENCODINGS = new Set<string>(['jpg']);

const TileChunkSource = defineParameterizedVolumeChunkSource(TileChunkSourceParameters);

const VALID_STACK_STATES = new Set<string>(['COMPLETE']);

interface OwnerInfo {
  owner: string;
  stacks: Map<string, StackInfo>;
}

interface StackInfo {
  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;
  voxelResolution: vec3; /* in nm */
  mipMapLevels: number;
  project: string;
}

function parseOwnerInfo(obj: any): OwnerInfo {
  let stackObjs = parseArray(obj, verifyObject);

  if (stackObjs.length < 1) {
    throw new Error(`No stacks found for owner object.`);
  }
  
  let stacks = new Map<string, StackInfo>();

  // Get the owner from the first stack
  let owner = verifyObjectProperty(stackObjs[0], 'stackId', parseStackOwner);

  for (let stackObj of stackObjs) {
    let stackName = verifyObjectProperty(stackObj, 'stackId', parseStackName);
    let stackInfo = parseStackInfo(stackObj); 
    if (stackInfo !== undefined) {
      stacks.set(stackName, parseStackInfo(stackObj));
    }
  }

  return {owner, stacks};
}

function parseStackName(stackIdObj: any): string {
  verifyObject(stackIdObj);
  return verifyObjectProperty(stackIdObj, 'stack', verifyString);
}

function parseStackOwner(stackIdObj: any): string {
  verifyObject(stackIdObj);
  return verifyObjectProperty(stackIdObj, 'owner', verifyString);
}

function parseStackInfo(obj: any): StackInfo | undefined {
  verifyObject(obj);

  let state = verifyObjectProperty(obj, 'state', verifyString); 
  if (!VALID_STACK_STATES.has(state)) {
    return undefined; 
  }

  let lowerVoxelBound: vec3 = verifyObjectProperty(obj, 'stats', parseLowerVoxelBounds);
  let upperVoxelBound: vec3 = verifyObjectProperty(obj, 'stats', parseUpperVoxelBounds);

  let voxelResolution: vec3 = verifyObjectProperty(obj, 'currentVersion', parseStackVersionInfo);

  let mipMapLevels: number =
      verifyObjectProperty(obj, 'currentMipmapPathBuilder', parseMipMapLevels);

  let project: string = verifyObjectProperty(obj, 'stackId', parseStackProject);

  return {lowerVoxelBound, upperVoxelBound, voxelResolution, mipMapLevels, project};
}

function parseUpperVoxelBounds(stackStatsObj: any): vec3 {
  verifyObject(stackStatsObj);
  let stackBounds = verifyObjectProperty(stackStatsObj, 'stackBounds', verifyObject);

  let upperVoxelBound: vec3 = vec3.create();

  upperVoxelBound[0] = verifyObjectProperty(stackBounds, 'maxX', verifyInt);
  upperVoxelBound[1] = verifyObjectProperty(stackBounds, 'maxY', verifyInt);
  upperVoxelBound[2] = verifyObjectProperty(stackBounds, 'maxZ', verifyInt);

  for (let i = 0; i < 3; i++) {
    upperVoxelBound[i] += 1;
  }

  return upperVoxelBound;
}

function parseLowerVoxelBounds(stackStatsObj: any): vec3 {
  verifyObject(stackStatsObj);
  let stackBounds = verifyObjectProperty(stackStatsObj, 'stackBounds', verifyObject);

  let lowerVoxelBound: vec3 = vec3.create();

  lowerVoxelBound[0] = verifyObjectProperty(stackBounds, 'minX', verifyInt);
  lowerVoxelBound[1] = verifyObjectProperty(stackBounds, 'minY', verifyInt);
  lowerVoxelBound[2] = verifyObjectProperty(stackBounds, 'minZ', verifyInt);

  return lowerVoxelBound;
}

function parseStackVersionInfo(stackVersionObj: any): vec3 {
  verifyObject(stackVersionObj);
  let voxelResolution: vec3 = vec3.create();
  try {
    voxelResolution[0] = verifyObjectProperty(stackVersionObj, 'stackResolutionX', verifyFloat);
    voxelResolution[1] = verifyObjectProperty(stackVersionObj, 'stackResolutionY', verifyFloat);
    voxelResolution[2] = verifyObjectProperty(stackVersionObj, 'stackResolutionZ', verifyFloat);
  } catch (ignoredError) {
    // default is 1, 1, 1
    voxelResolution[0] = 1;
    voxelResolution[1] = 1;
    voxelResolution[2] = 1;
  }

  return voxelResolution;
}

function parseMipMapLevels(_currentMipMapPathBuilderObj: any): number {
  let levels = 0;
  /*
  try {
    levels = verifyObjectProperty(currentMipMapPathBuilderObj, 'numberOfLevels', verifyInt);
  } catch (ignoredError) {
    // TODO: Something better than console.log for passing messages?
    console.log('No Mip Map Levels specified. Using default of 0.');
  }
  */
  return levels;
}

function parseStackProject(stackIdObj: any): string {
  verifyObject(stackIdObj);
  return verifyObjectProperty(stackIdObj, 'project', verifyString);
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  get dataType() {
    return DataType.UINT8;
  }
  get numChannels() {
    return 3;
  }  // TODO: parse RGB(A) vs single channel
  get volumeType() {
    return VolumeType.IMAGE;
  }

  stack: string;
  stackInfo: StackInfo;

  dims: vec3;

  encoding: string;

  constructor(
      public chunkManager: ChunkManager, public baseUrls: string[], public ownerInfo: OwnerInfo,
      stack: string|undefined, public parameters: {[index: string]: any}) {
    if (stack === undefined) {
      const stackNames = Array.from(ownerInfo.stacks.keys());
      if (stackNames.length !== 1) {
        throw new Error(`Dataset contains multiple stacks: ${JSON.stringify(stackNames)}`);
      }
      stack = stackNames[0];
    }
    const stackInfo = ownerInfo.stacks.get(stack);
    if (stackInfo === undefined) {
      throw new Error(
          `Specified stack ${JSON.stringify(stack)} is not one of the supported stacks ${JSON.stringify(Array.from(ownerInfo.stacks.keys()))}`);
    }
    this.stack = stack;
    this.stackInfo = stackInfo;

    let encoding = verifyOptionalString(parameters['encoding']);
    if (encoding === undefined) {
      encoding = 'jpg';
    } else {
      if (!VALID_ENCODINGS.has(encoding)) {
        throw new Error(`Invalid encoding: ${JSON.stringify(encoding)}.`);
      }
    }
    this.encoding = encoding;

    this.dims = vec3.create();
    this.dims[0] = 512;
    this.dims[1] = 512;
    this.dims[2] = 1;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let sources: VolumeChunkSource[][] = [];

    for (let level = 0; level <= this.stackInfo.mipMapLevels; level++) {
      let voxelSize = vec3.clone(this.stackInfo.voxelResolution);
      let chunkDataSize = vec3.fromValues(1, 1, 1);
      // tiles are NxMx1
      for (let i = 0; i < 2; ++i) {
        voxelSize[i] = voxelSize[i] * Math.pow(2, level);
        chunkDataSize[i] = this.dims[i];
      }

      let lowerVoxelBound = vec3.create(), upperVoxelBound = vec3.create();

      for (let i = 0; i < 3; i++) {
        lowerVoxelBound[i] = Math.floor(
            this.stackInfo.lowerVoxelBound[i] * (this.stackInfo.voxelResolution[i] / voxelSize[i]));
        upperVoxelBound[i] = Math.ceil(
            this.stackInfo.upperVoxelBound[i] * (this.stackInfo.voxelResolution[i] / voxelSize[i]));
      }

      let spec = VolumeChunkSpecification.make({
        voxelSize,
        chunkDataSize,
        numChannels: this.numChannels,
        dataType: this.dataType, lowerVoxelBound, upperVoxelBound, volumeSourceOptions,
      });

      let source = TileChunkSource.get(this.chunkManager, spec, {
        'baseUrls': this.baseUrls,
        'owner': this.ownerInfo.owner,
        'project': this.stackInfo.project,
        'stack': this.stack,
        'encoding': this.encoding,
        'level': level,
        'dims': `${this.dims[0]}_${this.dims[1]}`,
      });

      sources.push([source]);
    }
    return sources;
  }

  /**
   * Meshes are not supported.
   */
  getMeshSource(): null {
    return null;
  }
};

export function getOwnerInfo(
    chunkManager: ChunkManager, hostnames: string[], owner: string): Promise<OwnerInfo> {
  return chunkManager.memoize.getUncounted(
      {'hostnames': hostnames, 'owner': owner},
      () => sendHttpRequest(
                openShardedHttpRequest(hostnames, `/render-ws/v1/owner/${owner}/stacks`), 'json')
                .then(parseOwnerInfo));
}

const pathPattern = /^([^\/?]+)(?:\/([^\/?]+))?(?:\/([^\/?]+))?(?:\?(.*))?$/;

export function getShardedVolume(chunkManager: ChunkManager, hostnames: string[], path: string) {
  const match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid volume path ${JSON.stringify(path)}`);
  }
  const owner = match[1];
  const stack = match[3];

  const parameters = parseQueryStringParameters(match[4] || '');

  return chunkManager.memoize.getUncounted(
      {'hostnames': hostnames, 'path': path},
      () => getOwnerInfo(chunkManager, hostnames, owner)
                .then(
                    ownerInfo => new MultiscaleVolumeChunkSource(
                        chunkManager, hostnames, ownerInfo, stack, parameters)));
}

const urlPattern = /^((?:http|https):\/\/[^\/?]+)\/(.*)$/;

export function getVolume(chunkManager: ChunkManager, path: string) {
  let match = path.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid render volume path: ${JSON.stringify(path)}`);
  }
  return getShardedVolume(chunkManager, [match[1]], match[2]);
}

export function stackAndProjectCompleter(
    chunkManager: ChunkManager, hostnames: string[],
    path: string): CancellablePromise<CompletionResult> {
  const stackMatch = path.match(/^(?:([^\/]+)(?:\/([^\/]+))\/?(?:\/([^\/]*)))?$/);
  if (stackMatch === null) {
    // URL has incorrect format, don't return any results.
    return Promise.reject<CompletionResult>(null);
  }
  if (stackMatch[2] === undefined) {
    // let projectPrefix = stackMatch[2] || '';
    // TODO, complete the project? for now reject
    return Promise.reject<CompletionResult>(null);
  }
  return cancellableThen(getOwnerInfo(chunkManager, hostnames, stackMatch[1]), ownerInfo => {
    let completions =
        getPrefixMatchesWithDescriptions(stackMatch[3], ownerInfo.stacks, x => x[0], x => {
          return `${x[1].project}`;
        });
    return {offset: stackMatch[1].length + stackMatch[2].length + 2, completions};
  });
}

export function volumeCompleter(
    url: string, chunkManager: ChunkManager): CancellablePromise<CompletionResult> {
  let match = url.match(urlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let hostnames = [match[1]];
  let path = match[2];

  return cancellableThen(
      stackAndProjectCompleter(chunkManager, hostnames, path),
      completions => applyCompletionOffset(match![1].length + 1, completions));
}

registerDataSourceFactory('render', {
  description: 'Render',
  volumeCompleter: volumeCompleter,
  getVolume: getVolume,
});
