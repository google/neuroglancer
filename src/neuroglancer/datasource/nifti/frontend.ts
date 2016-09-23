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

import {ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {VolumeSourceParameters, GET_NIFTI_VOLUME_INFO_RPC_ID, NIFTI_FILE_SOURCE_RPC_ID, NiftiVolumeInfo} from 'neuroglancer/datasource/nifti/base';
import {defineParameterizedVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {registerSharedObjectOwner} from 'neuroglancer/worker_rpc';
import {RPC} from 'neuroglancer/worker_rpc';

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  constructor (public chunkManager: ChunkManager, public url: string, public info: NiftiVolumeInfo) {}
  get numChannels () { return this.info.numChannels; }
  get dataType() { return this.info.dataType; }
  get volumeType() { return this.info.volumeType; }
  getSources() {
    const spec = VolumeChunkSpecification.withDefaultCompression({
      volumeType: this.info.volumeType,
      chunkDataSize: this.info.volumeSize,
      dataType: this.info.dataType,
      voxelSize: this.info.voxelSize,
      numChannels: this.info.numChannels,
      upperVoxelBound: this.info.volumeSize,
    });
    return [[
      VolumeChunkSource.get(this.chunkManager, spec, {url: this.url})
    ]];
  }

  getMeshSource(): null { return null; }
}

function getNiftiFileSource(chunkManager: ChunkManager) {
  return chunkManager.getChunkSource(NiftiFileSource, '', () => new NiftiFileSource(chunkManager));
}

const BaseVolumeChunkSource = defineParameterizedVolumeChunkSource(VolumeSourceParameters);
class VolumeChunkSource extends BaseVolumeChunkSource {
  initializeCounterpart(rpc: RPC, options: any) {
    let fileSource = getNiftiFileSource(this.chunkManager);
    options['fileSource'] = fileSource.addCounterpartRef();
    fileSource.dispose();
    super.initializeCounterpart(rpc, options);
  }
};

/**
 * Each chunk corresponds to a URL retrieved on the backend.
 */
@registerSharedObjectOwner(NIFTI_FILE_SOURCE_RPC_ID)
class NiftiFileSource extends ChunkSource {}

function getNiftiVolumeInfo(chunkManager: ChunkManager, url: string) {
  let source =
      chunkManager.getChunkSource(NiftiFileSource, '', () => new NiftiFileSource(chunkManager));
  let result = chunkManager.rpc!.promiseInvoke<NiftiVolumeInfo>(
    GET_NIFTI_VOLUME_INFO_RPC_ID, {'source': source.addCounterpartRef(), 'url': url});
  // Immediately dispose of our local reference to the source.  The counterpart reference will keep
  // it alive until a chunk is created.
  source.dispose();
  return result;
}

export function getVolume(chunkManager: ChunkManager, url: string) {
  return chunkManager.memoize.getUncounted(
      url, () => getNiftiVolumeInfo(chunkManager, url)
                     .then(info => new MultiscaleVolumeChunkSource(chunkManager, url, info)));
}

registerDataSourceFactory('nifti', {
  description: 'Single NIfTI file',
  getVolume: getVolume,
});
