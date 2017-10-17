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

import {ChunkManager} from '../../chunk_manager/frontend';
import {CompletionResult, registerDataSourceFactory} from '../factory';
import {PointMatchChunkSourceParameters, TileChunkSourceParameters} from './base';
import {VectorGraphicsChunkSpecification, VectorGraphicsSourceOptions} from '../../sliceview/vector_graphics/base';
import {defineParameterizedVectorGraphicsSource, MultiscaleVectorGraphicsChunkSource as GenericMultiscaleVectorGraphicsChunkSource} from '../../sliceview/vector_graphics/frontend';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from '../../sliceview/volume/base';
import {defineParameterizedVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from '../../sliceview/volume/frontend';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from '../../util/completion';
import {vec3} from '../../util/geom';
import {openShardedHttpRequest, sendHttpRequest} from '../../util/http_request';
import {parseArray, parseQueryStringParameters, verifyFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalInt, verifyOptionalString, verifyString} from '../../util/json';

const VALID_ENCODINGS = new Set<string>(['jpg']);

const TileChunkSource = defineParameterizedVolumeChunkSource(TileChunkSourceParameters);
const PointMatchSource = defineParameterizedVectorGraphicsSource(PointMatchChunkSourceParameters);

const VALID_STACK_STATES = new Set<string>(['COMPLETE']);

interface OwnerInfo {
  owner: string;
  projects: Map<string, ProjectInfo>;
}

interface ProjectInfo {
  stacks: Map<string, StackInfo>;
}

interface StackInfo {
  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;
  voxelResolution: vec3; /* in nm */
  project: string;
}

function parseOwnerInfo(obj: any): OwnerInfo {
  let stackObjs = parseArray(obj, verifyObject);

  if (stackObjs.length < 1) {
    throw new Error(`No stacks found for owner object.`);
  }

  let projects = new Map<string, ProjectInfo>();
  // Get the owner from the first stack
  let owner = verifyObjectProperty(stackObjs[0], 'stackId', parseStackOwner);

  for (let stackObj of stackObjs) {
    let stackName = verifyObjectProperty(stackObj, 'stackId', parseStackName);
    let stackInfo = parseStackInfo(stackObj);

    if (stackInfo !== undefined) {
      let projectName = stackInfo.project;
      let projectInfo = projects.get(projectName);

      if (projectInfo === undefined) {
        let stacks = new Map<string, StackInfo>();
        projects.set(projectName, {stacks});
        projectInfo = projects.get(projectName);
      }

      projectInfo!.stacks.set(stackName, stackInfo);
    }
  }

  return {owner, projects};
}

function parseStackName(stackIdObj: any): string {
  verifyObject(stackIdObj);
  return verifyObjectProperty(stackIdObj, 'stack', verifyString);
}

function parseStackOwner(stackIdObj: any): string {
  verifyObject(stackIdObj);
  return verifyObjectProperty(stackIdObj, 'owner', verifyString);
}

function parseStackInfo(obj: any): StackInfo|undefined {
  verifyObject(obj);

  let state = verifyObjectProperty(obj, 'state', verifyString);
  if (!VALID_STACK_STATES.has(state)) {
    return undefined;
  }

  let lowerVoxelBound: vec3 = verifyObjectProperty(obj, 'stats', parseLowerVoxelBounds);
  let upperVoxelBound: vec3 = verifyObjectProperty(obj, 'stats', parseUpperVoxelBounds);

  let voxelResolution: vec3 = verifyObjectProperty(obj, 'currentVersion', parseStackVersionInfo);

  let project: string = verifyObjectProperty(obj, 'stackId', parseStackProject);

  return {lowerVoxelBound, upperVoxelBound, voxelResolution, project};
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
  numLevels: number|undefined;

  constructor(
      public chunkManager: ChunkManager, public baseUrls: string[], public ownerInfo: OwnerInfo,
      stack: string|undefined, public project: string, public parameters: {[index: string]: any}) {
    let projectInfo = ownerInfo.projects.get(project);
    if (projectInfo === undefined) {
      throw new Error(
          `Specified project ${JSON.stringify(project)} does not exist for ` +
          `specified owner ${JSON.stringify(ownerInfo.owner)}`);
    }

    if (stack === undefined) {
      const stackNames = Array.from(projectInfo.stacks.keys());
      if (stackNames.length !== 1) {
        throw new Error(`Dataset contains multiple stacks: ${JSON.stringify(stackNames)}`);
      }
      stack = stackNames[0];
    }
    const stackInfo = projectInfo.stacks.get(stack);
    if (stackInfo === undefined) {
      throw new Error(
          `Specified stack ${JSON.stringify(stack)} is not one of the supported stacks: ` +
          JSON.stringify(Array.from(projectInfo.stacks.keys())));
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

    this.numLevels = verifyOptionalInt(parameters['numlevels']);

    this.dims = vec3.create();

    let tileSize = verifyOptionalInt(parameters['tilesize']);
    if (tileSize === undefined) {
      tileSize = 1024;  // Default tile size is 1024 x 1024
    }
    this.dims[0] = tileSize;
    this.dims[1] = tileSize;
    this.dims[2] = 1;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let sources: VolumeChunkSource[][] = [];

    let numLevels = this.numLevels;
    if (numLevels === undefined) {
      numLevels = computeStackHierarchy(this.stackInfo, this.dims[0]);
    }

    for (let level = 0; level < numLevels; level++) {
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
        dataType: this.dataType,
        lowerVoxelBound,
        upperVoxelBound,
        volumeSourceOptions,
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
}

export function computeStackHierarchy(stackInfo: StackInfo, tileSize: number) {
  let maxBound = 0;
  for (let i = 0; i < 2; i++) {
    maxBound < stackInfo.upperVoxelBound[i] ? maxBound = stackInfo.upperVoxelBound[i] :
                                              maxBound = maxBound;
  }

  let counter = 0;
  while (maxBound > tileSize) {
    maxBound = maxBound / 2;
    counter++;
  }

  return counter;
}

export function getOwnerInfo(
    chunkManager: ChunkManager, hostnames: string[], owner: string): Promise<OwnerInfo> {
  return chunkManager.memoize.getUncounted(
      {'type': 'render:getOwnerInfo', hostnames, owner},
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
  const project = match[2];
  const stack = match[3];

  const parameters = parseQueryStringParameters(match[4] || '');

  return chunkManager.memoize.getUncounted(
      {type: 'render:MultiscaleVolumeChunkSource', hostnames, path},
      () => getOwnerInfo(chunkManager, hostnames, owner)
                .then(
                    ownerInfo => new MultiscaleVolumeChunkSource(
                        chunkManager, hostnames, ownerInfo, stack, project, parameters)));
}

const urlPattern = /^((?:(?:(?:http|https):\/\/[^,\/]+)[^\/?])+)\/(.*)$/;

export function getVolume(chunkManager: ChunkManager, path: string) {
  let match = path.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid render volume path: ${JSON.stringify(path)}`);
  }
  let hostnames: string[] = match[1].split(',');
  return getShardedVolume(chunkManager, hostnames, match[2]);
}

export function stackAndProjectCompleter(
    chunkManager: ChunkManager, hostnames: string[], path: string): Promise<CompletionResult> {
  const stackMatch = path.match(/^(?:([^\/]+)(?:\/([^\/]*))?(?:\/([^\/]*))?)?$/);
  if (stackMatch === null) {
    // URL has incorrect format, don't return any results.
    return Promise.reject<CompletionResult>(null);
  }
  if (stackMatch[2] === undefined) {
    // Don't autocomplete the owner
    return Promise.reject<CompletionResult>(null);
  }
  if (stackMatch[3] === undefined) {
    // Try to complete the project
    return getOwnerInfo(chunkManager, hostnames, stackMatch[1]).then(ownerInfo => {
      let completions = getPrefixMatchesWithDescriptions(
          stackMatch[2], ownerInfo.projects, x => x[0] + '/', () => undefined);
      return {offset: stackMatch[1].length + 1, completions};
    });
  }
  return getOwnerInfo(chunkManager, hostnames, stackMatch[1]).then(ownerInfo => {
    let projectInfo = ownerInfo.projects.get(stackMatch[2]);
    if (projectInfo === undefined) {
      return Promise.reject<CompletionResult>(null);
    }
    let completions =
        getPrefixMatchesWithDescriptions(stackMatch[3], projectInfo.stacks, x => x[0], x => {
          return `${x[1].project}`;
        });
    return {offset: stackMatch[1].length + stackMatch[2].length + 2, completions};
  });
}

export function volumeCompleter(
    url: string, chunkManager: ChunkManager): Promise<CompletionResult> {
  let match = url.match(urlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let hostnames: string[] = match[1].split(',');
  let path = match[2];

  return stackAndProjectCompleter(chunkManager, hostnames, path)
      .then(completions => applyCompletionOffset(match![1].length + 1, completions));
}

export class MultiscaleVectorGraphicsChunkSource implements
    GenericMultiscaleVectorGraphicsChunkSource {
  stack: string;
  stackInfo: StackInfo;

  matchCollection: string;
  zoffset: number;

  dims: vec3;

  constructor(
      public chunkManager: ChunkManager, public baseUrls: string[], public ownerInfo: OwnerInfo,
      stack: string|undefined, public project: string, public parameters: {[index: string]: any}) {
    let projectInfo = ownerInfo.projects.get(project);
    if (projectInfo === undefined) {
      throw new Error(
          `Specified project ${JSON.stringify(project)} does not exist for ` +
          `specified owner ${JSON.stringify(ownerInfo.owner)}`);
    }

    if (stack === undefined) {
      const stackNames = Array.from(projectInfo.stacks.keys());
      if (stackNames.length !== 1) {
        throw new Error(`Dataset contains multiple stacks: ${JSON.stringify(stackNames)}`);
      }
      stack = stackNames[0];
    }
    const stackInfo = projectInfo.stacks.get(stack);
    if (stackInfo === undefined) {
      throw new Error(
          `Specified stack ${JSON.stringify(stack)} is not one of the supported stacks: ` +
          JSON.stringify(Array.from(projectInfo.stacks.keys())));
    }
    this.stack = stack;
    this.stackInfo = stackInfo;

    let matchCollection = verifyOptionalString(parameters['matchCollection']);
    if (matchCollection === undefined) {
      matchCollection = stack;
    }
    this.matchCollection = matchCollection;

    let zoffset = verifyOptionalInt(parameters['zoffset']);
    if (zoffset === undefined) {
      zoffset = 1;
    }
    this.zoffset = zoffset;

    this.dims = vec3.create();

    let tileSize = verifyOptionalInt(parameters['tilesize']);
    if (tileSize === undefined) {
      tileSize = 1024;  // Default tile size is 1024 x 1024
    }
    this.dims[0] = tileSize;
    this.dims[1] = tileSize;
    this.dims[2] = 1;
  }
  getSources(vectorGraphicsSourceOptions: VectorGraphicsSourceOptions) {
    let voxelSize = vec3.clone(this.stackInfo.voxelResolution);

    let lowerVoxelBound = vec3.create(), upperVoxelBound = vec3.create();

    for (let i = 0; i < 3; i++) {
      lowerVoxelBound[i] = Math.floor(
          this.stackInfo.lowerVoxelBound[i] * (this.stackInfo.voxelResolution[i] / voxelSize[i]));
      upperVoxelBound[i] = Math.ceil(
          this.stackInfo.upperVoxelBound[i] * (this.stackInfo.voxelResolution[i] / voxelSize[i]));
    }

    // For now we set the chunkDataSize to be the size of an entire slab, pending possible bug fix
    // in render point match service
    let chunkDataSize = vec3.clone(upperVoxelBound);
    chunkDataSize[0] += Math.abs(lowerVoxelBound[0]);
    chunkDataSize[1] += Math.abs(lowerVoxelBound[1]);
    chunkDataSize[2] = 1;


    let spec = VectorGraphicsChunkSpecification.make(
        {voxelSize, lowerVoxelBound, upperVoxelBound, chunkDataSize, vectorGraphicsSourceOptions});
    let source = PointMatchSource.get(this.chunkManager, spec, {
      'baseUrls': this.baseUrls,
      'owner': this.ownerInfo.owner,
      'project': this.stackInfo.project,
      'stack': this.stack,
      'encoding': 'points',
      'matchCollection': this.matchCollection,
      'zoffset': this.zoffset
    });

    return [[source]];
  }
}

export function getPointMatches(chunkManager: ChunkManager, path: string) {
  let match = path.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid render point path: ${JSON.stringify(path)}`);
  }
  return getShardedPointMatches(chunkManager, [match[1]], match[2]);
}


export function getShardedPointMatches(
    chunkManager: ChunkManager, hostnames: string[], path: string) {
  const match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid point path ${JSON.stringify(path)}`);
  }

  const owner = match[1];
  const project = match[2];
  const stack = match[3];

  const parameters = parseQueryStringParameters(match[4] || '');

  return chunkManager.memoize.getUncounted(
      {type: 'render:MultiscaleVectorGraphicsChunkSource', hostnames, path},
      () => getOwnerInfo(chunkManager, hostnames, owner)
                .then(
                    ownerInfo => new MultiscaleVectorGraphicsChunkSource(
                        chunkManager, hostnames, ownerInfo, stack, project, parameters)));
}

registerDataSourceFactory('render', {
  description: 'Render',
  volumeCompleter: volumeCompleter,
  getVolume: getVolume,
  getVectorGraphicsSource: getPointMatches,
});
