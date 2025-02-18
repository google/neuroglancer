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
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import {
  type DataSource,
  type GetKvStoreBasedDataSourceOptions,
  type KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import type { NiftiVolumeInfo } from "#src/datasource/nifti/base.js";
import {
  GET_NIFTI_VOLUME_INFO_RPC_ID,
  VolumeSourceParameters,
} from "#src/datasource/nifti/base.js";
import type {
  AutoDetectFileOptions,
  AutoDetectFileSpec,
  AutoDetectRegistry,
} from "#src/kvstore/auto_detect.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { ensureEmptyUrlSuffix } from "#src/kvstore/url.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  makeVolumeChunkSpecificationWithDefaultCompression,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { Endianness } from "#src/util/endian.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

class NiftiVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  VolumeSourceParameters,
) {}

export class NiftiMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    public url: string,
    public info: NiftiVolumeInfo,
  ) {
    super(sharedKvStoreContext.chunkManager);
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
              sharedKvStoreContext: this.sharedKvStoreContext,
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
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
) {
  return sharedKvStoreContext.chunkManager.rpc!.promiseInvoke<NiftiVolumeInfo>(
    GET_NIFTI_VOLUME_INFO_RPC_ID,
    {
      sharedKvStoreContext: sharedKvStoreContext.rpcId,
      url: url,
    },
    { signal: options.signal, progressListener: options.progressListener },
  );
}

function getDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
) {
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    { type: "nifti/getVolume", url },
    options,
    async (progressOptions) => {
      const info = await getNiftiVolumeInfo(
        sharedKvStoreContext,
        url,
        progressOptions,
      );
      const volume = new NiftiMultiscaleVolumeChunkSource(
        sharedKvStoreContext,
        url,
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
        canonicalUrl: `${url}|nifti:`,
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

export class NiftiDataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "nifti";
  }
  get description() {
    return "NIfTI";
  }
  get singleFile() {
    return true;
  }
  get(options: GetKvStoreBasedDataSourceOptions): Promise<DataSource> {
    ensureEmptyUrlSuffix(options.url);
    return getDataSource(
      options.registry.sharedKvStoreContext,
      options.kvStoreUrl,
      options,
    );
  }
}

function getAutoDetectSpec(
  headerSize: number,
  magicStringOffset: number,
  magicString: string,
  version: string,
): AutoDetectFileSpec {
  async function match(options: AutoDetectFileOptions) {
    const { prefix } = options;
    if (prefix.length < magicStringOffset + magicString.length) return [];
    const dv = new DataView(
      prefix.buffer,
      prefix.byteOffset,
      prefix.byteLength,
    );
    let endianness: Endianness;
    if (dv.getInt32(0, /*littleEndian=*/ true) === headerSize) {
      endianness = Endianness.LITTLE;
    } else if (dv.getInt32(0, /*littleEndian=*/ false) === headerSize) {
      endianness = Endianness.BIG;
    } else {
      return [];
    }
    for (let i = 0; i < magicString.length; ++i) {
      if (magicString.charCodeAt(i) !== prefix[i + magicStringOffset])
        return [];
    }

    return [
      {
        suffix: "nifti:",
        description: `NIfTI ${version} (${Endianness[endianness].toLowerCase()}-endian)`,
      },
    ];
  }
  return {
    prefixLength: magicStringOffset + magicString.length,
    suffixLength: 0,
    match,
  };
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerFileFormat(getAutoDetectSpec(348, 344, "n+1\0", "v1"));
  registry.registerFileFormat(
    getAutoDetectSpec(540, 4, "n+2\0\r\n\x1a\n", "v2"),
  );
}
