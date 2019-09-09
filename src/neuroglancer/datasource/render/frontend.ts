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

import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CompletionResult, DataSource} from 'neuroglancer/datasource';
import {PointMatchChunkSourceParameters, TileChunkSourceParameters} from 'neuroglancer/datasource/render/base';
import {VectorGraphicsChunkSpecification, VectorGraphicsSourceOptions} from 'neuroglancer/sliceview/vector_graphics/base';
import {MultiscaleVectorGraphicsChunkSource as GenericMultiscaleVectorGraphicsChunkSource, VectorGraphicsChunkSource} from 'neuroglancer/sliceview/vector_graphics/frontend';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {vec3} from 'neuroglancer/util/geom';
import {fetchOk} from 'neuroglancer/util/http_request';
import {parseArray, parseQueryStringParameters, verifyFloat, verifyObject, verifyObjectProperty, verifyOptionalBoolean, verifyOptionalInt, verifyOptionalString, verifyString} from 'neuroglancer/util/json';

const VALID_ENCODINGS = new Set<string>(['jpg', 'raw16']);

const TileChunkSourceBase = WithParameters(VolumeChunkSource, TileChunkSourceParameters);
class TileChunkSource extends TileChunkSourceBase {}
const PointMatchSourceBase =
    WithParameters(VectorGraphicsChunkSource, PointMatchChunkSourceParameters);
class PointMatchSource extends PointMatchSourceBase {}

const VALID_STACK_STATES = new Set<string>(['COMPLETE', 'READ_ONLY']);
const PARTIAL_STACK_STATES = new Set<string>(['LOADING']);

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
  channels: string[];
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

  let channels: string[] = [];
  let lowerVoxelBound: vec3 = vec3.create();
  let upperVoxelBound: vec3 = vec3.create();

  if (VALID_STACK_STATES.has(state)) {
    let stackStatsObj = verifyObjectProperty(obj, 'stats', verifyObject);

    lowerVoxelBound = parseLowerVoxelBounds(stackStatsObj);
    upperVoxelBound = parseUpperVoxelBounds(stackStatsObj);

    if (stackStatsObj.hasOwnProperty('channelNames')) {
      channels = parseChannelNames(stackStatsObj);
    }
  } else if (PARTIAL_STACK_STATES.has(state)) {
    // Stacks in LOADING state will not have a 'stats' object.
    // Values will be populated from command arguments in MultiscaleVolumeChunkSource()
  } else {
    return undefined;
  }

  let voxelResolution: vec3 = verifyObjectProperty(obj, 'currentVersion', parseStackVersionInfo);

  let project: string = verifyObjectProperty(obj, 'stackId', parseStackProject);

  return {lowerVoxelBound, upperVoxelBound, voxelResolution, project, channels};
}

function parseUpperVoxelBounds(stackStatsObj: any): vec3 {
  verifyObject(stackStatsObj);
  let stackBounds = verifyObjectProperty(stackStatsObj, 'stackBounds', verifyObject);

  let upperVoxelBound: vec3 = vec3.create();

  upperVoxelBound[0] = verifyObjectProperty(stackBounds, 'maxX', verifyFloat)+1;
  upperVoxelBound[1] = verifyObjectProperty(stackBounds, 'maxY', verifyFloat)+1;
  upperVoxelBound[2] = verifyObjectProperty(stackBounds, 'maxZ', verifyFloat)+1;

  return upperVoxelBound;
}

function parseLowerVoxelBounds(stackStatsObj: any): vec3 {
  verifyObject(stackStatsObj);
  let stackBounds = verifyObjectProperty(stackStatsObj, 'stackBounds', verifyObject);

  let lowerVoxelBound: vec3 = vec3.create();

  lowerVoxelBound[0] = verifyObjectProperty(stackBounds, 'minX', verifyFloat);
  lowerVoxelBound[1] = verifyObjectProperty(stackBounds, 'minY', verifyFloat);
  lowerVoxelBound[2] = verifyObjectProperty(stackBounds, 'minZ', verifyFloat);

  return lowerVoxelBound;
}

