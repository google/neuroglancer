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

import 'neuroglancer/datasource/zarr/codec/blosc/resolve';
import 'neuroglancer/datasource/zarr/codec/zstd/resolve';
import 'neuroglancer/datasource/zarr/codec/bytes/resolve';
import 'neuroglancer/datasource/zarr/codec/crc32c/resolve';
import 'neuroglancer/datasource/zarr/codec/gzip/resolve';
import 'neuroglancer/datasource/zarr/codec/sharding_indexed/resolve';
import 'neuroglancer/datasource/zarr/codec/transpose/resolve';

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateSpace, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {VolumeChunkSourceParameters} from 'neuroglancer/datasource/zarr/base';
import {ArrayMetadata, DimensionSeparator, Metadata, NodeType} from 'neuroglancer/datasource/zarr/metadata';
import {parseDimensionSeparator, parseDimensionUnit, parseV2Metadata, parseV3Metadata} from 'neuroglancer/datasource/zarr/metadata/parse';
import {OmeMultiscaleMetadata, parseOmeMetadata} from 'neuroglancer/datasource/zarr/ome';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {applyCompletionOffset, completeQueryStringParametersFromTable} from 'neuroglancer/util/completion';
import {Borrowed} from 'neuroglancer/util/disposable';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {isNotFoundError, responseJson} from 'neuroglancer/util/http_request';
import {parseQueryStringParameters, verifyObject, verifyOptionalObjectProperty} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

class ZarrVolumeChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

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
      chunkManager: Borrowed<ChunkManager>,
      public credentialsProvider: SpecialProtocolCredentialsProvider,
      public multiscale: ZarrMultiscaleInfo) {
    super(chunkManager);
    this.volumeType = VolumeType.IMAGE;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return transposeNestedArrays(this.multiscale.scales.map(scale => {
      const {metadata} = scale;
      const {rank, codecs, shape} = metadata;
      const readChunkShape = codecs.layoutInfo[0].readChunkShape;
      const {physicalToLogicalDimension} = metadata.codecs.layoutInfo[0];
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
      matrix.multiply<Float32Array|Float64Array>(
          transform, rank + 1, scale.transform, rank + 1, orderTransform, rank + 1, rank + 1,
          rank + 1, rank + 1);
      return makeDefaultVolumeChunkSpecifications({
               rank,
               chunkToMultiscaleTransform: transform,
               dataType: metadata.dataType,
               upperVoxelBound: permutedDataShape,
               volumeType: this.volumeType,
               chunkDataSizes: [permutedChunkShape],
               volumeSourceOptions,
               fillValue: metadata.fillValue,
             })
          .map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                 chunkSource: this.chunkManager.getChunkSource(ZarrVolumeChunkSource, {
                   credentialsProvider: this.credentialsProvider,
                   spec,
                   parameters: {
                     url: scale.url,
                     metadata,
                   }
                 }),
                 chunkToMultiscaleTransform: transform,
               }));
    }));
  }
}

