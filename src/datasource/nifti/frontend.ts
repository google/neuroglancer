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

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import {
  getCredentialsProviderCounterpart,
  WithCredentialsProvider,
} from "#src/credentials_provider/chunk_source_frontend.js";
import type { CredentialsManager } from "#src/credentials_provider/index.js";
import type {
  CompleteUrlOptions,
  DataSource,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import { DataSourceProvider } from "#src/datasource/index.js";
import type { NiftiVolumeInfo } from "#src/datasource/nifti/base.js";
import {
  GET_NIFTI_VOLUME_INFO_RPC_ID,
  VolumeSourceParameters,
} from "#src/datasource/nifti/base.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  makeVolumeChunkSpecificationWithDefaultCompression,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { completeHttpPath } from "#src/util/http_path_completion.js";
import * as matrix from "#src/util/matrix.js";
import type {
  SpecialProtocolCredentials,
  SpecialProtocolCredentialsProvider,
} from "#src/util/special_protocol_request.js";
import { parseSpecialUrl } from "#src/util/special_protocol_request.js";

class NiftiVolumeChunkSource extends WithParameters(
  WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource),
  VolumeSourceParameters,
) {}

export class NiftiMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  constructor(
    chunkManager: ChunkManager,
    public credentialsProvider: SpecialProtocolCredentialsProvider,
    public url: string,
    public info: NiftiVolumeInfo,
  ) {
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
    const { info } = this;
    const chunkToMultiscaleTransform = matrix.createIdentity(
      Float32Array,
      info.rank + 1,
    );
    const spec = makeVolumeChunkSpecificationWithDefaultCompression({
      rank: info.rank,
      volumeType: VolumeType.UNKNOWN,
      chunkDataSize: info.volumeSize,
      dataType: info.dataType,
      upperVoxelBound: Float32Array.from(info.volumeSize),
      chunkToMultiscaleTransform,
      volumeSourceOptions,
    });
    return [
      [
        {
          chunkSource: this.chunkManager.getChunkSource(
            NiftiVolumeChunkSource,
            {
              credentialsProvider: this.credentialsProvider,
              spec,
              parameters: { url: this.url },
            },
          ),
          chunkToMultiscaleTransform,
        },
      ],
    ];
  }
}

function getNiftiVolumeInfo(
  chunkManager: ChunkManager,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  abortSignal?: AbortSignal,
) {
  return chunkManager.rpc!.promiseInvoke<NiftiVolumeInfo>(
    GET_NIFTI_VOLUME_INFO_RPC_ID,
    {
      chunkManager: chunkManager.addCounterpartRef(),
      credentialsProvider:
        getCredentialsProviderCounterpart<SpecialProtocolCredentials>(
          chunkManager,
          credentialsProvider,
        ),
      url: url,
    },
    abortSignal,
  );
}

function getDataSource(
  chunkManager: ChunkManager,
  credentialsManager: CredentialsManager,
  url: string,
) {
  return chunkManager.memoize.getUncounted(
    { type: "nifti/getVolume", url },
    async () => {
      const { url: parsedUrl, credentialsProvider } = parseSpecialUrl(
        url,
        credentialsManager,
      );
      const info = await getNiftiVolumeInfo(
        chunkManager,
        credentialsProvider,
        parsedUrl,
      );
      const volume = new NiftiMultiscaleVolumeChunkSource(
        chunkManager,
        credentialsProvider,
        parsedUrl,
        info,
      );
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
            id: "default",
            default: true,
            subsource: { volume },
          },
          {
            id: "bounds",
            default: true,
            subsource: {
              staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(box),
            },
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
    },
  );
}

export class NiftiDataSource extends DataSourceProvider {
  get description() {
    return "Single NIfTI file";
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(
      options.chunkManager,
      options.credentialsManager,
      options.providerUrl,
    );
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
      options.credentialsManager,
      options.providerUrl,
      options.abortSignal,
    );
  }
}