function parseChannelNames(stackStatsObj: any): string[] {
  verifyObject(stackStatsObj);

  return verifyObjectProperty(stackStatsObj, 'channelNames', channelNamesObj => {
    return parseArray(channelNamesObj, verifyString);
  });
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
    if (this.parameters.encoding === 'raw16') {
      return DataType.UINT16;
    } else {
      // JPEG
      return DataType.UINT8;
    }
  }
  get numChannels() {
    if (this.parameters.encoding === 'raw16') {
      return 1;
    } else {
      // JPEG
      return 3;
    }
  }
  get volumeType() {
    return VolumeType.IMAGE;
  }

  channel: string|undefined;
  stack: string;
  stackInfo: StackInfo;

  dims: vec3;

  encoding: string;
  numLevels: number|undefined;

  // Render Parameters
  minIntensity: number|undefined;
  maxIntensity: number|undefined;

  // Bounding box override parameters
  minX: number|undefined;
  minY: number|undefined;
  minZ: number|undefined;
  maxX: number|undefined;
  maxY: number|undefined;
  maxZ: number|undefined;

  // Force limited number of tile specs to render for downsampled views of large projects
  maxTileSpecsToRender: number|undefined;

  filter: boolean|undefined;

  constructor(
      public chunkManager: ChunkManager, public baseUrl: string, public ownerInfo: OwnerInfo,
      stack: string|undefined, public project: string, channel: string|undefined,
      public parameters: {[index: string]: any}) {
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

    if (channel !== undefined && channel.length > 0) {
      this.channel = channel;
    }

    this.minIntensity = verifyOptionalInt(parameters['minIntensity']);
    this.maxIntensity = verifyOptionalInt(parameters['maxIntensity']);
    this.maxTileSpecsToRender = verifyOptionalInt(parameters['maxTileSpecsToRender']);
    this.filter = verifyOptionalBoolean(parameters['filter']);

    this.minX = verifyOptionalInt(parameters['minX']);
    this.minY = verifyOptionalInt(parameters['minY']);
    this.minZ = verifyOptionalInt(parameters['minZ']);
    this.maxX = verifyOptionalInt(parameters['maxX']);
    this.maxY = verifyOptionalInt(parameters['maxY']);
    this.maxZ = verifyOptionalInt(parameters['maxZ']);

    if (this.minX !== undefined) { stackInfo.lowerVoxelBound[0] = this.minX; }
    if (this.minY !== undefined) { stackInfo.lowerVoxelBound[1] = this.minY; }
    if (this.minZ !== undefined) { stackInfo.lowerVoxelBound[2] = this.minZ; }
    if (this.maxX !== undefined) { stackInfo.upperVoxelBound[0] = this.maxX; }
    if (this.maxY !== undefined) { stackInfo.upperVoxelBound[1] = this.maxY; }
    if (this.maxZ !== undefined) { stackInfo.upperVoxelBound[2] = this.maxZ; }

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

    let lowerClipBound = vec3.create(), upperClipBound = vec3.create();
    // Generate and set the clip bounds based on the highest resolution (lowest scale) data in
    // render. Otherwise, rounding errors can cause inconsistencies in clip bounds between scaling
    // levels.
    for (let i = 0; i < 3; i++) {
      lowerClipBound[i] = this.stackInfo.lowerVoxelBound[i] * this.stackInfo.voxelResolution[i];
      upperClipBound[i] = this.stackInfo.upperVoxelBound[i] * this.stackInfo.voxelResolution[i];
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
        lowerClipBound,
        upperClipBound,
        lowerVoxelBound,
        upperVoxelBound,
        volumeSourceOptions,
      });

      let source = this.chunkManager.getChunkSource(TileChunkSource, {
        spec,
        parameters: {
          'baseUrl': this.baseUrl,
          'owner': this.ownerInfo.owner,
          'project': this.stackInfo.project,
          'stack': this.stack,
          'channel': this.channel,
          'minIntensity': this.minIntensity,
          'maxIntensity': this.maxIntensity,
          'maxTileSpecsToRender': this.maxTileSpecsToRender,
          'filter': this.filter,
          'dims': `${this.dims[0]}_${this.dims[1]}`,
          'level': level,
          'encoding': this.encoding,
        }
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

  if (tileSize >= maxBound) {
    return 1;
  }

  let counter = 0;
  while (maxBound > tileSize) {
    maxBound = maxBound / 2;
    counter++;
  }

  return counter;
}

export function getOwnerInfo(
    chunkManager: ChunkManager, hostname: string, owner: string): Promise<OwnerInfo> {
  return chunkManager.memoize.getUncounted(
      {'type': 'render:getOwnerInfo', hostname, owner},
      () => fetchOk(`${hostname}/render-ws/v1/owner/${owner}/stacks`)
                .then(response => response.json())
                .then(parseOwnerInfo));
}

const pathPattern = /^([^\/?]+)(?:\/([^\/?]+))?(?:\/([^\/?]+))(?:\/([^\/?]*))?(?:\?(.*))?$/;
const urlPattern = /^((?:(?:(?:http|https):\/\/[^,\/]+)[^\/?]))\/(.*)$/;

export function getVolume(chunkManager: ChunkManager, datasourcePath: string) {
  let hostname: string, path: string;
  {
    let match = datasourcePath.match(urlPattern);
    if (match === null) {
      throw new Error(`Invalid render volume path: ${JSON.stringify(datasourcePath)}`);
    }
    hostname = match[1];
    path = match[2];
  }
  const match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid volume path ${JSON.stringify(path)}`);
  }
  const owner = match[1];
  const project = match[2];
  const stack = match[3];
  const channel = match[4];

  const parameters = parseQueryStringParameters(match[5] || '');

  return chunkManager.memoize.getUncounted(
      {type: 'render:MultiscaleVolumeChunkSource', hostname, path},
      () => getOwnerInfo(chunkManager, hostname, owner)
                .then(
                    ownerInfo => new MultiscaleVolumeChunkSource(
                        chunkManager, hostname, ownerInfo, stack, project, channel, parameters)));
}

export function stackAndProjectCompleter(
    chunkManager: ChunkManager, hostname: string, path: string): Promise<CompletionResult> {
  const stackMatch = path.match(/^(?:([^\/]+)(?:\/([^\/]*))?(?:\/([^\/]*))?(\/.*?)?)?$/);
  if (stackMatch === null) {
    // URL has incorrect format, don't return any results.
    return Promise.reject<CompletionResult>(null);
  }
  if (stackMatch[2] === undefined) {
    // Don't autocomplete the owner
    return Promise.reject<CompletionResult>(null);
  }
  if (stackMatch[3] === undefined) {
    let projectPrefix = stackMatch[2] || '';
    return getOwnerInfo(chunkManager, hostname, stackMatch[1]).then(ownerInfo => {
      let completions = getPrefixMatchesWithDescriptions(
          projectPrefix, ownerInfo.projects, x => x[0] + '/', () => undefined);
      return {offset: stackMatch[1].length + 1, completions};
    });
  }
  if (stackMatch[4] === undefined) {
    let stackPrefix = stackMatch[3] || '';
    return getOwnerInfo(chunkManager, hostname, stackMatch[1]).then(ownerInfo => {
      let projectInfo = ownerInfo.projects.get(stackMatch[2]);
      if (projectInfo === undefined) {
        return Promise.reject<CompletionResult>(null);
      }
      let completions =
          getPrefixMatchesWithDescriptions(stackPrefix, projectInfo.stacks, x => x[0] + '/', x => {
            return `(${x[1].project})`;
          });
      return {offset: stackMatch[1].length + stackMatch[2].length + 2, completions};
    });
  }
  let channelPrefix = stackMatch[4].substr(1) || '';
  return getOwnerInfo(chunkManager, hostname, stackMatch[1]).then(ownerInfo => {
    let projectInfo = ownerInfo.projects.get(stackMatch[2]);
    if (projectInfo === undefined) {
      return Promise.reject<CompletionResult>(null);
    }
    let stackInfo = projectInfo.stacks.get(stackMatch[3]);
    if (stackInfo === undefined) {
      return Promise.reject<CompletionResult>(null);
    }
    let channels = stackInfo.channels;
    if (channels.length === 0) {
      return Promise.reject<CompletionResult>(null);
    } else {
      // Try and complete the channel
      let completions =
          getPrefixMatchesWithDescriptions(channelPrefix, channels, x => x, () => undefined);
      return {
        offset: stackMatch[1].length + stackMatch[2].length + stackMatch[3].length + 3,
        completions
      };
    }
  });
}

export function volumeCompleter(
    url: string, chunkManager: ChunkManager): Promise<CompletionResult> {
  let match = url.match(urlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let hostname = match[1];
  let path = match[2];

  return stackAndProjectCompleter(chunkManager, hostname, path)
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
      public chunkManager: ChunkManager, public baseUrl: string, public ownerInfo: OwnerInfo,
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
    const voxelSize = this.stackInfo.voxelResolution;
    const chunkSize = vec3.subtract(
        vec3.create(), this.stackInfo.upperVoxelBound, this.stackInfo.lowerVoxelBound);
    vec3.multiply(chunkSize, chunkSize, voxelSize);
    chunkSize[2] = voxelSize[2];

    const spec = VectorGraphicsChunkSpecification.make({
      voxelSize,
      chunkSize,
      lowerChunkBound: vec3.fromValues(0, 0, this.stackInfo.lowerVoxelBound[2]),
      upperChunkBound: vec3.fromValues(1, 1, this.stackInfo.upperVoxelBound[2]),
      vectorGraphicsSourceOptions
    });
    const source = this.chunkManager.getChunkSource(PointMatchSource, {
      spec,
      parameters: {
        'baseUrl': this.baseUrl,
        'owner': this.ownerInfo.owner,
        'project': this.stackInfo.project,
        'stack': this.stack,
        'encoding': 'points',
        'matchCollection': this.matchCollection,
        'zoffset': this.zoffset
      }
    });

    return [[source]];
  }
}

export function getPointMatches(chunkManager: ChunkManager, datasourcePath: string) {
  let hostname: string, path: string;
  {
    let match = datasourcePath.match(urlPattern);
    if (match === null) {
      throw new Error(`Invalid render point path: ${JSON.stringify(datasourcePath)}`);
    }
    hostname = match[1];
    path = match[2];
  }
  const match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid point path ${JSON.stringify(path)}`);
  }
  
  const owner = match[1];
  const project = match[2];
  const stack = match[3];

  const parameters = parseQueryStringParameters(match[4] || '');

  return chunkManager.memoize.getUncounted(
      {type: 'render:MultiscaleVectorGraphicsChunkSource', hostname, path},
      () => getOwnerInfo(chunkManager, hostname, owner)
                .then(
                    ownerInfo => new MultiscaleVectorGraphicsChunkSource(
                        chunkManager, hostname, ownerInfo, stack, project, parameters)));
}

export class RenderDataSource extends DataSource {
  get description() {
    return 'Render';
  }
  getVolume(chunkManager: ChunkManager, url: string) {
    return getVolume(chunkManager, url);
  }
  volumeCompleter(url: string, chunkManager: ChunkManager) {
    return volumeCompleter(url, chunkManager);
  }
  getVectorGraphicsSource(chunkManager: ChunkManager, url: string) {
    return getPointMatches(chunkManager, url);
  }
}
