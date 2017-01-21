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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {DVIDSourceParameters, TileChunkSourceParameters, TileEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/dvid/base';
import {CompletionResult, registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/base';
import {defineParameterizedVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseIntVec, verifyFinitePositiveFloat, verifyInt, verifyMapKey, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';

let serverDataTypes = new Map<string, DataType>();
serverDataTypes.set('uint8', DataType.UINT8);
serverDataTypes.set('uint32', DataType.UINT32);
serverDataTypes.set('uint64', DataType.UINT64);

export class DataInstanceBaseInfo {
  get typeName(): string { return this.obj['TypeName']; }

  constructor(public obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, 'TypeName', verifyString);
  }
}

export class DataInstanceInfo {
  constructor(public obj: any, public name: string, public base: DataInstanceBaseInfo) {}
}

const DVIDVolumeChunkSource = defineParameterizedVolumeChunkSource(VolumeChunkSourceParameters);

export class VolumeDataInstanceInfo extends DataInstanceInfo {
  dataType: DataType;
  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;
  voxelSize: vec3;
  numChannels: number;
  numLevels: number;
  constructor(
      obj: any, name: string, base: DataInstanceBaseInfo, public volumeType: VolumeType,
      instanceNames: Array<string>) {
    super(obj, name, base);
    let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
    let extendedValues = verifyObjectProperty(extended, 'Values', x => parseArray(x, verifyObject));
    if (extendedValues.length < 1) {
      throw new Error(
          'Expected Extended.Values property to have length >= 1, but received: ${JSON.stringify(extendedValues)}.');
    }
    this.numLevels = 1;

    // dvid does not have explicit datatype support for multiscale but
    // by convention different levels are specified with unique
    // instances where levels are distinguished by the suffix '_LEVELNUM'
    let instSet = new Set<string>(instanceNames);
    while (instSet.has(name + '_' + this.numLevels.toString())) {
      this.numLevels += 1;
    }

    this.dataType =
        verifyObjectProperty(extendedValues[0], 'DataType', x => verifyMapKey(x, serverDataTypes));
    this.lowerVoxelBound =
        verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));
    this.upperVoxelBound =
        verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x));
    this.voxelSize = verifyObjectProperty(
        extended, 'VoxelSize',
        x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.numChannels = 1;
  }

  getSources(
      chunkManager: ChunkManager, parameters: DVIDSourceParameters,
      volumeSourceOptions: VolumeSourceOptions) {
    let sources: VolumeChunkSource[][] = [];
    for (let level = 0; level < this.numLevels; ++level) {
      let voxelSize = vec3.scale(vec3.create(), this.voxelSize, Math.pow(2, level));
      let lowerVoxelBound = vec3.create();
      let upperVoxelBound = vec3.create();
      for (let i = 0; i < 3; ++i) {
        lowerVoxelBound[i] =
            Math.floor(this.lowerVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
        upperVoxelBound[i] =
            Math.ceil(this.upperVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
      }
      let dataInstanceKey = parameters.dataInstanceKey;
      if (level > 0) {
        dataInstanceKey += '_' + level.toString();
      }

      let volParameters: VolumeChunkSourceParameters = {
        'baseUrls': parameters.baseUrls,
        'nodeKey': parameters.nodeKey,
        'dataInstanceKey': dataInstanceKey,
      };
      let alternatives =
          VolumeChunkSpecification
              .getDefaults({
                voxelSize: voxelSize,
                dataType: this.dataType,
                numChannels: this.numChannels,
                transform: mat4.fromTranslation(
                    mat4.create(), vec3.multiply(vec3.create(), lowerVoxelBound, voxelSize)),
                baseVoxelOffset: lowerVoxelBound,
                upperVoxelBound: vec3.subtract(vec3.create(), upperVoxelBound, lowerVoxelBound),
                volumeType: this.volumeType, volumeSourceOptions,
              })
              .map(
                  spec => { return DVIDVolumeChunkSource.get(chunkManager, spec, volParameters); });
      sources.push(alternatives);
    }
    return sources;
  }
}

export class TileLevelInfo {
  /**
   * Resolution of the two downsampled dimensions in the tile plane.  The tile depth is equal to the
   * base voxel size in that dimension.
   */
  resolution: vec3;
  tileSize: vec3;

  constructor(obj: any) {
    verifyObject(obj);
    this.resolution = verifyObjectProperty(
        obj, 'Resolution', x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
    this.tileSize = verifyObjectProperty(
        obj, 'TileSize', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
  }
}

/**
 * Dimensions for which tiles are computed.
 *
 * DVID does not indicate which dimensions are available but it
 * provides blank tiles if the dimension asked for is not there.
 */
const TILE_DIMS = [
  [0, 1],
  [0, 2],
  [1, 2],
];

const TileChunkSource = defineParameterizedVolumeChunkSource(TileChunkSourceParameters);

export class TileDataInstanceInfo extends DataInstanceInfo {
  get dataType() { return DataType.UINT8; }
  get volumeType() { return VolumeType.IMAGE; }
  get numChannels() { return 1; }

  encoding: TileEncoding;

  /**
   * Base voxel size (nm).
   */
  voxelSize: vec3;

  levels: Map<string, TileLevelInfo>;

  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;

  constructor(obj: any, name: string, base: DataInstanceBaseInfo) {
    super(obj, name, base);
    let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
    this.levels = verifyObjectProperty(
        extended, 'Levels', x => verifyObjectAsMap(x, y => new TileLevelInfo(y)));
    let baseLevel = this.levels.get('0');
    if (baseLevel === undefined) {
      throw new Error(`Level 0 is not defined.`);
    }
    this.voxelSize = baseLevel.resolution;
    let minTileCoord = verifyObjectProperty(
        extended, 'MinTileCoord', x => parseFixedLengthArray(vec3.create(), x, verifyInt));
    let maxTileCoord = verifyObjectProperty(
        extended, 'MaxTileCoord', x => parseFixedLengthArray(vec3.create(), x, verifyInt));
    this.lowerVoxelBound = vec3.multiply(vec3.create(), baseLevel.tileSize, minTileCoord);
    this.upperVoxelBound = vec3.multiply(vec3.create(), baseLevel.tileSize, maxTileCoord);

    let encodingNumber = verifyObjectProperty(extended, 'Encoding', x => x);
    switch (encodingNumber) {
      case 2:
        this.encoding = TileEncoding.JPEG;
        break;
      default:
        throw new Error(`Unsupported tile encoding: ${JSON.stringify(encodingNumber)}.`);
    }
  }

  getSources(
      chunkManager: ChunkManager, parameters: DVIDSourceParameters,
      volumeSourceOptions: VolumeSourceOptions) {
    let sources: VolumeChunkSource[][] = [];
    let {numChannels, dataType, encoding} = this;
    for (let [level, levelInfo] of this.levels) {
      let alternatives = TILE_DIMS.map(dims => {
        let voxelSize = vec3.clone(this.voxelSize);
        let chunkDataSize = vec3.fromValues(1, 1, 1);
        // tiles are always NxMx1
        for (let i = 0; i < 2; ++i) {
          voxelSize[dims[i]] = levelInfo.resolution[dims[i]];
          chunkDataSize[dims[i]] = levelInfo.tileSize[dims[i]];
        }
        let lowerVoxelBound = vec3.create(), upperVoxelBound = vec3.create();
        for (let i = 0; i < 3; ++i) {
          lowerVoxelBound[i] =
              Math.floor(this.lowerVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
          upperVoxelBound[i] =
              Math.ceil(this.upperVoxelBound[i] * (this.voxelSize[i] / voxelSize[i]));
        }
        let spec = VolumeChunkSpecification.make({
          voxelSize,
          chunkDataSize,
          numChannels: numChannels,
          dataType: dataType, lowerVoxelBound, upperVoxelBound, volumeSourceOptions,
        });
        return TileChunkSource.get(chunkManager, spec, {
          'baseUrls': parameters.baseUrls,
          'nodeKey': parameters.nodeKey,
          'dataInstanceKey': parameters.dataInstanceKey,
          'encoding': encoding,
          'level': level,
          'dims': `${dims[0]}_${dims[1]}`,
        });
      });
      sources.push(alternatives);
    }
    return sources;
  }
}

export function parseDataInstance(
    obj: any, name: string, instanceNames: Array<string>): DataInstanceInfo {
  verifyObject(obj);
  let baseInfo = verifyObjectProperty(obj, 'Base', x => new DataInstanceBaseInfo(x));
  switch (baseInfo.typeName) {
    case 'uint8blk':
    case 'grayscale8':
      return new VolumeDataInstanceInfo(obj, name, baseInfo, VolumeType.IMAGE, instanceNames);
    case 'imagetile':
      return new TileDataInstanceInfo(obj, name, baseInfo);
    case 'labels64':
    case 'labelblk':
      return new VolumeDataInstanceInfo(
          obj, name, baseInfo, VolumeType.SEGMENTATION, instanceNames);
    default:
      throw new Error(`DVID data type ${JSON.stringify(baseInfo.typeName)} is not supported.`);
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
    this.alias = verifyObjectProperty(obj, 'Alias', verifyString);
    this.description = verifyObjectProperty(obj, 'Description', verifyString);
    let dataInstanceObjs = verifyObjectProperty(obj, 'DataInstances', verifyObject);
    let instanceKeys = Object.keys(dataInstanceObjs);
    for (let key of instanceKeys) {
      try {
        this.dataInstances.set(key, parseDataInstance(dataInstanceObjs[key], key, instanceKeys));
      } catch (parseError) {
        let message = `Failed to parse data instance ${JSON.stringify(key)}: ${parseError.message}`;
        console.log(message);
        this.errors.push(message);
      }
    }

    let dagObj = verifyObjectProperty(obj, 'DAG', verifyObject);
    let nodeObjs = verifyObjectProperty(dagObj, 'Nodes', verifyObject);
    for (let key of Object.keys(nodeObjs)) {
      this.vnodes.add(key);
    }
  }
}

export function parseRepositoriesInfo(obj: any) {
  try {
    let result = verifyObjectAsMap(obj, x => new RepositoryInfo(x));

    // make all versions available for viewing
    let allVersions = new Map<string, RepositoryInfo>();
    for (let [key, info] of result) {
      allVersions.set(key, info);
      for (let key2 of info.vnodes) {
        if (key2 !== key) {
          // create new repo
          let rep = new RepositoryInfo(info);
          allVersions.set(key2, rep);
        }
      }
    }

    for (let [key, info] of allVersions) {
      info.uuid = key;
    }
    return allVersions;
  } catch (parseError) {
    throw new Error(`Failed to parse DVID repositories info: ${parseError.message}`);
  }
}

export class ServerInfo {
  repositories: Map<string, RepositoryInfo>;
  constructor(obj: any) { this.repositories = parseRepositoriesInfo(obj); }

  getNode(nodeKey: string): RepositoryInfo {
    // FIXME: Support non-root nodes.
    let matches: string[] = [];
    for (let key of this.repositories.keys()) {
      if (key.startsWith(nodeKey)) {
        matches.push(key);
      }
    }
    if (matches.length !== 1) {
      throw new Error(
          `Node key ${JSON.stringify(nodeKey)} matches ${JSON.stringify(matches)} nodes.`);
    }
    return this.repositories.get(matches[0])!;
  }
}

export function getServerInfo(chunkManager: ChunkManager, baseUrls: string[]) {
  return chunkManager.memoize.getUncounted(baseUrls, () => {
    let result = sendHttpRequest(openShardedHttpRequest(baseUrls, '/api/repos/info', 'GET'), 'json')
                     .then(response => new ServerInfo(response));
    const description = `repository info for DVID server ${baseUrls[0]}`;
    StatusMessage.forPromise(result, {
      initialMessage: `Retrieving ${description}.`,
      delay: true,
      errorPrefix: `Error retrieving ${description}: `,
    });
    return result;
  });
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  get dataType() { return this.info.dataType; }
  get numChannels() { return this.info.numChannels; }
  get volumeType() { return this.info.volumeType; }

  constructor(
      public chunkManager: ChunkManager, public baseUrls: string[], public nodeKey: string,
      public dataInstanceKey: string, public info: VolumeDataInstanceInfo|TileDataInstanceInfo) {}

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.info.getSources(
        this.chunkManager, {
          'baseUrls': this.baseUrls,
          'nodeKey': this.nodeKey,
          'dataInstanceKey': this.dataInstanceKey,
        },
        volumeSourceOptions);
  }

  /**
   * Meshes are not supported.
   */
  getMeshSource(): null { return null; }
}

export function getShardedVolume(
    chunkManager: ChunkManager, baseUrls: string[], nodeKey: string, dataInstanceKey: string) {
  return getServerInfo(chunkManager, baseUrls).then(serverInfo => {
    let repositoryInfo = serverInfo.getNode(nodeKey);
    if (repositoryInfo === undefined) {
      throw new Error(`Invalid node: ${JSON.stringify(nodeKey)}.`);
    }
    const dataInstanceInfo = repositoryInfo.dataInstances.get(dataInstanceKey);
    if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo) &&
        !(dataInstanceInfo instanceof TileDataInstanceInfo)) {
      throw new Error(`Invalid data instance ${dataInstanceKey}.`);
    }
    return chunkManager.memoize.getUncounted(
        {'baseUrls': baseUrls, 'nodeKey': repositoryInfo.uuid, 'dataInstanceKey': dataInstanceKey},
        () => new MultiscaleVolumeChunkSource(
            chunkManager, baseUrls, repositoryInfo.uuid, dataInstanceKey, dataInstanceInfo));
  });
}

const urlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+)$/;

