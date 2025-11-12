/**
 * @license
 * Copyright 2025 Google Inc.
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

import type {
  CreateDataSourceOptions,
  CommonCreationMetadata,
} from "#src/datasource/index.js";
import { proxyWrite } from '#src/kvstore/proxy.js';
import { joinPath } from '#src/kvstore/url.js';
import { DataType } from '#src/util/data_type.js';

const dataTypeToZarrV2Dtype: { [key in DataType]?: string } = {
  [DataType.UINT8]: '|u1',
  [DataType.UINT16]: '<u2',
  [DataType.UINT32]: '<u4',
  [DataType.UINT64]: '<u8',
  [DataType.INT8]: '|i1',
  [DataType.INT16]: '<i2',
  [DataType.INT32]: '<i4',
  [DataType.FLOAT32]: '<f4',
};


interface ZarrCreator {
  create(options: CreateDataSourceOptions): Promise<void>;
}

class ZarrV2Creator implements ZarrCreator {
  async create(options: CreateDataSourceOptions): Promise<void> {
    const { kvStoreUrl, registry, metadata } = options;
    const { sharedKvStoreContext } = registry;
    const kvStore = sharedKvStoreContext.kvStoreContext.getKvStore(kvStoreUrl);

    const commonMetadata = metadata.common as CommonCreationMetadata;
    //const zarrMetadata = metadata.sourceRelated as ZarrCreationState;

    const scales = [];
    for (let i = 0; i < commonMetadata.numScales; ++i) {
      const downsampleCoeffs = commonMetadata.downsamplingFactor.map((f: number) => Math.pow(f, i));
      scales.push({
        shape: commonMetadata.shape.map((dim: number, j: number) => Math.ceil(dim / downsampleCoeffs[j])),
        chunks: [64, 64, 64],
        dtype: dataTypeToZarrV2Dtype[commonMetadata.dataType],
        compressor: null,
        transform: commonMetadata.voxelSize.map((v: number, j: number) => v * downsampleCoeffs[j]),
      });
    }

    const zattrsContent = this._buildV2OmeZattrs(commonMetadata, scales);
    const writeZattrsPromise = proxyWrite(
      sharedKvStoreContext,
      kvStore.store.getUrl(joinPath(kvStore.path, '.zattrs')),
      new TextEncoder().encode(zattrsContent).buffer as ArrayBuffer
    );

    const writeZarrayPromises = scales.map((scale: any, i: number) => {
      const zarrayUrl = kvStore.store.getUrl(joinPath(kvStore.path, `s${i}`, '.zarray'));
      const zarrayContent = this._buildV2Zarray(scale);
      return proxyWrite(
        sharedKvStoreContext,
        zarrayUrl,
        new TextEncoder().encode(zarrayContent).buffer as ArrayBuffer
      );
    });

    await Promise.all([writeZattrsPromise, ...writeZarrayPromises]);
  }

  private _buildV2OmeZattrs(common: CommonCreationMetadata, scales: any[]): string {
    const datasets = scales.map((scale, i) => ({
      path: `s${i}`,
      coordinateTransformations: [{
        type: 'scale',
        scale: scale.transform,
      }],
    }));

    const omeMetadata = {
      multiscales: [{
        version: '0.4',
        axes: [
          { name: 'x', type: 'space', unit: common.voxelUnit },
          { name: 'y', type: 'space', unit: common.voxelUnit },
          { name: 'z', type: 'space', unit: common.voxelUnit },
        ],
        datasets,
        name: common.name || 'default',
      }],
    };
    return JSON.stringify(omeMetadata, null, 2);
  }

  private _buildV2Zarray(scaleMetadata: any): string {
    const { shape, chunks, dtype, compressor } = scaleMetadata;
    const zarrMetadata = {
      zarr_format: 2,
      shape: shape,
      chunks: chunks,
      dtype: dtype,
      compressor: compressor,
      fill_value: 0,
      order: 'C',
      filters: null,
    };
    return JSON.stringify(zarrMetadata, null, 2);
  }
}

class ZarrV3Creator implements ZarrCreator {
  async create(options: CreateDataSourceOptions): Promise<void> {
    const { kvStoreUrl, registry, metadata } = options;
    const { sharedKvStoreContext } = registry;
    const kvStore = sharedKvStoreContext.kvStoreContext.getKvStore(kvStoreUrl);

    // This logic is a placeholder and needs to be filled out with the specifics
    // of generating Zarr v3 metadata files.

    const rootGroupContent = this._buildV3RootGroupMetadata(metadata.common);
    const writeRootPromise = proxyWrite(
      sharedKvStoreContext,
      kvStore.store.getUrl(joinPath(kvStore.path, 'zarr.json')),
      new TextEncoder().encode(rootGroupContent).buffer as ArrayBuffer,
    );

    // Placeholder for scale calculation.
    const scales: any[] = [];

    const writeArrayPromises = scales.map((scale: any, i: number) => {
      const arrayMetaUrl = kvStore.store.getUrl(joinPath(kvStore.path, `s${i}`, 'zarr.json'));
      const arrayMetaContent = this._buildV3ArrayMetadata(scale);
      return proxyWrite(
        sharedKvStoreContext,
        arrayMetaUrl,
        new TextEncoder().encode(arrayMetaContent).buffer as ArrayBuffer
      );
    });

    await Promise.all([writeRootPromise, ...writeArrayPromises]);
  }

  private _buildV3RootGroupMetadata(metadata: any): string {
    // Generates the root zarr.json for an OME-NGFF group using Zarr v3 spec.
    // This is where you would construct the OME-NGFF v0.5+ multiscale metadata.
    console.log("Building V3 Root Group Metadata with:", metadata);
    const zarrV3Root = {
      "zarr_format": 3,
      "node_type": "group",
      "attributes": {
        "multiscales": [
          // OME-NGFF v0.5+ multiscale object goes here
        ]
      }
    };
    return JSON.stringify(zarrV3Root, null, 2);
  }

  private _buildV3ArrayMetadata(scaleMetadata: any): string {
    const zarrV3Array = {
      "zarr_format": 3,
      "node_type": "array",
      "shape": scaleMetadata.shape,
      "data_type": "uint32", // This needs to be mapped from DataType enum
      "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": scaleMetadata.chunks } },
      "codecs": [
        // Codec configuration (e.g., blosc, gzip) goes here
      ]
    };
    return JSON.stringify(zarrV3Array, null, 2);
  }
}

export function getZarrCreator(version: number | undefined): ZarrCreator {
  switch (version) {
    case 2:
      return new ZarrV2Creator();
    case 3:
      return new ZarrV3Creator();
    default:
      throw new Error(`Unsupported Zarr version: ${version}`);
  }
}
