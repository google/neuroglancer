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
 * @file Support for displaying single NIfTI (https://www.nitrc.org/projects/nifti) files as
 * volumes.
 */

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {GET_NIFTI_VOLUME_INFO_RPC_ID, NiftiVolumeInfo, VolumeSourceParameters} from 'neuroglancer/datasource/nifti/base';
import {VolumeChunkSpecification, VolumeSourceOptions} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, defineParameterizedVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {kOneVec, mat4, translationRotationScaleZReflectionToMat4} from 'neuroglancer/util/geom';

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  constructor(public chunkManager: ChunkManager, public url: string, public info: NiftiVolumeInfo) {
  }
  get numChannels() {
    return this.info.numChannels;
  }
  get dataType() {
    return this.info.dataType;
  }
  get volumeType() {
    return this.info.volumeType;
  }
  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let {info} = this;
    const spec = VolumeChunkSpecification.withDefaultCompression({
      volumeType: info.volumeType,
      chunkDataSize: info.volumeSize,
      dataType: info.dataType,
      voxelSize: info.voxelSize,
      numChannels: info.numChannels,
      upperVoxelBound: info.volumeSize,
      transform: translationRotationScaleZReflectionToMat4(
          mat4.create(), info.qoffset, info.quatern, kOneVec, info.qfac),
      volumeSourceOptions,
    });
    return [[VolumeChunkSource.get(this.chunkManager, spec, {url: this.url})]];
  }

  getMeshSource(): null {
    return null;
  }
}

const VolumeChunkSource = defineParameterizedVolumeChunkSource(VolumeSourceParameters);

function getNiftiVolumeInfo(chunkManager: ChunkManager, url: string, cancellationToken: CancellationToken) {
  return chunkManager.rpc!.promiseInvoke<NiftiVolumeInfo>(
      GET_NIFTI_VOLUME_INFO_RPC_ID, {'chunkManager': chunkManager.addCounterpartRef(), 'url': url},
      cancellationToken);
}

export function getVolume(chunkManager: ChunkManager, url: string) {
  return chunkManager.memoize.getUncounted(
      {type: 'nifti/getVolume', url},
      () => getNiftiVolumeInfo(chunkManager, url, uncancelableToken)
                .then(info => new MultiscaleVolumeChunkSource(chunkManager, url, info)));
}

registerDataSourceFactory('nifti', {
  description: 'Single NIfTI file',
  getVolume: getVolume,
});
