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

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {BoundingBox, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {CompleteUrlOptions, CompletionResult, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {DVIDSourceParameters, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/dvid/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {fetchOk} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseIntVec, verifyFinitePositiveFloat, verifyMapKey, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';

let serverDataTypes = new Map<string, DataType>();
serverDataTypes.set('uint8', DataType.UINT8);
serverDataTypes.set('uint32', DataType.UINT32);
serverDataTypes.set('uint64', DataType.UINT64);

export class DataInstanceBaseInfo {
  get typeName(): string {
    return this.obj['TypeName'];
  }

  get compressionName(): string {
    return this.obj['Compression'];
  }

  constructor(public obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, 'TypeName', verifyString);
  }
}

export class DataInstanceInfo {
  constructor(public obj: any, public name: string, public base: DataInstanceBaseInfo) {}
}

class DVIDVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {}

class DVIDSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {}

class DVIDMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {}

export class VolumeDataInstanceInfo extends DataInstanceInfo {
  dataType: DataType;
  lowerVoxelBound: vec3;
  upperVoxelBoundInclusive: vec3;
  voxelSize: vec3;
  numLevels: number;
  meshSrc: string;
  skeletonSrc: string;

  constructor(
      obj: any, name: string, base: DataInstanceBaseInfo, public encoding: VolumeChunkEncoding,
      instanceNames: Array<string>) {
    super(obj, name, base);
    let extended = verifyObjectProperty(obj, 'Extended', verifyObject);
    let extendedValues = verifyObjectProperty(extended, 'Values', x => parseArray(x, verifyObject));
    if (extendedValues.length < 1) {
      throw new Error(
          'Expected Extended.Values property to have length >= 1, but received: ${JSON.stringify(extendedValues)}.');
    }
    this.numLevels = 1;

    let instSet = new Set<string>(instanceNames);
    if (encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
      // retrieve maximum downres level
      let maxdownreslevel = verifyObjectProperty(extended, 'MaxDownresLevel', verifyPositiveInt);
      this.numLevels = maxdownreslevel + 1;
    } else {
      // labelblk does not have explicit datatype support for multiscale but
      // by convention different levels are specified with unique
      // instances where levels are distinguished by the suffix '_LEVELNUM'
      while (instSet.has(name + '_' + this.numLevels.toString())) {
        this.numLevels += 1;
      }
    }

    if (instSet.has(name + '_meshes')) {
      this.meshSrc = name + '_meshes';
    } else {
      this.meshSrc = '';
    }

    if (instSet.has(name + '_skeletons')) {
      this.skeletonSrc = name + '_skeletons';
    } else {
      this.skeletonSrc = '';
    }


    this.dataType =
        verifyObjectProperty(extendedValues[0], 'DataType', x => verifyMapKey(x, serverDataTypes));
    this.voxelSize = verifyObjectProperty(
        extended, 'VoxelSize',
        x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
  }

  get volumeType() {
    return (
        (this.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
         this.encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) ?
            VolumeType.SEGMENTATION :
            VolumeType.IMAGE);
  }

  getSources(
      chunkManager: ChunkManager, parameters: DVIDSourceParameters,
      volumeSourceOptions: VolumeSourceOptions) {
    let {encoding} = this;
    let sources: SliceViewSingleResolutionSource<VolumeChunkSource>[][] = [];

    // must be 64 block size to work with neuroglancer properly
    let blocksize = 64;
    for (let level = 0; level < this.numLevels; ++level) {
      const downsampleFactor = Math.pow(2, level);
      const invDownsampleFactor = Math.pow(2, -level);
      let lowerVoxelBound = vec3.create();
      let upperVoxelBound = vec3.create();
      for (let i = 0; i < 3; ++i) {
        let lowerVoxelNotAligned = Math.floor(this.lowerVoxelBound[i] * invDownsampleFactor);
        // adjust min to be a multiple of blocksize
        lowerVoxelBound[i] = lowerVoxelNotAligned - (lowerVoxelNotAligned % blocksize);
        let upperVoxelNotAligned = Math.ceil((this.upperVoxelBoundInclusive[i] + 1) * invDownsampleFactor);
        upperVoxelBound[i] = upperVoxelNotAligned;
        // adjust max to be a multiple of blocksize
        if ((upperVoxelNotAligned % blocksize) !== 0) {
          upperVoxelBound[i] += (blocksize - (upperVoxelNotAligned % blocksize));
        }
      }
      let dataInstanceKey = parameters.dataInstanceKey;

      if (encoding !== VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) {
        if (level > 0) {
          dataInstanceKey += '_' + level.toString();
        }
      }

      let volParameters: VolumeChunkSourceParameters = {
        'baseUrl': parameters.baseUrl,
        'nodeKey': parameters.nodeKey,
        'dataInstanceKey': dataInstanceKey,
        'dataScale': level.toString(),
        'encoding': encoding,
      };
      const chunkToMultiscaleTransform = mat4.create();
      for (let i = 0; i < 3; ++i) {
        chunkToMultiscaleTransform[5 * i] = downsampleFactor;
        chunkToMultiscaleTransform[12 + i] = lowerVoxelBound[i] * downsampleFactor;
      }
      let alternatives =
          makeDefaultVolumeChunkSpecifications({
            rank: 3,
            chunkToMultiscaleTransform,
            dataType: this.dataType,

            baseVoxelOffset: lowerVoxelBound,
            upperVoxelBound: vec3.subtract(vec3.create(), upperVoxelBound, lowerVoxelBound),
            volumeType: this.volumeType,
            volumeSourceOptions,
            compressedSegmentationBlockSize:
                ((encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION ||
                  encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY) ?
                     vec3.fromValues(8, 8, 8) :
                     undefined)
          }).map(spec => ({
                   chunkSource: chunkManager.getChunkSource(
                       DVIDVolumeChunkSource, {spec, parameters: volParameters}),
                   chunkToMultiscaleTransform,
                 }));
      sources.push(alternatives);
    }
    return transposeNestedArrays(sources);
  }
}

export function parseDataInstance(
    obj: any, name: string, instanceNames: Array<string>): DataInstanceInfo {
  verifyObject(obj);
  let baseInfo = verifyObjectProperty(obj, 'Base', x => new DataInstanceBaseInfo(x));
  switch (baseInfo.typeName) {
    case 'uint8blk':
    case 'grayscale8':
      let isjpegcompress = baseInfo.compressionName.indexOf('jpeg') !== -1;
      return new VolumeDataInstanceInfo(
          obj, name, baseInfo,
          (isjpegcompress ? VolumeChunkEncoding.JPEG : VolumeChunkEncoding.RAW), instanceNames);
    case 'labels64':
    case 'labelblk':
      return new VolumeDataInstanceInfo(
          obj, name, baseInfo, VolumeChunkEncoding.COMPRESSED_SEGMENTATION, instanceNames);
    case 'labelarray':
    case 'labelmap':
      return new VolumeDataInstanceInfo(
          obj, name, baseInfo, VolumeChunkEncoding.COMPRESSED_SEGMENTATIONARRAY, instanceNames);
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
  constructor(obj: any) {
    this.repositories = parseRepositoriesInfo(obj);
  }

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

export function getServerInfo(chunkManager: ChunkManager, baseUrl: string) {
  return chunkManager.memoize.getUncounted({type: 'dvid:getServerInfo', baseUrl}, () => {
    const result = fetchOk(`${baseUrl}/api/repos/info`)
                       .then(response => response.json())
                       .then(response => new ServerInfo(response));
    const description = `repository info for DVID server ${baseUrl}`;
    StatusMessage.forPromise(result, {
      initialMessage: `Retrieving ${description}.`,
      delay: true,
      errorPrefix: `Error retrieving ${description}: `,
    });
    return result;
  });
}

/**
 * Get extra dataInstance info that isn't available on the server level.
 * this requires an extra api call
 */
export function getDataInstanceDetails(
    chunkManager: ChunkManager, baseUrl: string, nodeKey: string, info: VolumeDataInstanceInfo) {
  return chunkManager.memoize.getUncounted(
      {type: 'dvid:getInstanceDetails', baseUrl, nodeKey, name: info.name}, async () => {
        let result = fetchOk(`${baseUrl}/api/node/${nodeKey}/${info.name}/info`)
                         .then(response => response.json());
        const description = `datainstance info for node ${nodeKey} and instance ${info.name} ` +
            `on DVID server ${baseUrl}`;

        StatusMessage.forPromise(result, {
          initialMessage: `Retrieving ${description}.`,
          delay: true,
          errorPrefix: `Error retrieving ${description}: `,
        });

        const instanceDetails = await result;

        let extended = verifyObjectProperty(instanceDetails, 'Extended', verifyObject);
        info.lowerVoxelBound =
            verifyObjectProperty(extended, 'MinPoint', x => parseIntVec(vec3.create(), x));
        info.upperVoxelBoundInclusive =
            verifyObjectProperty(extended, 'MaxPoint', x => parseIntVec(vec3.create(), x));
        return info;
      });
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
      chunkManager: ChunkManager, public baseUrl: string, public nodeKey: string,
      public dataInstanceKey: string, public info: VolumeDataInstanceInfo) {
    super(chunkManager);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.info.getSources(
        this.chunkManager, {
          'baseUrl': this.baseUrl,
          'nodeKey': this.nodeKey,
          'dataInstanceKey': this.dataInstanceKey,
        },
        volumeSourceOptions);
  }
}

const urlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+)$/;

export function getDataSource(options: GetDataSourceOptions): Promise<DataSource> {
  let match = options.providerUrl.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid DVID URL: ${JSON.stringify(options.providerUrl)}.`);
  }
  const baseUrl = match[1];
  const nodeKey = match[2];
  const dataInstanceKey = match[3];
  return options.chunkManager.memoize.getUncounted(
      {
        type: 'dvid:MultiscaleVolumeChunkSource',
        baseUrl,
        nodeKey: nodeKey,
        dataInstanceKey,
      },
      async () => {
        const serverInfo = await getServerInfo(options.chunkManager, baseUrl);
        let repositoryInfo = serverInfo.getNode(nodeKey);
        if (repositoryInfo === undefined) {
          throw new Error(`Invalid node: ${JSON.stringify(nodeKey)}.`);
        }
        const dataInstanceInfo = repositoryInfo.dataInstances.get(dataInstanceKey);
        if (!(dataInstanceInfo instanceof VolumeDataInstanceInfo)) {
          throw new Error(`Invalid data instance ${dataInstanceKey}.`);
        }
        const info =
            await getDataInstanceDetails(options.chunkManager, baseUrl, nodeKey, dataInstanceInfo);
        const volume = new DvidMultiscaleVolumeChunkSource(
            options.chunkManager, baseUrl, nodeKey, dataInstanceKey, info);
        const box: BoundingBox = {
          lowerBounds: new Float64Array(info.lowerVoxelBound),
          upperBounds: Float64Array.from(info.upperVoxelBoundInclusive, x => x + 1)
        };
        const modelSpace = makeCoordinateSpace({
          rank: 3,
          names: ['x', 'y', 'z'],
          units: ['m', 'm', 'm'],
          scales: Float64Array.from(info.voxelSize, x => x / 1e9),
          boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
        });
        const dataSource: DataSource = {
          modelTransform: makeIdentityTransform(modelSpace),
          subsources: [{
            id: 'default',
            subsource: {volume},
            default: true,
          }],
        };
        if (info.meshSrc) {
          const subsourceToModelSubspaceTransform = mat4.create();
          for (let i = 0; i < 3; ++i) {
            subsourceToModelSubspaceTransform[5 * i] = 1 / info.voxelSize[i];
          }
          dataSource.subsources.push({
            id: 'meshes',
            default: true,
            subsource: {
              mesh: options.chunkManager.getChunkSource(DVIDMeshSource, {
                parameters: {
                  'baseUrl': baseUrl,
                  'nodeKey': nodeKey,
                  'dataInstanceKey': info.meshSrc,
                }
              })
            },
            subsourceToModelSubspaceTransform,
          });
        }
        if (info.skeletonSrc) {
          dataSource.subsources.push({
            id: 'skeletons',
            default: true,
            subsource: {
              mesh: options.chunkManager.getChunkSource(DVIDSkeletonSource, {
                parameters: {
                  'baseUrl': baseUrl,
                  'nodeKey': nodeKey,
                  'dataInstanceKey': info.skeletonSrc,
                }
              })
            },
          });
        }
        dataSource.subsources.push({
          id: 'bounds',
          subsource: {staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(box)},
          default: true,
        });
        return dataSource;
      });
}

export function completeInstanceName(
    repositoryInfo: RepositoryInfo, prefix: string): CompletionResult {
  return {
    offset: 0,
    completions: getPrefixMatchesWithDescriptions<DataInstanceInfo>(
        prefix, repositoryInfo.dataInstances.values(), instance => instance.name,
        instance => {
          return `${instance.base.typeName}`;
        })
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
  let repositoryInfo = serverInfo.getNode(nodeKey);
  return applyCompletionOffset(nodeKey.length + 1, completeInstanceName(repositoryInfo, match[2]));
}

export async function completeUrl(options: CompleteUrlOptions): Promise<CompletionResult> {
  const curUrlPattern = /^((?:http|https):\/\/[^\/]+)\/(.*)$/;
  let match = options.providerUrl.match(curUrlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    throw null;
  }
  let baseUrl = match[1];
  let path = match[2];
  const serverInfo = await getServerInfo(options.chunkManager, baseUrl);
  return applyCompletionOffset(baseUrl.length + 1, completeNodeAndInstance(serverInfo, path));
}

export class DVIDDataSource extends DataSourceProvider {
  get description() {
    return 'DVID';
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options);
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeUrl(options);
  }
}