export function getVolume(chunkManager: ChunkManager, url: string) {
  let match = url.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(url)}.`);
  }
  return getShardedVolume(chunkManager, [match[1]], match[2], match[3]);
}

export function completeInstanceName(
    repositoryInfo: RepositoryInfo, prefix: string): CompletionResult {
  return {
    offset: 0,
    completions: getPrefixMatchesWithDescriptions<DataInstanceInfo>(
        prefix, repositoryInfo.dataInstances.values(), instance => instance.name,
        instance => { return `${instance.base.typeName}`; })
  };
}

export function completeNodeAndInstance(serverInfo: ServerInfo, prefix: string): CompletionResult {
  let match = prefix.match(/^(?:([^\/]+)(?:\/([^\/]*))?)?$/);
  if (match === null) {
    throw new Error(`Invalid DVID URL syntax.`);
  }
  if (match[2] === undefined) {
    // Try to complete the node name.
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions<RepositoryInfo>(
          prefix, serverInfo.repositories.values(), repository => repository.uuid + '/',
          repository => `${repository.alias}: ${repository.description}`)
    };
  }
  let nodeKey = match[1];
  let repository = serverInfo.getNode(nodeKey);
  return applyCompletionOffset(nodeKey.length + 1, completeInstanceName(repository, match[2]));
}

export function volumeCompleter(
    url: string, chunkManager: ChunkManager): Promise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^\/]+)\/(.*)$/;
  let match = url.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    return Promise.reject<CompletionResult>(null);
  }
  let baseUrl = match[1];
  let baseUrls = [baseUrl];
  let path = match[2];
  return getServerInfo(chunkManager, baseUrls)
      .then(
          serverInfo =>
              applyCompletionOffset(baseUrl.length + 1, completeNodeAndInstance(serverInfo, path)));
}

registerDataSourceFactory('dvid', {
  description: 'DVID',
  volumeCompleter: volumeCompleter,
  getVolume: getVolume,
});
