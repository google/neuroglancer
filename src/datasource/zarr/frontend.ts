/**
 * @license
 * Copyright 2020 Google Inc.
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

import "#src/datasource/zarr/codec/blosc/resolve.js";
import "#src/datasource/zarr/codec/zstd/resolve.js";

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type {
  ChannelMetadata,
  DataSource,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import { getKvStorePathCompletions } from "#src/datasource/kvstore_completions.js";
import { VolumeChunkSourceParameters } from "#src/datasource/zarr/base.js";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/crc32c/resolve.js";
import "#src/datasource/zarr/codec/gzip/resolve.js";
import "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import "#src/datasource/zarr/codec/transpose/resolve.js";
import type {
  ArrayMetadata,
  DimensionSeparator,
  Metadata,
  NodeType,
} from "#src/datasource/zarr/metadata/index.js";
import {
  parseDimensionSeparator,
  parseDimensionUnit,
  parseV2Metadata,
  parseV3Metadata,
} from "#src/datasource/zarr/metadata/parse.js";
import type { OmeMultiscaleMetadata } from "#src/datasource/zarr/ome.js";
import { parseOmeMetadata } from "#src/datasource/zarr/ome.js";
import type { AutoDetectRegistry } from "#src/kvstore/auto_detect.js";
import { simpleFilePresenceAutoDetectDirectorySpec } from "#src/kvstore/auto_detect.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { CompletionResult } from "#src/kvstore/context.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  kvstoreEnsureDirectoryPipelineUrl,
  parseUrlSuffix,
  pipelineUrlJoin,
} from "#src/kvstore/url.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import {
  applyCompletionOffset,
  completeQueryStringParametersFromTable,
} from "#src/util/completion.js";
import {
  parseQueryStringParameters,
  verifyObject,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

class ZarrVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {}

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  volumeType: VolumeType;

  get dataType() {
    return this.multiscale.dataType;
  }

  get modelSpace() {
    return this.multiscale.coordinateSpace;
  }

  get rank() {
    return this.multiscale.coordinateSpace.rank;
  }

  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    public multiscale: ZarrMultiscaleInfo,
  ) {
    super(sharedKvStoreContext.chunkManager);
    this.volumeType = VolumeType.IMAGE;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return transposeNestedArrays(
      this.multiscale.scales.map((scale) => {
        const { metadata } = scale;
        const { rank, codecs, shape } = metadata;
        const readChunkShape = codecs.layoutInfo[0].readChunkShape;
        const { physicalToLogicalDimension } = metadata.codecs.layoutInfo[0];
        const permutedChunkShape = new Uint32Array(rank);
        const permutedDataShape = new Float32Array(rank);
        const orderTransform = new Float32Array((rank + 1) ** 2);
        orderTransform[(rank + 1) ** 2 - 1] = 1;
        for (let i = 0; i < rank; ++i) {
          const decodedDim = physicalToLogicalDimension[rank - 1 - i];
          permutedChunkShape[i] = readChunkShape[decodedDim];
          permutedDataShape[i] = shape[decodedDim];
          orderTransform[i + decodedDim * (rank + 1)] = 1;
        }
        const transform = new Float32Array((rank + 1) ** 2);
        matrix.multiply<Float32Array | Float64Array>(
          transform,
          rank + 1,
          scale.transform,
          rank + 1,
          orderTransform,
          rank + 1,
          rank + 1,
          rank + 1,
          rank + 1,
        );
        return makeDefaultVolumeChunkSpecifications({
          rank,
          chunkToMultiscaleTransform: transform,
          dataType: metadata.dataType,
          upperVoxelBound: permutedDataShape,
          volumeType: this.volumeType,
          chunkDataSizes: [permutedChunkShape],
          volumeSourceOptions,
          fillValue: metadata.fillValue,
        }).map(
          (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
            chunkSource: this.chunkManager.getChunkSource(
              ZarrVolumeChunkSource,
              {
                sharedKvStoreContext: this.sharedKvStoreContext,
                spec,
                parameters: {
                  url: scale.url,
                  metadata,
                },
              },
            ),
            chunkToMultiscaleTransform: transform,
          }),
        );
      }),
    );
  }
}

function getJsonResource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  description: string,
  options: Partial<ProgressOptions>,
): Promise<any | undefined> {
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    {
      type: "zarr:json",
      url,
    },
    options,
    async (options) => {
      using _span = new ProgressSpan(options.progressListener, {
        message: `Reading ${description} from ${url}`,
      });
      const response = await sharedKvStoreContext.kvStoreContext.read(
        url,
        options,
      );
      if (response === undefined) return undefined;
      return await response.response.json();
    },
  );
}

const supportedQueryParameters = [
  {
    key: {
      value: "dimension_separator",
      description: "Dimension separator in chunk keys",
    },
    values: [
      { value: ".", description: "(default)" },
      { value: "/", description: "" },
    ],
  },
];

interface ZarrScaleInfo {
  url: string;
  transform: Float64Array;
  metadata: ArrayMetadata;
}

interface ZarrMultiscaleInfo {
  coordinateSpace: CoordinateSpace;
  dataType: DataType;
  scales: ZarrScaleInfo[];
}

function getNormalizedDimensionNames(
  names: (string | null)[],
  zarrVersion: 2 | 3,
): string[] {
  const seenNames = new Set<string>();
  const dimPrefix = zarrVersion === 2 ? "d" : "dim_";
  return names.map((name, i) => {
    if (name === null) {
      let j = i;
      while (true) {
        name = `${dimPrefix}${j}`;
        if (!seenNames.has(name)) {
          seenNames.add(name);
          return name;
        }
        ++j;
      }
    }
    if (!seenNames.has(name)) {
      seenNames.add(name);
      return name;
    }
    let j = 1;
    while (true) {
      const newName = `${name}${j}`;
      if (!seenNames.has(newName)) {
        seenNames.add(newName);
        return newName;
      }
      ++j;
    }
  });
}

function getMultiscaleInfoForSingleArray(
  url: string,
  metadata: ArrayMetadata,
): ZarrMultiscaleInfo {
  const names = getNormalizedDimensionNames(
    metadata.dimensionNames,
    metadata.zarrVersion,
  );
  const unitsAndScales = metadata.dimensionUnits.map(parseDimensionUnit);
  const modelSpace = makeCoordinateSpace({
    names,
    scales: Float64Array.from(Array.from(unitsAndScales, (x) => x.scale)),
    units: Array.from(unitsAndScales, (x) => x.unit),
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({
        lowerBounds: new Float64Array(metadata.rank),
        upperBounds: Float64Array.from(metadata.shape),
      }),
    ],
  });
  const transform = matrix.createIdentity(Float64Array, metadata.rank + 1);
  return {
    coordinateSpace: modelSpace,
    dataType: metadata.dataType,
    scales: [
      {
        url,
        transform,
        metadata,
      },
    ],
  };
}

async function resolveOmeMultiscale(
  sharedKvStoreContext: SharedKvStoreContext,
  multiscale: OmeMultiscaleMetadata,
  options: {
    explicitDimensionSeparator: DimensionSeparator | undefined;
    zarrVersion: 2 | 3;
  } & Partial<ProgressOptions>,
): Promise<ZarrMultiscaleInfo> {
  const scaleZarrMetadata = await Promise.all(
    multiscale.scales.map(async (scale) => {
      const metadata = await getMetadata(sharedKvStoreContext, scale.url, {
        ...options,
        expectedNodeType: "array",
      });
      if (metadata === undefined) {
        throw new Error(
          `zarr v{zarrVersion} array metadata not found at ${scale.url}`,
        );
      }
      return metadata as ArrayMetadata;
    }),
  );
  const dataType = scaleZarrMetadata[0].dataType;
  const numScales = scaleZarrMetadata.length;
  const rank = multiscale.coordinateSpace.rank;
  for (let i = 0; i < numScales; ++i) {
    const scale = multiscale.scales[i];
    const zarrMetadata = scaleZarrMetadata[i];
    if (zarrMetadata.rank !== rank) {
      throw new Error(
        `Expected zarr array at ${JSON.stringify(
          scale.url,
        )} to have rank ${rank}, ` + `but received: ${zarrMetadata.rank}`,
      );
    }
    if (zarrMetadata.dataType !== dataType) {
      throw new Error(
        `Expected zarr array at ${JSON.stringify(
          scale.url,
        )} to have data type ` +
          `${DataType[dataType]}, but received: ${
            DataType[zarrMetadata.dataType]
          }`,
      );
    }
  }

  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const baseScale = multiscale.scales[0];
  const baseZarrMetadata = scaleZarrMetadata[0];
  for (let i = 0; i < rank; ++i) {
    const lower = (lowerBounds[i] = baseScale.transform[(rank + 1) * rank + i]);
    upperBounds[i] = lower + baseZarrMetadata.shape[i];
  }
  const boundingBox = makeIdentityTransformedBoundingBox({
    lowerBounds,
    upperBounds,
  });

  const { coordinateSpace } = multiscale;
  const resolvedCoordinateSpace = makeCoordinateSpace({
    names: coordinateSpace.names,
    units: coordinateSpace.units,
    scales: coordinateSpace.scales,
    boundingBoxes: [boundingBox],
  });

  return {
    coordinateSpace: resolvedCoordinateSpace,
    dataType,
    scales: multiscale.scales.map((scale, i) => {
      const zarrMetadata = scaleZarrMetadata[i];
      return {
        url: scale.url,
        transform: scale.transform,
        metadata: zarrMetadata,
      };
    }),
  };
}

async function getMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: {
    zarrVersion?: 2 | 3 | undefined;
    expectedNodeType?: NodeType | undefined;
    explicitDimensionSeparator?: DimensionSeparator | undefined;
  } & Partial<ProgressOptions>,
): Promise<Metadata | undefined> {
  if (options.zarrVersion === 2) {
    const [zarray, zattrs] = await Promise.all([
      getJsonResource(
        sharedKvStoreContext,
        `${url}.zarray`,
        "zarr v2 array metadata",
        options,
      ),
      getJsonResource(
        sharedKvStoreContext,
        `${url}.zattrs`,
        "zarr v2 attributes",
        options,
      ),
    ]);
    if (zarray === undefined) {
      if (zattrs === undefined) {
        return undefined;
      }
      if (options.expectedNodeType === "array") {
        return undefined;
      }
      return {
        zarrVersion: 2,
        nodeType: "group",
        userAttributes: verifyObject(zattrs),
      };
    }
    if (options.expectedNodeType === "group") {
      return undefined;
    }
    return parseV2Metadata(
      zarray,
      zattrs ?? {},
      options.explicitDimensionSeparator,
    );
  }
  if (options.zarrVersion === 3) {
    const zarrJson = await getJsonResource(
      sharedKvStoreContext,
      `${url}zarr.json`,
      "zarr v3 metadata",
      options,
    );
    if (zarrJson === undefined) return undefined;
    if (options.explicitDimensionSeparator !== undefined) {
      throw new Error(
        "dimension_separator query parameter not supported for zarr v3",
      );
    }
    return parseV3Metadata(zarrJson, options.expectedNodeType);
  }
  const [v2Result, v3Result] = await Promise.all([
    getMetadata(sharedKvStoreContext, url, {
      ...options,
      zarrVersion: 2,
    }),
    getMetadata(sharedKvStoreContext, url, {
      ...options,
      zarrVersion: 3,
    }),
  ]);
  if (v2Result !== undefined && v3Result !== undefined) {
    throw new Error("Both zarr v2 and v3 metadata found");
  }
  return v2Result ?? v3Result;
}

function resolveUrl(options: GetKvStoreBasedDataSourceOptions) {
  const {
    authorityAndPath: additionalPath,
    query,
    fragment,
  } = parseUrlSuffix(options.url.suffix);

  if (query) {
    throw new Error(
      `Invalid URL ${JSON.stringify(options.url.url)}: query parameters not supported`,
    );
  }
  return {
    kvStoreUrl: kvstoreEnsureDirectoryPipelineUrl(options.kvStoreUrl),
    additionalPath: additionalPath ?? "",
    fragment,
  };
}

export class ZarrDataSource implements KvStoreBasedDataSourceProvider {
  constructor(public zarrVersion: 2 | 3 | undefined = undefined) {}
  get scheme() {
    return `zarr${this.zarrVersion ?? ""}`;
  }
  get expectsDirectory() {
    return true;
  }
  get description() {
    const versionStr =
      this.zarrVersion === undefined ? "" : ` v${this.zarrVersion}`;
    return `Zarr${versionStr} data source`;
  }
  get(options: GetKvStoreBasedDataSourceOptions): Promise<DataSource> {
    let { kvStoreUrl, additionalPath, fragment } = resolveUrl(options);
    kvStoreUrl = kvstoreEnsureDirectoryPipelineUrl(
      pipelineUrlJoin(kvStoreUrl, additionalPath),
    );
    const parameters = parseQueryStringParameters(fragment || "");
    verifyObject(parameters);
    const dimensionSeparator = verifyOptionalObjectProperty(
      parameters,
      "dimension_separator",
      parseDimensionSeparator,
    );
    return options.registry.chunkManager.memoize.getAsync(
      {
        type: "zarr:MultiscaleVolumeChunkSource",
        kvStoreUrl,
        dimensionSeparator,
      },
      options,
      async (progressOptions) => {
        const { sharedKvStoreContext } = options.registry;
        const metadata = await getMetadata(sharedKvStoreContext, kvStoreUrl, {
          ...progressOptions,
          zarrVersion: this.zarrVersion,
          explicitDimensionSeparator: dimensionSeparator,
        });
        let channelMetadata: ChannelMetadata | undefined;
        if (metadata === undefined) {
          throw new Error("No zarr metadata found");
        }
        let multiscaleInfo: ZarrMultiscaleInfo;
        if (metadata.nodeType === "group") {
          // May be an OME-zarr multiscale dataset.
          const omeMetadata = parseOmeMetadata(
            kvStoreUrl,
            metadata.userAttributes,
            metadata.zarrVersion,
          );
          if (omeMetadata === undefined) {
            throw new Error("Neither array nor OME multiscale metadata found");
          }
          channelMetadata = omeMetadata.channels;
          multiscaleInfo = await resolveOmeMultiscale(
            sharedKvStoreContext,
            omeMetadata.multiscale,
            {
              ...progressOptions,
              zarrVersion: metadata.zarrVersion,
              explicitDimensionSeparator: dimensionSeparator,
            },
          );
        } else {
          multiscaleInfo = getMultiscaleInfoForSingleArray(
            kvStoreUrl,
            metadata,
          );
        }
        const volume = new MultiscaleVolumeChunkSource(
          sharedKvStoreContext,
          multiscaleInfo,
        );
        return {
          canonicalUrl: `${kvStoreUrl}|zarr${metadata.zarrVersion}:`,
          modelTransform: makeIdentityTransform(volume.modelSpace),
          channelMetadata,
          subsources: [
            {
              id: "default",
              default: true,
              url: undefined,
              subsource: { volume },
            },
            {
              id: "bounds",
              default: true,
              url: undefined,
              subsource: {
                staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(
                  volume.modelSpace.bounds,
                ),
              },
            },
          ],
        };
      },
    );
  }
  async completeUrl(
    options: GetKvStoreBasedDataSourceOptions,
  ): Promise<CompletionResult> {
    const { kvStoreUrl, additionalPath, fragment } = resolveUrl(options);
    if (fragment === undefined) {
      return getKvStorePathCompletions(options.registry.sharedKvStoreContext, {
        baseUrl: kvStoreUrl,
        path: additionalPath,
        directoryOnly: true,
        signal: options.signal,
        progressListener: options.progressListener,
      });
    }
    if (this.zarrVersion === 3) {
      throw new Error("URL fragment parameters not supported");
    }
    return applyCompletionOffset(
      options.url.url.length - fragment.length,
      await completeQueryStringParametersFromTable(
        fragment,
        supportedQueryParameters,
      ),
    );
  }
}

export function registerAutoDetectV2(registry: AutoDetectRegistry) {
  registry.registerDirectoryFormat(
    simpleFilePresenceAutoDetectDirectorySpec(new Set([".zarray", ".zattrs"]), {
      suffix: "zarr2:",
      description: "Zarr v2 data source",
    }),
  );
}

export function registerAutoDetectV3(registry: AutoDetectRegistry) {
  registry.registerDirectoryFormat(
    simpleFilePresenceAutoDetectDirectorySpec(new Set(["zarr.json"]), {
      suffix: "zarr3:",
      description: "Zarr v3 data source",
    }),
  );
}
