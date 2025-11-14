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
import { DataSourceCreationState } from "#src/datasource/index.js";
import { proxyWrite } from "#src/kvstore/proxy.js";
import { joinPath } from "#src/kvstore/url.js";
import { DataType } from "#src/util/data_type.js";

import { TrackableEnum } from "#src/util/trackable_enum.js";

export enum ZarrCompression {
  RAW = 0,
  GZIP = 1,
  BLOSC = 2,
}

export class ZarrCreationState extends DataSourceCreationState {
  compression = new TrackableEnum<ZarrCompression>(ZarrCompression, ZarrCompression.RAW);

  constructor() {
    super();
    this.add("compression", this.compression);
  }
}

const zarrUnitMapping: { [key: string]: string } = {
  nm: "nanometer",
  um: "micrometer",
  mm: "millimeter",
  cm: "centimeter",
  m: "meter",
  s: "second",
  ms: "millisecond",
  us: "microsecond",
  ns: "nanosecond",
};

const dataTypeToZarrV2Dtype: { [key in DataType]?: string } = {
  [DataType.UINT8]: "|u1",
  [DataType.UINT16]: "<u2",
  [DataType.UINT32]: "<u4",
  [DataType.UINT64]: "<u8",
  [DataType.INT8]: "|i1",
  [DataType.INT16]: "<i2",
  [DataType.INT32]: "<i4",
  [DataType.FLOAT32]: "<f4",
};

interface ZarrCreator {
  create(options: CreateDataSourceOptions): Promise<void>;
}

class ZarrV2Creator implements ZarrCreator {
  async create(options: CreateDataSourceOptions): Promise<void> {
    const { kvStoreUrl, registry, metadata } = options;
    const { sharedKvStoreContext } = registry;
    const kvStore = sharedKvStoreContext.kvStoreContext.getKvStore(kvStoreUrl);

    const zgroupContent = JSON.stringify({ zarr_format: 2 });
    const writeZgroupPromise = proxyWrite(
      sharedKvStoreContext,
      kvStore.store.getUrl(joinPath(kvStore.path, ".zgroup")),
      new TextEncoder().encode(zgroupContent).buffer as ArrayBuffer,
    );

    const commonMetadata = metadata.common as CommonCreationMetadata;
    const zarrMetadata = metadata.sourceRelated as ZarrCreationState;

    const scales = [];
    for (let i = 0; i < commonMetadata.numScales; ++i) {
      const downsampleCoeffs = commonMetadata.downsamplingFactor.map(
        (f: number) => Math.pow(f, i),
      );
      scales.push({
        shape: commonMetadata.shape.map((dim: number, j: number) =>
          Math.ceil(dim / downsampleCoeffs[j]),
        ),
        chunks: [64, 64, 64],
        dtype: dataTypeToZarrV2Dtype[commonMetadata.dataType],
        compressor: this._buildV2ZarrayCompressorMetadata(zarrMetadata),
        transform: commonMetadata.voxelSize.map(
          (v: number, j: number) => v * downsampleCoeffs[j],
        ),
      });
    }

    const zattrsContent = this._buildV2OmeZattrs(commonMetadata, scales);
    const writeZattrsPromise = proxyWrite(
      sharedKvStoreContext,
      kvStore.store.getUrl(joinPath(kvStore.path, ".zattrs")),
      new TextEncoder().encode(zattrsContent).buffer as ArrayBuffer,
    );

    const writeZarrayPromises = scales.map((scale: any, i: number) => {
      const zarrayUrl = kvStore.store.getUrl(
        joinPath(kvStore.path, `s${i}`, ".zarray"),
      );
      const zarrayContent = this._buildV2Zarray(scale);
      return proxyWrite(
        sharedKvStoreContext,
        zarrayUrl,
        new TextEncoder().encode(zarrayContent).buffer as ArrayBuffer,
      );
    });

    await Promise.all([
      writeZgroupPromise,
      writeZattrsPromise,
      ...writeZarrayPromises,
    ]);
  }

  private _buildV2OmeZattrs(
    common: CommonCreationMetadata,
    scales: any[],
  ): string {
    const fullVoxelUnit =
      zarrUnitMapping[common.voxelUnit] ?? common.voxelUnit;
    const rank = common.shape.length;
    const defaultAxes = ["x", "y", "z", "c", "t"];
    const axes = Array.from({ length: rank }, (_, i) => ({
      name: defaultAxes[i] || `dim_${i}`,
      type: "space",
      unit: fullVoxelUnit,
    }));

    const datasets = scales.map((scale, i) => ({
      path: `s${i}`,
      coordinateTransformations: [
        {
          type: "scale",
          scale: scale.transform,
        },
      ],
    }));

    const omeMetadata = {
      multiscales: [
        {
          version: "0.4",
          axes,
          datasets,
          name: common.name || "default",
          type: "unknown",
          metadata: null,
        },
      ],
    };
    return JSON.stringify(omeMetadata, null, 2);
  }

