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
 * Support for Python integration.
 */

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {MeshSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters, meshSourceToString, volumeSourceToString} from 'neuroglancer/datasource/python/base';
import {MeshSource as GenericMeshSource} from 'neuroglancer/mesh/frontend';
import {DataType, VolumeChunkSpecification, VolumeType} from 'neuroglancer/sliceview/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource as GenericVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {Vec3, vec3} from 'neuroglancer/util/geom';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseIntVec, stableStringify, verifyEnumString, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';

export class VolumeChunkSource extends GenericVolumeChunkSource {
  constructor(
      chunkManager: ChunkManager, spec: VolumeChunkSpecification,
      public parameters: VolumeChunkSourceParameters) {
    super(chunkManager, spec);
    this.initializeCounterpart(
        chunkManager.rpc!, {'type': 'python/VolumeChunkSource', 'parameters': parameters});
  }
  toString() { return volumeSourceToString(this.parameters); }
};

export class MeshSource extends GenericMeshSource {
  constructor(chunkManager: ChunkManager, public parameters: MeshSourceParameters) {
    super(chunkManager);
    this.initializeCounterpart(
        this.chunkManager.rpc!, {'type': 'python/MeshSource', 'parameters': parameters});
  }
  toString() { return meshSourceToString(this.parameters); }
};

interface ScaleInfo {
  key: string;
  lowerVoxelBound: Vec3;
  upperVoxelBound: Vec3;
  chunkDataSizes?: Vec3[];
  voxelSize: Vec3;
}

function parseScaleInfo(obj: any) {
  verifyObject(obj);
  return {
    key: verifyObjectProperty(obj, 'key', verifyString),
    lowerVoxelBound:
        verifyObjectProperty(obj, 'lowerVoxelBound', x => parseIntVec(vec3.create(), x)),
    upperVoxelBound:
        verifyObjectProperty(obj, 'upperVoxelBound', x => parseIntVec(vec3.create(), x)),
    voxelSize: verifyObjectProperty(
        obj, 'voxelSize', x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat)),
    chunkDataSizes: verifyObjectProperty(
        obj, 'chunkDataSizes', x => x === undefined ?
            x :
            parseArray(x, y => parseFixedLengthArray(vec3.create(), y, verifyPositiveInt))),
  };
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  numChannels: number;
  volumeType: VolumeType;
  encoding: VolumeChunkEncoding;
  scales: ScaleInfo[];

  constructor(public baseUrls: string[], public key: string, public response: any) {
    verifyObject(response);
    this.dataType = verifyObjectProperty(response, 'dataType', x => verifyEnumString(x, DataType));
    this.volumeType =
        verifyObjectProperty(response, 'volumeType', x => verifyEnumString(x, VolumeType));
    this.numChannels = verifyObjectProperty(response, 'numChannels', verifyPositiveInt);
    this.encoding =
        verifyObjectProperty(response, 'encoding', x => verifyEnumString(x, VolumeChunkEncoding));
    this.scales = verifyObjectProperty(response, 'scales', x => parseArray(x, parseScaleInfo));
  }

  getSources(chunkManager: ChunkManager) {
    let {numChannels, dataType, volumeType, encoding} = this;
    return this.scales.map(scaleInfo => {
      return VolumeChunkSpecification
          .getDefaults({
            voxelSize: scaleInfo.voxelSize,
            dataType,
            volumeType,
            numChannels,
            lowerVoxelBound: scaleInfo.lowerVoxelBound,
            upperVoxelBound: scaleInfo.upperVoxelBound,
            chunkDataSizes: scaleInfo.chunkDataSizes,
          })
          .map(spec => {
            let parameters = {baseUrls: this.baseUrls, key: scaleInfo.key, encoding: encoding};
            return chunkManager.getChunkSource(
                VolumeChunkSource, stableStringify(parameters),
                () => new VolumeChunkSource(chunkManager, spec, parameters));
          });
    });
  }

  getMeshSource(chunkManager: ChunkManager) {
    let parameters = {
      baseUrls: this.baseUrls,
      key: this.key,
    };
    return chunkManager.getChunkSource(
        MeshSource, stableStringify(parameters), () => new MeshSource(chunkManager, parameters));
  }
};

let existingVolumes = new Map<string, Promise<MultiscaleVolumeChunkSource>>();
export function getShardedVolume(baseUrls: string[], key: string) {
  let cacheKey = stableStringify({'baseUrls': baseUrls, 'key': key});
  let existingResult = existingVolumes.get(key);
  if (existingResult !== undefined) {
    return existingResult;
  }
  let promise =
      sendHttpRequest(openShardedHttpRequest(baseUrls, `/neuroglancer/info/${key}`), 'json')
          .then(response => new MultiscaleVolumeChunkSource(baseUrls, key, response));
  existingVolumes.set(cacheKey, promise);
  return promise;
}

const urlPattern = /^((?:http|https):\/\/[^\/?]+)\/(.*)$/;

export function getVolume(path: string) {
  let match = path.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid python volume path: ${JSON.stringify(path)}`);
  }
  return getShardedVolume([match[1]], match[2]);
}

registerDataSourceFactory('python', {
  description: 'Python-served volume',
  getVolume: getVolume,
});
