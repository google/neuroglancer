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

import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {DataSource} from 'neuroglancer/datasource';
import {GET_NIFTI_VOLUME_INFO_RPC_ID, NiftiVolumeInfo, VolumeSourceParameters} from 'neuroglancer/datasource/nifti/base';
import {VolumeChunkSpecification, VolumeSourceOptions} from 'neuroglancer/sliceview/volume/base';
import {VolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {kOneVec, mat4, translationRotationScaleZReflectionToMat4} from 'neuroglancer/util/geom';

class NiftiVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeSourceParameters)) {}

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
    return [[this.chunkManager.getChunkSource(NiftiVolumeChunkSource, {spec, parameters: {url: this.url}})]];
  }

  getMeshSource(): null {
    return null;
  }
}

function getNiftiVolumeInfo(
    chunkManager: ChunkManager, url: string, cancellationToken: CancellationToken) {
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

export class NiftiDataSource extends DataSource {
  get description() { return 'Single NIfTI file'; }
  getVolume(chunkManager: ChunkManager, url: string) {
    return getVolume(chunkManager, url);
  }
}