function getJsonResource(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<any|undefined> {
  return chunkManager.memoize.getUncounted(
      {type: 'zarr:json', url, credentialsProvider: getObjectId(credentialsProvider)}, async () => {
        try {
          return await cancellableFetchSpecialOk(credentialsProvider, url, {}, responseJson);
        } catch (e) {
          if (isNotFoundError(e)) return undefined;
          throw e;
        }
      });
}

const supportedQueryParameters = [
  {
    key: {value: 'dimension_separator', description: 'Dimension separator in chunk keys'},
    values: [
      {value: '.', description: '(default)'},
      {value: '/', description: ''},
    ]
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

function getNormalizedDimensionNames(names: (string|null)[], zarrVersion: 2|3): string[] {
  const seenNames = new Set<string>();
  const dimPrefix = zarrVersion === 2 ? 'd' : 'dim_';
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

function getMultiscaleInfoForSingleArray(url: string, metadata: ArrayMetadata): ZarrMultiscaleInfo {
  const names = getNormalizedDimensionNames(metadata.dimensionNames, metadata.zarrVersion);
  const unitsAndScales = metadata.dimensionUnits.map(parseDimensionUnit);
  const modelSpace = makeCoordinateSpace({
    names,
    scales: Float64Array.from(Array.from(unitsAndScales, x => x.scale)),
    units: Array.from(unitsAndScales, x => x.unit),
    boundingBoxes: [makeIdentityTransformedBoundingBox({
      lowerBounds: new Float64Array(metadata.rank),
      upperBounds: Float64Array.from(metadata.shape),
    })],
  });
  const transform = matrix.createIdentity(Float64Array, metadata.rank + 1);
  return {
    coordinateSpace: modelSpace,
    dataType: metadata.dataType,
    scales: [{
      url,
      transform,
      metadata,
    }]
  };
}

async function resolveOmeMultiscale(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    multiscale: OmeMultiscaleMetadata,
    options: {explicitDimensionSeparator: DimensionSeparator|undefined, zarrVersion: 2|3}):
    Promise<ZarrMultiscaleInfo> {
  const scaleZarrMetadata = await Promise.all(multiscale.scales.map(async scale => {
    const metadata = await getMetadata(chunkManager, credentialsProvider, scale.url, {
      zarrVersion: options.zarrVersion,
      expectedNodeType: 'array',
      explicitDimensionSeparator: options.explicitDimensionSeparator
    });
    if (metadata === undefined) {
      throw new Error(`zarr v{zarrVersion} array metadata not found at ${scale.url}`);
    }
    return metadata as ArrayMetadata;
  }));
  const dataType = scaleZarrMetadata[0].dataType;
  const numScales = scaleZarrMetadata.length;
  const rank = multiscale.coordinateSpace.rank;
  for (let i = 0; i < numScales; ++i) {
    const scale = multiscale.scales[i];
    const zarrMetadata = scaleZarrMetadata[i];
    if (zarrMetadata.rank !== rank) {
      throw new Error(
          `Expected zarr array at ${JSON.stringify(scale.url)} to have rank ${rank}, ` +
          `but received: ${zarrMetadata.rank}`);
    }
    if (zarrMetadata.dataType !== dataType) {
      throw new Error(
          `Expected zarr array at ${JSON.stringify(scale.url)} to have data type ` +
          `${DataType[dataType]}, but received: ${DataType[zarrMetadata.dataType]}`);
    }
  }

  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const baseScale = multiscale.scales[0];
  const baseZarrMetadata = scaleZarrMetadata[0];
  for (let i = 0; i < rank; ++i) {
    const lower = lowerBounds[i] = baseScale.transform[(rank + 1) * rank + i];
    upperBounds[i] = lower + baseZarrMetadata.shape[i];
  }
  const boundingBox = makeIdentityTransformedBoundingBox({
    lowerBounds,
    upperBounds,
  });

  const {coordinateSpace} = multiscale;
  const resolvedCoordinateSpace = makeCoordinateSpace({
    names: coordinateSpace.names,
    units: coordinateSpace.units,
    scales: coordinateSpace.scales,
    boundingBoxes: [boundingBox]
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
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, options: {
      zarrVersion?: 2|3|undefined,
      expectedNodeType?: NodeType|undefined,
      explicitDimensionSeparator?: DimensionSeparator|undefined
    }): Promise<Metadata|undefined> {
  if (options.zarrVersion === 2) {
    const [zarray, zattrs] = await Promise.all([
      getJsonResource(chunkManager, credentialsProvider, `${url}/.zarray`),
      getJsonResource(chunkManager, credentialsProvider, `${url}/.zattrs`),
    ]);
    if (zarray === undefined) {
      if (zattrs === undefined) {
        return undefined;
      }
      if (options.expectedNodeType === 'array') {
        return undefined;
      }
      return {zarrVersion: 2, nodeType: 'group', userAttributes: verifyObject(zattrs)};
    }
    if (options.expectedNodeType === 'group') {
      return undefined;
    }
    return parseV2Metadata(zarray, zattrs ?? {}, options.explicitDimensionSeparator);
  }
  if (options.zarrVersion === 3) {
    const zarrJson = await getJsonResource(chunkManager, credentialsProvider, `${url}/zarr.json`);
    if (zarrJson === undefined) return undefined;
    if (options.explicitDimensionSeparator !== undefined) {
      throw new Error(`dimension_separator query parameter not supported for zarr v3`)
    }
    return parseV3Metadata(zarrJson, options.expectedNodeType);
  }
  const [v2Result, v3Result] = await Promise.all([
    getMetadata(chunkManager, credentialsProvider, url, {...options, zarrVersion: 2}),
    getMetadata(chunkManager, credentialsProvider, url, {...options, zarrVersion: 3}),
  ]);
  if (v2Result !== undefined && v3Result !== undefined) {
    throw new Error(`Both zarr v2 and v3 metadata found`);
  }
  return v2Result ?? v3Result;
}

export class ZarrDataSource extends DataSourceProvider {
  constructor(public zarrVersion: 2|3|undefined = undefined) {
    super();
  }
  get description() {
    const versionStr = this.zarrVersion === undefined ? '' : ` v${this.zarrVersion}`;
    return `Zarr${versionStr} data source`;
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    // Pattern is infallible.
    let [, providerUrl, query] = options.providerUrl.match(/([^?]*)(?:\?(.*))?$/)!;
    const parameters = parseQueryStringParameters(query || '');
    verifyObject(parameters);
    const dimensionSeparator =
        verifyOptionalObjectProperty(parameters, 'dimension_separator', parseDimensionSeparator);
    if (providerUrl.endsWith('/')) {
      providerUrl = providerUrl.substring(0, providerUrl.length - 1);
    }
    return options.chunkManager.memoize.getUncounted(
        {'type': 'zarr:MultiscaleVolumeChunkSource', providerUrl, dimensionSeparator}, async () => {
          const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);
          const metadata = await getMetadata(
              options.chunkManager, credentialsProvider, url,
              {zarrVersion: this.zarrVersion, explicitDimensionSeparator: dimensionSeparator});
          if (metadata === undefined) {
            throw new Error(`No zarr metadata found`);
          }
          let multiscaleInfo: ZarrMultiscaleInfo;
          if (metadata.nodeType === 'group') {
            // May be an OME-zarr multiscale dataset.
            const multiscale = parseOmeMetadata(url, metadata.userAttributes);
            if (multiscale === undefined) {
              throw new Error(`Neithre array nor OME multiscale metadata found`);
            }
            multiscaleInfo =
                await resolveOmeMultiscale(options.chunkManager, credentialsProvider, multiscale, {
                  zarrVersion: metadata.zarrVersion,
                  explicitDimensionSeparator: dimensionSeparator
                });
          } else {
            multiscaleInfo = getMultiscaleInfoForSingleArray(url, metadata);
          }
          const volume = new MultiscaleVolumeChunkSource(
            options.chunkManager, credentialsProvider, multiscaleInfo);
          return {
            modelTransform: makeIdentityTransform(volume.modelSpace),
            subsources: [
              {
                id: 'default',
                default: true,
                url: undefined,
                subsource: {volume},
              },
              {
                id: 'bounds',
                default: true,
                url: undefined,
                subsource: {
                  staticAnnotations:
                      makeDataBoundsBoundingBoxAnnotationSet(volume.modelSpace.bounds)
                },
              },
            ],
          };
        })
  }

  async completeUrl(options: CompleteUrlOptions) {
    // Pattern is infallible.
    let [, , query] = options.providerUrl.match(/([^?]*)(?:\?(.*))?$/)!;
    if (query !== undefined) {
      return applyCompletionOffset(
          options.providerUrl.length - query.length,
          await completeQueryStringParametersFromTable(query, supportedQueryParameters));
    }
    return await completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}
