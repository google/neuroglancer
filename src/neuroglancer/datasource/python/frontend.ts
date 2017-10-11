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

import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {DataSource} from 'neuroglancer/datasource';
import {MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/python/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {DataType, DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2, getNearIsotropicBlockSize, getTwoDimensionalBlockSize} from 'neuroglancer/sliceview/base';
import {VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {VolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {openHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, verify3dDimensions, verify3dScale, verify3dVec, verifyEnumString, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';

class PythonVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {}
class PythonMeshSource extends
(WithParameters(MeshSource, MeshSourceParameters)) {}

interface ScaleInfo {
  key: string;
  offset: vec3;
  sizeInVoxels: vec3;
  chunkDataSize?: vec3;
  voxelSize: vec3;
}

function parseScaleInfo(obj: any): ScaleInfo {
  verifyObject(obj);
  return {
    key: verifyObjectProperty(obj, 'key', verifyString),
    offset: verifyObjectProperty(obj, 'offset', verify3dVec),
    sizeInVoxels: verifyObjectProperty(obj, 'sizeInVoxels', verify3dDimensions),
    voxelSize: verifyObjectProperty(obj, 'voxelSize', verify3dScale),
    chunkDataSize: verifyObjectProperty(
        obj, 'chunkDataSize', x => x === undefined ? undefined : verify3dDimensions(x)),
  };
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  numChannels: number;
  volumeType: VolumeType;
  encoding: VolumeChunkEncoding;
  scales: ScaleInfo[][];

  constructor(public chunkManager: ChunkManager, public key: string, public response: any) {
    verifyObject(response);
    this.dataType = verifyObjectProperty(response, 'dataType', x => verifyEnumString(x, DataType));
    this.volumeType =
        verifyObjectProperty(response, 'volumeType', x => verifyEnumString(x, VolumeType));
    this.numChannels = verifyObjectProperty(response, 'numChannels', verifyPositiveInt);
    this.encoding =
        verifyObjectProperty(response, 'encoding', x => verifyEnumString(x, VolumeChunkEncoding));
    let maxVoxelsPerChunkLog2 = verifyObjectProperty(
        response, 'maxVoxelsPerChunkLog2',
        x => x === undefined ? DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2 : verifyPositiveInt(x));

    /**
     * Scales used for arbitrary orientation (should be near isotropic).
     *
     * Exactly one of threeDimensionalScales and twoDimensionalScales should be specified.
     */
    let threeDimensionalScales = verifyObjectProperty(
        response, 'threeDimensionalScales',
        x => x === undefined ? undefined : parseArray(x, parseScaleInfo));

    /**
     * Separate scales used for XY, XZ, YZ slice views, respectively.  The chunks should be flat or
     * nearly flat in Z, Y, X respectively.  The inner arrays must have length 3.
     */
    let twoDimensionalScales = verifyObjectProperty(
        response, 'twoDimensionalScales',
        x => x === undefined ?
            undefined :
            parseArray(x, y => parseFixedLengthArray(new Array<ScaleInfo>(3), y, parseScaleInfo)));
    if ((twoDimensionalScales === undefined) === (threeDimensionalScales === undefined)) {
      throw new Error(
          `Exactly one of "threeDimensionalScales" and "twoDimensionalScales" must be specified.`);
    }
    if (twoDimensionalScales !== undefined) {
      if (twoDimensionalScales.length === 0) {
        throw new Error(`At least one scale must be specified.`);
      }
      this.scales = twoDimensionalScales.map(levelScales => levelScales.map((scale, index) => {
        const {voxelSize, sizeInVoxels} = scale;
        const flatDimension = 2 - index;
        let {
            chunkDataSize = getTwoDimensionalBlockSize(
                {voxelSize, upperVoxelBound: sizeInVoxels, flatDimension, maxVoxelsPerChunkLog2})} =
            scale;
        return {
          key: scale.key,
          offset: scale.offset,
          sizeInVoxels,
          voxelSize,
          chunkDataSize,
        };
      }));
      if (!vec3.equals(this.scales[0][0].voxelSize, this.scales[0][1].voxelSize) ||
          !vec3.equals(this.scales[0][0].voxelSize, this.scales[0][2].voxelSize)) {
        throw new Error(`Lowest scale must have uniform voxel size.`);
      }
    }
    if (threeDimensionalScales !== undefined) {
      if (threeDimensionalScales.length === 0) {
        throw new Error(`At least one scale must be specified.`);
      }
      this.scales = threeDimensionalScales.map(scale => {
        let {voxelSize, sizeInVoxels} = scale;
        let {chunkDataSize = getNearIsotropicBlockSize(
                 {voxelSize, upperVoxelBound: sizeInVoxels, maxVoxelsPerChunkLog2})} = scale;
        return [{key: scale.key, offset: scale.offset, sizeInVoxels, voxelSize, chunkDataSize}];
      });
    }
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let {numChannels, dataType, volumeType, encoding} = this;
    // Clip based on the bounds of the first scale.
    const baseScale = this.scales[0][0];
    let upperClipBound = vec3.multiply(vec3.create(), baseScale.voxelSize, baseScale.sizeInVoxels);
    return this.scales.map(levelScales => levelScales.map(scaleInfo => {
      const spec = VolumeChunkSpecification.withDefaultCompression({
        voxelSize: scaleInfo.voxelSize,
        dataType,
        volumeType,
        numChannels,
        transform: mat4.fromTranslation(mat4.create(), scaleInfo.offset),
        upperVoxelBound: scaleInfo.sizeInVoxels,
        upperClipBound: upperClipBound,
        chunkDataSize: scaleInfo.chunkDataSize!,
        volumeSourceOptions,
      });
      return this.chunkManager.getChunkSource(
          PythonVolumeChunkSource,
          {spec, parameters: {key: `${this.key}/${scaleInfo.key}`, encoding: encoding}});
    }));
  }

  getMeshSource() {
    return this.chunkManager.getChunkSource(PythonMeshSource, {
      parameters: {
        key: this.key,
      }
    });
  }
}

export class PythonSkeletonSource extends
(WithParameters(SkeletonSource, SkeletonSourceParameters)) {
  get skeletonVertexCoordinatesInVoxels() {
    return false;
  }
  get vertexAttributes() {
    return this.parameters.vertexAttributes;
  }
}

function parseVertexAttributeInfo(x: any): VertexAttributeInfo {
  verifyObject(x);
  return {
    dataType: verifyObjectProperty(x, 'dataType', y => verifyEnumString(y, DataType)),
    numComponents: verifyObjectProperty(x, 'numComponents', verifyPositiveInt),
  };
}

function parseSkeletonVertexAttributes(spec: string): Map<string, VertexAttributeInfo> {
  return verifyObjectAsMap(JSON.parse(spec), parseVertexAttributeInfo);
}

export function getSkeletonSource(chunkManager: ChunkManager, key: string) {
  const skeletonKeyPattern = /^([^\/?]+)\?(.*)$/;

  let match = key.match(skeletonKeyPattern);
  if (match === null) {
    throw new Error(`Invalid python volume path: ${JSON.stringify(key)}`);
  }
  return chunkManager.getChunkSource(PythonSkeletonSource, {
    parameters: {
      key: match[1],
      vertexAttributes: parseSkeletonVertexAttributes(match[2]),
    }
  });
}

export function getVolume(chunkManager: ChunkManager, key: string) {
  return chunkManager.memoize.getUncounted(
      {'type': 'python:MultiscaleVolumeChunkSource', key},
      () => sendHttpRequest(openHttpRequest(`/neuroglancer/info/${key}`), 'json')
                .then(
                    response =>
                        new MultiscaleVolumeChunkSource(chunkManager, key, response)));
}

export class PythonDataSource extends DataSource {
  get description() {
    return 'Python-served volume';
  }
  getVolume(chunkManager: ChunkManager, key: string) {
    return getVolume(chunkManager, key);
  }
  getSkeletonSource(chunkManager: ChunkManager, key: string) {
    return getSkeletonSource(chunkManager, key);
  }
}
