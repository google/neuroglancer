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

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {makeCoordinateSpace, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {GET_NIFTI_VOLUME_INFO_RPC_ID, NiftiVolumeInfo, VolumeSourceParameters} from 'neuroglancer/datasource/nifti/base';
import {makeVolumeChunkSpecificationWithDefaultCompression, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import * as matrix from 'neuroglancer/util/matrix';

class NiftiVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeSourceParameters)) {}

export class NiftiMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  constructor(chunkManager: ChunkManager, public url: string, public info: NiftiVolumeInfo) {
    super(chunkManager);
  }
  get dataType() {
    return this.info.dataType;
  }
  get volumeType() {
    return VolumeType.UNKNOWN;
  }
  get rank() {
    return this.info.rank;
  }
  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let {info} = this;
    const chunkToMultiscaleTransform = matrix.createIdentity(Float32Array, info.rank + 1);
    const spec = makeVolumeChunkSpecificationWithDefaultCompression({
      rank: info.rank,
      volumeType: VolumeType.UNKNOWN,
      chunkDataSize: info.volumeSize,
      dataType: info.dataType,
      upperVoxelBound: Float32Array.from(info.volumeSize),
      chunkToMultiscaleTransform,
      volumeSourceOptions,
    });
    return [[{
      chunkSource: this.chunkManager.getChunkSource(
          NiftiVolumeChunkSource, {spec, parameters: {url: this.url}}),
      chunkToMultiscaleTransform,
    }]];
  }
}

function getNiftiVolumeInfo(
    chunkManager: ChunkManager, url: string, cancellationToken: CancellationToken) {
  return chunkManager.rpc!.promiseInvoke<NiftiVolumeInfo>(
      GET_NIFTI_VOLUME_INFO_RPC_ID, {'chunkManager': chunkManager.addCounterpartRef(), 'url': url},
      cancellationToken);
}

function getDataSource(chunkManager: ChunkManager, url: string) {
  return chunkManager.memoize.getUncounted({type: 'nifti/getVolume', url}, async () => {
    const info = await getNiftiVolumeInfo(chunkManager, url, uncancelableToken);
    const volume = new NiftiMultiscaleVolumeChunkSource(chunkManager, url, info);
    const box = {
      lowerBounds: new Float64Array(info.rank),
      upperBounds: Float64Array.from(info.volumeSize),
    };
    const inputSpace = makeCoordinateSpace({
      rank: info.rank,
      names: info.sourceNames,
      scales: info.sourceScales,
      units: info.units,
      boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
    });
    const outputSpace = makeCoordinateSpace({
      rank: info.rank,
      names: info.viewNames,
      scales: info.viewScales,
      units: info.units,
    });
    const dataSource: DataSource = {
      subsources: [
        {
          id: 'default',
          default: true,
          subsource: {volume},
        },
        {
          id: 'bounds',
          default: true,
          subsource: {staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(box)},
        },
      ],
      modelTransform: {
        sourceRank: info.rank,
        rank: info.rank,
        inputSpace,
        outputSpace,
        transform: info.transform,
      },
    };
    return dataSource;
  });
}

export class NiftiDataSource extends DataSourceProvider {
  get description() {
    return 'Single NIfTI file';
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options.chunkManager, options.providerUrl);
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(options.providerUrl, options.cancellationToken);
  }
}
