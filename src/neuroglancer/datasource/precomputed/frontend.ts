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

import {VolumeChunkEncoding} from 'neuroglancer/datasource/precomputed/base';
import {DataType, VolumeType, VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {VolumeChunkSource as GenericVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {MeshSource as GenericMeshSource} from 'neuroglancer/mesh/frontend';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {vec3, Vec3} from 'neuroglancer/util/geom';
import {parseFiniteVec, parseIntVec, parseArray, stableStringify} from 'neuroglancer/util/json';
import {openShardedHttpRequest, sendHttpRequest, parseSpecialUrl} from 'neuroglancer/util/http_request';

let serverDataTypes = new Map<string, DataType>();
serverDataTypes.set('uint8', DataType.UINT8);
serverDataTypes.set('uint32', DataType.UINT32);
serverDataTypes.set('uint64', DataType.UINT64);

let serverVolumeTypes = new Map<string, VolumeType>();
serverVolumeTypes.set('image', VolumeType.IMAGE);
serverVolumeTypes.set('segmentation', VolumeType.SEGMENTATION);

let serverChunkEncodings = new Map<string, VolumeChunkEncoding>();
serverChunkEncodings.set('raw', VolumeChunkEncoding.RAW);
serverChunkEncodings.set('jpeg', VolumeChunkEncoding.JPEG);
serverChunkEncodings.set('compressed_segmentation', VolumeChunkEncoding.COMPRESSED_SEGMENTATION);

export class VolumeChunkSource extends GenericVolumeChunkSource {
  constructor(
    chunkManager: ChunkManager, spec: VolumeChunkSpecification, public baseUrls: string[]|string, public path: string,
    public encoding: VolumeChunkEncoding) {
    super(chunkManager, spec);
    this.initializeCounterpart(chunkManager.rpc, {
      'type': 'precomputed/VolumeChunkSource',
      'baseUrls': baseUrls,
      'path': path,
      'encoding': encoding,
    });
  }

  toString () {
    return `precomputed:volume:${this.baseUrls[0]}/${this.path}`;
  }
};

class ScaleInfo {
  key: string;
  encoding: VolumeChunkEncoding;
  resolution: Vec3;
  voxelOffset: Vec3;
  size: Vec3;
  chunkSizes: Vec3[];
  compressedSegmentationBlockSize: Vec3|undefined;
  constructor (response: any) {
    if (typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Failed to parse volume metadata.');
    }
    this.resolution = parseFiniteVec(vec3.create(), response['resolution']);
    this.voxelOffset = parseIntVec(vec3.create(), response['voxel_offset']);
    this.size = parseIntVec(vec3.create(), response['size']);
    this.chunkSizes = parseArray(response['chunk_sizes'], x => parseFiniteVec(vec3.create(), x));
    if (this.chunkSizes.length === 0) {
      throw new Error('No chunk sizes specified.');
    }
    let encodingStr = response['encoding'];
    let encoding = serverChunkEncodings.get(encodingStr);
    if (encoding === undefined) {
      throw new Error(`Invalid chunk encoding: ${JSON.stringify(encodingStr)}`);
    }
    this.encoding = encoding;
    if (encoding === VolumeChunkEncoding.COMPRESSED_SEGMENTATION) {
      this.compressedSegmentationBlockSize = parseIntVec(vec3.create(), response['compressed_segmentation_block_size']);
    }
    this.key = response['key'];
    if (typeof this.key !== 'string') {
      throw new Error('No key specified.');
    }
  }
};

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  numChannels: number;
  volumeType: VolumeType;
  mesh: string|undefined;
  scales: ScaleInfo[];

  getMeshSource (chunkManager: ChunkManager) {
    let {mesh} = this;
    if (mesh === undefined) {
      return null;
    }
    return getShardedMeshSource(chunkManager, this.baseUrls, `${this.path}/${mesh}`, /*lod=*/0);
  }

  constructor(public baseUrls: string[], public path: string, private response: any) {
    if (typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Failed to parse volume metadata.');
    }
    let dataTypeStr = response['data_type'];
    let dataType = serverDataTypes.get(dataTypeStr);
    if (dataType === undefined) {
      throw new Error(`Invalid data type: ${JSON.stringify(dataTypeStr)}`);
    }
    let numChannels = response['num_channels'];
    if (typeof numChannels !== 'number') {
      throw new Error('Invalid number of channels.');
    }
    this.numChannels = numChannels;
    this.dataType = dataType;
    let volumeTypeStr = response['type'];
    let volumeType = serverVolumeTypes.get(volumeTypeStr);
    if (volumeType === undefined) {
      throw new Error(`Invalid volume type: ${JSON.stringify(volumeTypeStr)}`);
    }
    this.volumeType = volumeType;

    let meshStr = response['mesh'];
    if (meshStr !== undefined && typeof meshStr !== 'string') {
      throw new Error('Invalid "mesh" field.');
    }
    this.mesh = meshStr;
    this.scales = parseArray(response['scales'], x => new ScaleInfo(x));
  }

  getSources(chunkManager: ChunkManager) {
    return this.scales.map(scaleInfo => {
      return Array
          .from(VolumeChunkSpecification.getDefaults({
            voxelSize: scaleInfo.resolution,
            dataType: this.dataType,
            numChannels: this.numChannels,
            lowerVoxelBound: scaleInfo.voxelOffset,
            upperVoxelBound: vec3.add(vec3.create(), scaleInfo.voxelOffset, scaleInfo.size),
            volumeType: this.volumeType,
            chunkDataSizes: scaleInfo.chunkSizes,
            compressedSegmentationBlockSize: scaleInfo.compressedSegmentationBlockSize
          }))
          .map(spec => {
            let path = `${this.path}/${scaleInfo.key}`;
            let cacheKey = stableStringify({
              'spec': spec,
              'baseUrls': this.baseUrls,
              'path': path,
              'encoding': scaleInfo.encoding
            });
            return chunkManager.getChunkSource(
                VolumeChunkSource, cacheKey,
                () => new VolumeChunkSource(
                    chunkManager, spec, this.baseUrls, path, scaleInfo.encoding));
          });
    });
  }
};

export class MeshSource extends GenericMeshSource {
  constructor(chunkManager: ChunkManager, public baseUrls: string|string[], public path: string, public lod: number) {
    super(chunkManager);
    this.initializeCounterpart(
        this.chunkManager.rpc,
        {'type': 'precomputed/MeshSource', 'baseUrls': baseUrls, 'path': path, 'lod': lod});
  }
  toString () {
    return `precomputed:mesh:${this.baseUrls[0]}/${this.path}`;
  }
};

export function getShardedMeshSource(chunkManager: ChunkManager, baseUrls: string[], path: string, lod: number) {
  return chunkManager.getChunkSource(
      MeshSource, JSON.stringify({'baseUrls': baseUrls, 'path': path, 'lod': lod}),
    () => new MeshSource(chunkManager, baseUrls, path, lod));
}

export function getMeshSource(chunkManager: ChunkManager, url: string, lod: number) {
  const [baseUrls, path] = parseSpecialUrl(url);
  return getShardedMeshSource(chunkManager, baseUrls, path, lod);
}

let existingVolumes = new Map<string, Promise<MultiscaleVolumeChunkSource>>();
export function getShardedVolume(baseUrls: string[], path: string) {
  let fullKey = stableStringify({'baseUrls': baseUrls, 'path': path});
  let existingResult = existingVolumes.get(fullKey);
  if (existingResult !== undefined) {
    return existingResult;
  }
  let promise = sendHttpRequest(openShardedHttpRequest(baseUrls, path + '/info'), 'json')
                    .then(response => new MultiscaleVolumeChunkSource(baseUrls, path, response));
  existingVolumes.set(fullKey, promise);
  return promise;
}

export function getVolume(url: string) {
  const [baseUrls, path] = parseSpecialUrl(url);
  return getShardedVolume(baseUrls, path);
}

registerDataSourceFactory('precomputed', {
  description: 'Precomputed file-backed data source',
  getVolume: getVolume,
  getMeshSource: getMeshSource,
});
