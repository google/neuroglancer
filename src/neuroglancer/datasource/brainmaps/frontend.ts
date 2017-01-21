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

import 'neuroglancer/datasource/brainmaps/api_frontend';

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {BrainmapsInstance, INSTANCE_IDENTIFIERS, INSTANCE_NAMES, makeRequest, PRODUCTION_INSTANCE} from 'neuroglancer/datasource/brainmaps/api';
import {ChangeSpec, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeSourceParameters} from 'neuroglancer/datasource/brainmaps/base';
import {GetVolumeOptions, registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {defineParameterizedMeshSource} from 'neuroglancer/mesh/frontend';
import {parameterizedSkeletonSource} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/base';
import {defineParameterizedVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {getPrefixMatches} from 'neuroglancer/util/completion';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, parseXYZ, verifyFinitePositiveFloat, verifyMapKey, verifyObject, verifyObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';

const VolumeChunkSource = defineParameterizedVolumeChunkSource(VolumeSourceParameters);
const MeshSource = defineParameterizedMeshSource(MeshSourceParameters);
const BaseSkeletonSource = parameterizedSkeletonSource(SkeletonSourceParameters);

const SERVER_DATA_TYPES = new Map<string, DataType>();
SERVER_DATA_TYPES.set('UINT8', DataType.UINT8);
SERVER_DATA_TYPES.set('FLOAT', DataType.FLOAT32);
SERVER_DATA_TYPES.set('UINT64', DataType.UINT64);

export class VolumeInfo {
  numChannels: number;
  dataType: DataType;
  voxelSize: vec3;
  upperVoxelBound: vec3;
  constructor(obj: any) {
    try {
      verifyObject(obj);
      this.numChannels = verifyPositiveInt(obj['channelCount']);
      this.dataType = verifyMapKey(obj['channelType'], SERVER_DATA_TYPES);
      this.voxelSize = parseXYZ(vec3.create(), obj['pixelSize'], verifyFinitePositiveFloat);
      this.upperVoxelBound = parseXYZ(vec3.create(), obj['volumeSize'], verifyPositiveInt);
    } catch (parseError) {
      throw new Error(`Failed to parse BrainMaps volume geometry: ${parseError.message}`);
    }
  }
};

export class MeshInfo {
  name: string;
  type: string;
  constructor(obj: any) {
    verifyObject(obj);
    this.name = verifyObjectProperty(obj, 'name', verifyString);
    this.type = verifyObjectProperty(obj, 'type', verifyString);
  }
};

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  volumeType: VolumeType;
  scales: VolumeInfo[];
  dataType: DataType;
  numChannels: number;
  meshes: MeshInfo[];
  constructor(
      public chunkManager: ChunkManager, public instance: BrainmapsInstance,
      public volumeId: string, public changeSpec: ChangeSpec|undefined, volumeInfoResponse: any,
      meshesResponse: any, options: GetVolumeOptions) {
    try {
      verifyObject(volumeInfoResponse);
      let scales = this.scales = verifyObjectProperty(
          volumeInfoResponse, 'geometry', y => parseArray(y, x => new VolumeInfo(x)));
      if (scales.length === 0) {
        throw new Error('Expected at least one scale.');
      }
      let baseScale = scales[0];
      let numChannels = this.numChannels = baseScale.numChannels;
      let dataType = this.dataType = baseScale.dataType;
      for (let scaleIndex = 1, numScales = scales.length; scaleIndex < numScales; ++scaleIndex) {
        let scale = scales[scaleIndex];
        if (scale.dataType !== dataType) {
          throw new Error(
              `Scale ${scaleIndex} has data type ${DataType[scale.dataType]} but scale 0 has data type ${DataType[dataType]}.`);
        }
        if (scale.numChannels !== numChannels) {
          throw new Error(
              `Scale ${scaleIndex} has ${scale.numChannels} channel(s) but scale 0 has ${numChannels} channels.`);
        }
      }

      // Infer the VolumeType from the data type and number of channels.
      let volumeType: VolumeType|undefined;
      if (numChannels === 1) {
        switch (dataType) {
          case DataType.UINT64:
            volumeType = VolumeType.SEGMENTATION;
            break;
        }
      }
      if (volumeType === undefined) {
        if (options.volumeType !== undefined) {
          volumeType = options.volumeType;
        } else {
          volumeType = VolumeType.IMAGE;
        }
      }
      this.volumeType = volumeType;
    } catch (parseError) {
      throw new Error(
          `Failed to parse BrainMaps multiscale volume specification: ${parseError.message}`);
    }
    try {
      verifyObject(meshesResponse);
      this.meshes = verifyObjectProperty(meshesResponse, 'meshes', y => {
        if (y === undefined) {
          return [];
        }
        return parseArray(y, x => new MeshInfo(x));
      });
    } catch (parseError) {
      throw new Error(`Failed to parse BrainMaps meshes specification: ${parseError.message}`);
    }
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let encoding = VolumeChunkEncoding.RAW;
    if (this.dataType === DataType.UINT64) {
      encoding = VolumeChunkEncoding.COMPRESSED_SEGMENTATION;
    } else if (
        this.volumeType === VolumeType.IMAGE && this.dataType === DataType.UINT8 &&
        this.numChannels === 1) {
      encoding = VolumeChunkEncoding.JPEG;
    }

    return this.scales.map(
        (volumeInfo, scaleIndex) => VolumeChunkSpecification
                                        .getDefaults({
                                          voxelSize: volumeInfo.voxelSize,
                                          dataType: volumeInfo.dataType,
                                          numChannels: volumeInfo.numChannels,
                                          upperVoxelBound: volumeInfo.upperVoxelBound,
                                          volumeType: this.volumeType, volumeSourceOptions,
                                        })
                                        .map(spec => {
                                          return VolumeChunkSource.get(this.chunkManager, spec, {
                                            'instance': this.instance,
                                            'volumeId': this.volumeId,
                                            'changeSpec': this.changeSpec,
                                            'scaleIndex': scaleIndex,
                                            'encoding': encoding,
                                          });
                                        }));
  }

  getMeshSource() {
    let validMesh = this.meshes.find(x => x.type === 'TRIANGLES');
    if (validMesh === undefined) {
      return null;
    }
    return getMeshSource(
        this.chunkManager,
        {'instance': this.instance, 'volumeId': this.volumeId, 'meshName': validMesh.name});
  }
};

export function getMeshSource(chunkManager: ChunkManager, parameters: MeshSourceParameters) {
  return MeshSource.get(chunkManager, parameters);
}

export class SkeletonSource extends BaseSkeletonSource {
  get skeletonVertexCoordinatesInVoxels() { return false; }
};

export function getSkeletonSource(
    chunkManager: ChunkManager, parameters: SkeletonSourceParameters) {
  return SkeletonSource.get(chunkManager, parameters);
}

export function parseVolumeKey(key: string):
    {volumeId: string, changeSpec: ChangeSpec | undefined} {
  const match = key.match(/^([^:]+:[^:]+:[^:]+)(?::([^:]+))?$/);
  if (match === null) {
    throw new Error(`Invalid Brainmaps volume key: ${JSON.stringify(key)}.`);
  }
  let changeSpec: ChangeSpec|undefined;
  if (match[2] !== undefined) {
    changeSpec = {changeStackId: match[2]};
  }
  return {volumeId: match[1], changeSpec};
}

const meshSourcePattern = /^([^\/]+)\/(.*)$/;

function getMeshSourceParameters(instance: BrainmapsInstance, url: string) {
  let match = url.match(meshSourcePattern);
  if (match === null) {
    throw new Error(`Invalid Brainmaps mesh URL: ${url}`);
  }
  let {volumeId, changeSpec} = parseVolumeKey(match[1]);
  return {instance, volumeId, changeSpec, meshName: match[2]};
}

export function getMeshSourceByUrl(
    instance: BrainmapsInstance, chunkManager: ChunkManager, url: string) {
  return getMeshSource(chunkManager, getMeshSourceParameters(instance, url));
}

export function getSkeletonSourceByUrl(
    instance: BrainmapsInstance, chunkManager: ChunkManager, url: string) {
  return getSkeletonSource(chunkManager, getMeshSourceParameters(instance, url));
}

export function getVolume(
    instance: BrainmapsInstance, chunkManager: ChunkManager, key: string,
    options: GetVolumeOptions) {
  const {volumeId, changeSpec} = parseVolumeKey(key);
  return chunkManager.memoize.getUncounted(
      {type: 'brainmaps:getVolume', instance, volumeId, changeSpec, options},
      () => Promise
                .all([
                  makeRequest(instance, 'GET', `/v1beta2/volumes/${volumeId}`, 'json'),
                  makeRequest(instance, 'GET', `/v1beta2/objects/${volumeId}/meshes`, 'json'),
                ])
                .then(
                    ([volumeInfoResponse, meshesResponse]) => new MultiscaleVolumeChunkSource(
                        chunkManager, instance, volumeId, changeSpec, volumeInfoResponse,
                        meshesResponse, options)));
}

export class VolumeList {
  volumeIds: string[];
  hierarchicalVolumeIds = new Map<string, string[]>();
  constructor(response: any) {
    try {
      verifyObject(response);
      let volumeIds = this.volumeIds = parseArray(response['volumeId'], verifyString);
      volumeIds.sort();
      let hierarchicalSets = new Map<string, Set<string>>();
      for (let volumeId of volumeIds) {
        let componentStart = 0;
        while (true) {
          let nextColon: number|undefined = volumeId.indexOf(':', componentStart);
          if (nextColon === -1) {
            nextColon = undefined;
          } else {
            ++nextColon;
          }
          let groupString = volumeId.substring(0, componentStart);
          let group = hierarchicalSets.get(groupString);
          if (group === undefined) {
            group = new Set<string>();
            hierarchicalSets.set(groupString, group);
          }
          group.add(volumeId.substring(componentStart, nextColon));
          if (nextColon === undefined) {
            break;
          }
          componentStart = nextColon;
        }
      }
      let {hierarchicalVolumeIds} = this;
      for (let [group, valueSet] of hierarchicalSets) {
        hierarchicalVolumeIds.set(group, Array.from(valueSet));
      }
    } catch (parseError) {
      throw new Error(`Failed to parse Brain Maps volume list reply: ${parseError.message}`);
    }
  }
}

export function getVolumeList(chunkManager: ChunkManager, instance: BrainmapsInstance) {
  return chunkManager.memoize.getUncounted({instance, type: 'brainmaps:getVolumeList'}, () => {
    let promise = makeRequest(instance, 'GET', '/v1beta2/volumes/', 'json')
                      .then(response => new VolumeList(response));
    const description = `Google ${INSTANCE_NAMES[instance]} volume list`;
    StatusMessage.forPromise(promise, {
      delay: true,
      initialMessage: `Retrieving ${description}.`,
      errorPrefix: `Error retrieving ${description}: `,
    });
    return promise;
  });
}

export function parseChangeStackList(x: any) {
  return verifyObjectProperty(
      x, 'changeStackId', y => y === undefined ? undefined : parseArray(y, verifyString));
}

export function getChangeStackList(
    chunkManager: ChunkManager, instance: BrainmapsInstance, volumeId: string) {
  return chunkManager.memoize.getUncounted(
      {instance, type: 'brainmaps:getChangeStackList', volumeId}, () => {
        let promise: Promise<string[]> =
            makeRequest(instance, 'GET', `/v1beta2/changes/${volumeId}/change_stacks`, 'json')
                .then(response => parseChangeStackList(response));
        const description = `change stacks for ${volumeId}`;
        StatusMessage.forPromise(promise, {
          delay: true,
          initialMessage: `Retrieving ${description}.`,
          errorPrefix: `Error retrieving ${description}: `,
        });
        return promise;
      });
}

export function volumeCompleter(
    instance: BrainmapsInstance, url: string, chunkManager: ChunkManager) {
  return getVolumeList(chunkManager, instance).then(volumeList => {
    // Check if there is a valid 3-part volume id followed by a colon, in which case we complete the
    // change stack name.
    const changeStackMatch = url.match(/^([^:]+:[^:]+:[^:]+):(.*)$/);
    if (changeStackMatch !== null) {
      const volumeId = changeStackMatch[1];
      const matchString = changeStackMatch[2];
      return getChangeStackList(chunkManager, instance, volumeId).then(changeStacks => {
        if (changeStacks === undefined) {
          return null;
        }
        return {
          offset: volumeId.length + 1,
          completions: getPrefixMatches(matchString, changeStacks)
        };
      });
    }
    let lastColon = url.lastIndexOf(':');
    let splitPoint = lastColon + 1;
    let prefix = url.substring(0, splitPoint);
    let matchString = url.substring(splitPoint);
    let possibleMatches = volumeList.hierarchicalVolumeIds.get(prefix);
    if (possibleMatches === undefined) {
      return null;
    }
    return {offset: prefix.length, completions: getPrefixMatches(matchString, possibleMatches)};
  });
}

export function registerBrainmapsDataSource(instance: BrainmapsInstance) {
  let protocol = 'brainmaps';
  if (instance !== PRODUCTION_INSTANCE) {
    protocol += `-${INSTANCE_IDENTIFIERS[instance].toLowerCase()}`;
  }
  registerDataSourceFactory(protocol, {
    description: `Google ${INSTANCE_NAMES[instance]} API`,
    getVolume: getVolume.bind(undefined, instance),
    getMeshSource: getMeshSourceByUrl.bind(undefined, instance),
    getSkeletonSource: getSkeletonSourceByUrl.bind(undefined, instance),
    volumeCompleter: volumeCompleter.bind(undefined, instance),
  });
}

registerBrainmapsDataSource(PRODUCTION_INSTANCE);