  private _buildV2ZarrayCompressorMetadata(
    zarrState: ZarrCreationState,
  ): object | null {
    switch (zarrState.compression.value) {
      case ZarrCompression.BLOSC:
        return {
          id: "blosc",
          cname: "lz4",
          clevel: 5,
          shuffle: 1,
        };
      case ZarrCompression.GZIP:
        return { id: "gzip", level: 1 };
      case ZarrCompression.RAW:
      default:
        return null;
    }
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
      order: "C",
      filters: null,
    };
    return JSON.stringify(zarrMetadata, null, 2);
  }
}

const dataTypeToZarrV3Dtype: { [key in DataType]?: string } = {
  [DataType.UINT8]: "uint8",
  [DataType.UINT16]: "uint16",
  [DataType.UINT32]: "uint32",
  [DataType.UINT64]: "uint64",
  [DataType.INT8]: "int8",
  [DataType.INT16]: "int16",
  [DataType.INT32]: "int32",
  [DataType.FLOAT32]: "float32",
};


class ZarrV3Creator implements ZarrCreator {
  async create(options: CreateDataSourceOptions): Promise<void> {
    const { kvStoreUrl, registry, metadata } = options;
    const { sharedKvStoreContext } = registry;
    const kvStore = sharedKvStoreContext.kvStoreContext.getKvStore(kvStoreUrl);

    const rootGroupContent = this._buildV3RootGroupMetadata(metadata.common);
    const writeRootPromise = proxyWrite(
      sharedKvStoreContext,
      kvStore.store.getUrl(joinPath(kvStore.path, "zarr.json")),
      new TextEncoder().encode(rootGroupContent).buffer as ArrayBuffer,
    );

    const commonMetadata = metadata.common as CommonCreationMetadata;
    const zarrMetadata = metadata.sourceRelated as ZarrCreationState;

    const scales = [];
    for (let i = 0; i < commonMetadata.numScales; ++i) {
      const downsampleCoeffs = commonMetadata.downsamplingFactor.map(
        (f: number) => Math.pow(f, i),
      );
      scales.push({
        shape: commonMetadata.shape.map((dim: number, j: number) =>
          Math.ceil(dim / downsampleCoeffs[j]),
        ),
        chunks: [64, 64, 64],
        dataType: dataTypeToZarrV3Dtype[commonMetadata.dataType],
        transform: commonMetadata.voxelSize.map(
          (v: number, j: number) => v * downsampleCoeffs[j],
        ),
      });
    }

    const writeArrayPromises = scales.map((scale: any, i: number) => {
      const arrayMetaUrl = kvStore.store.getUrl(
        joinPath(kvStore.path, `s${i}`, "zarr.json"),
      );
      const arrayMetaContent = this._buildV3ArrayMetadata(
        scale,
        zarrMetadata,
      );
      return proxyWrite(
        sharedKvStoreContext,
        arrayMetaUrl,
        new TextEncoder().encode(arrayMetaContent).buffer as ArrayBuffer,
      );
    });

    await Promise.all([writeRootPromise, ...writeArrayPromises]);
  }

  private _buildV3RootGroupMetadata(common: CommonCreationMetadata): string {
    const rank = common.shape.length;
    const defaultAxes = ["x", "y", "z", "c", "t"];
    const axes = Array.from({ length: rank }, (_, i) => ({
      name: defaultAxes[i] || `dim_${i}`,
      type: "space",
      unit:  zarrUnitMapping[common.voxelUnit],
    }));

    const datasets = Array.from({ length: common.numScales }, (_, i) => ({
      path: `s${i}`,
      coordinateTransformations: [
        {
          type: "scale",
          scale: common.downsamplingFactor.map((f, j) =>
            (common.voxelSize[j] * Math.pow(f, i)),
          ),
        },
      ],
    }));

    const omeMetadata = {
      multiscales: [
        {
          version: "0.5", // OME-NGFF version compatible with Zarr v3
          axes,
          datasets,
          name: common.name || "default",
        },
      ],
    };

    return JSON.stringify({
      zarr_format: 3,
      node_type: "group",
      attributes: omeMetadata,
    }, null, 2);
  }

  private _buildV3ArrayMetadata(
    scaleMetadata: any,
    zarrState: ZarrCreationState,
  ): string {
    const { shape, chunks, dataType } = scaleMetadata;

    const codecs: { name: string; configuration?: any }[] = [
      {
        name: "bytes",
        configuration: {
          endian: "little",
        },
      },
    ];

    switch (zarrState.compression.value) {
      case ZarrCompression.GZIP:
        codecs.push({ name: "gzip", configuration: { level: 1 } });
        break;
      case ZarrCompression.BLOSC:
        codecs.push({
          name: "blosc",
          configuration: {
            cname: "lz4",
            clevel: 5,
            shuffle: "bit",
          },
        });
        break;
    }

    const zarrV3Array = {
      zarr_format: 3,
      node_type: "array",
      shape: shape,
      data_type: dataType,
      chunk_grid: {
        name: "regular",
        configuration: {
          chunk_shape: chunks,
        },
      },
      chunk_key_encoding: {
        name: "default",
        configuration: {
          separator: "/",
        },
      },
      codecs: codecs,
      fill_value: 0,
      attributes: {},
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
