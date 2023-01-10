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

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateSpace, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {VolumeChunkSourceParameters, ZarrCompressor, ZarrEncoding, ZarrSeparator} from 'neuroglancer/datasource/zarr/base';
import {OmeMultiscaleMetadata, parseOmeMetadata} from 'neuroglancer/datasource/zarr/ome';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {applyCompletionOffset, completeQueryStringParametersFromTable} from 'neuroglancer/util/completion';
import {Borrowed} from 'neuroglancer/util/disposable';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {isNotFoundError, responseJson} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseQueryStringParameters, verifyFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {createIdentity} from 'neuroglancer/util/matrix';
import {parseNumpyDtype} from 'neuroglancer/util/numpy_dtype';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import {Uint64} from 'neuroglancer/util/uint64';

class ZarrVolumeChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

interface ZarrMetadata {
  encoding: ZarrEncoding;
  order: 'C'|'F';
  dataType: DataType;
  rank: number;
  shape: number[];
  chunks: number[];
  dimensionSeparator: ZarrSeparator|undefined;
  fillValue: number|Uint64|undefined;
}

function parseDimensionSeparator(obj: unknown): ZarrSeparator|undefined {
  return verifyOptionalObjectProperty(obj, 'dimension_separator', value => {
    if (value !== '.' && value !== '/') {
      throw new Error(`Expected "." or "/", but received: ${JSON.stringify(value)}`);
    }
    return value;
  });
}

function parseZarrMetadata(obj: unknown): ZarrMetadata {
  try {
    verifyObject(obj);
    verifyObjectProperty(obj, 'zarr_format', zarrFormat => {
      if (zarrFormat !== 2) {
        throw new Error(`Expected 2 but received: ${JSON.stringify(zarrFormat)}`);
      }
    });
    const shape = verifyObjectProperty(
        obj, 'shape',
        shape => parseArray(shape, x => {
          if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) {
            throw new Error(`Expected non-negative integer, but received: ${JSON.stringify(x)}`);
          }
          return x;
        }));
    const chunks = verifyObjectProperty(
        obj, 'chunks',
        chunks => parseFixedLengthArray(new Array<number>(shape.length), chunks, x => {
          if (typeof x !== 'number' || !Number.isInteger(x) || x <= 0) {
            throw new Error(`Expected positive integer, but received: ${JSON.stringify(x)}`);
          }
          return x;
        }));
    const order = verifyObjectProperty(obj, 'order', order => {
      if (order !== 'C' && order !== 'F') {
        throw new Error(`Expected "C" or "F", but received: ${JSON.stringify(order)}`);
      }
      return order;
    });
    const dimensionSeparator = parseDimensionSeparator(obj);
    const numpyDtype =
        verifyObjectProperty(obj, 'dtype', dtype => parseNumpyDtype(verifyString(dtype)));
    const compressor = verifyObjectProperty(obj, 'compressor', compressor => {
      if (compressor === null) return ZarrCompressor.RAW;
      verifyObject(compressor);
      const id = verifyObjectProperty(compressor, 'id', verifyString);
      switch (id) {
        case 'blosc':
          return ZarrCompressor.BLOSC;
        case 'gzip':
          return ZarrCompressor.GZIP;
        case 'zlib':
          return ZarrCompressor.GZIP;
        default:
          throw new Error(`Unsupported compressor: ${JSON.stringify(id)}`);
      }
    });
    const dataType = numpyDtype.dataType;
    const fillValue = verifyObjectProperty(obj, 'fill_value', fillValue => {
      if (fillValue === null) return undefined;
      switch (dataType) {
        case DataType.FLOAT32:
          if (fillValue === 'NaN') {
            return Number.NaN;
          }
          if (fillValue === 'Infinity') {
            return Number.POSITIVE_INFINITY;
          }
          if (fillValue === '-Infinity') {
            return Number.NEGATIVE_INFINITY;
          }
          return verifyFloat(fillValue);
        default:
          return verifyInt(fillValue);
      }
    });
    return {
      rank: shape.length,
      shape,
      chunks,
      order,
      dataType,
      encoding: {compressor, endianness: numpyDtype.endianness},
      fillValue,
      dimensionSeparator,
    };
  } catch (e) {
    throw new Error(`Error parsing zarr metadata: ${e.message}`);
  }
}

function parseArrayDimensionsAttr(rank: number, attrs: unknown): string[] {
  let names = verifyOptionalObjectProperty(
      attrs, '_ARRAY_DIMENSIONS',
      names => parseFixedLengthArray(new Array<string>(rank), names, verifyString));
  names = new Array(rank);
  for (let i = 0; i < rank; ++i) {
    names[i] = `d${i}`;
  }
  return names;
}

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
      const {rank, chunks, shape} = metadata;
      let permutedChunkShape: Uint32Array;
      let permutedDataShape: Float32Array;
      let orderTransform: Float32Array;
      if (metadata.order === 'F') {
        permutedChunkShape = Uint32Array.from(chunks);
        permutedDataShape = Float32Array.from(shape);
        orderTransform = createIdentity(Float32Array, rank + 1);
      } else {
        permutedChunkShape = new Uint32Array(rank);
        permutedDataShape = new Float32Array(rank);
        orderTransform = new Float32Array((rank + 1) ** 2);
        orderTransform[(rank + 1) ** 2 - 1] = 1;
        for (let i = 0; i < rank; ++i) {
          permutedChunkShape[i] = chunks[rank - 1 - i];
          permutedDataShape[i] = shape[rank - 1 - i];
          orderTransform[i + (rank - 1 - i) * (rank + 1)] = 1;
        }
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
                     encoding: metadata.encoding,
                     separator: scale.dimensionSeparator,
                     order: metadata.order,
                   }
                 }),
                 chunkToMultiscaleTransform: transform,
               }));
    }));
  }
}

function getAttributes(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<any> {
  return chunkManager.memoize.getUncounted(
      {type: 'zarr:.zattrs json', url, credentialsProvider: getObjectId(credentialsProvider)},
      async () => {
        try {
          const json = await cancellableFetchSpecialOk(
              credentialsProvider, url + '/.zattrs', {}, responseJson);
          verifyObject(json);
          return json;
        } catch (e) {
          if (isNotFoundError(e)) return {};
          throw e;
        }
      });
}


function getMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, allowNotFound = true): Promise<ZarrMetadata|undefined> {
  return chunkManager.memoize.getUncounted(
      {type: 'zarr:.zarray json', url, credentialsProvider: getObjectId(credentialsProvider)},
      async () => {
        try {
          const json = await cancellableFetchSpecialOk(
              credentialsProvider, url + '/.zarray', {}, responseJson);
          return parseZarrMetadata(json);
        } catch (e) {
          if (allowNotFound && isNotFoundError(e)) return undefined;
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
  metadata: ZarrMetadata;
  dimensionSeparator: ZarrSeparator;
}

interface ZarrMultiscaleInfo {
  coordinateSpace: CoordinateSpace;
  dataType: DataType;
  scales: ZarrScaleInfo[];
}

function getMultiscaleInfoForSingleArray(
    url: string, separator: ZarrSeparator|undefined, metadata: ZarrMetadata,
    attrs: unknown): ZarrMultiscaleInfo {
  const names = parseArrayDimensionsAttr(metadata.rank, attrs);
  const modelSpace = makeCoordinateSpace({
    names,
    scales: Float64Array.from(metadata.shape, () => 1),
    units: Array.from(metadata.shape, () => ''),
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
      dimensionSeparator: validateSeparator(url, separator, metadata.dimensionSeparator)
    }]
  };
}

function validateSeparator(
    url: string, expectedSeparator: ZarrSeparator|undefined,
    actualSeparator: ZarrSeparator|undefined): ZarrSeparator {
  if (actualSeparator !== undefined && expectedSeparator !== undefined &&
      actualSeparator !== expectedSeparator) {
    throw new Error(
        `Explicitly specified dimension separator ` +
        `${JSON.stringify(expectedSeparator)} does not match value ` +
        `in ${url}/.zarray ${JSON.stringify(actualSeparator)}`);
  }
  return actualSeparator ?? expectedSeparator ?? '.';
}

async function resolveOmeMultiscale(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    separator: ZarrSeparator|undefined,
    multiscale: OmeMultiscaleMetadata): Promise<ZarrMultiscaleInfo> {
  const scaleZarrMetadata =
      (await Promise.all(multiscale.scales.map(
          scale => getMetadata(
              chunkManager, credentialsProvider, scale.url, /*allowNotFound=*/ false)))) as
      ZarrMetadata[];
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
        dimensionSeparator:
            validateSeparator(scale.url, separator, zarrMetadata.dimensionSeparator),
      };
    }),
  };
}

export class ZarrDataSource extends DataSourceProvider {
  get description() {
    return 'Zarr data source';
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    // Pattern is infallible.
    let [, providerUrl, query] = options.providerUrl.match(/([^?]*)(?:\?(.*))?$/)!;
    const parameters = parseQueryStringParameters(query || '');
    verifyObject(parameters);
    const dimensionSeparator = parseDimensionSeparator(parameters);
    if (providerUrl.endsWith('/')) {
      providerUrl = providerUrl.substring(0, providerUrl.length - 1);
    }
    return options.chunkManager.memoize.getUncounted(
        {'type': 'zarr:MultiscaleVolumeChunkSource', providerUrl, dimensionSeparator}, async () => {
          const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);
          const [metadata, attrs] = await Promise.all([
            getMetadata(options.chunkManager, credentialsProvider, url),
            getAttributes(options.chunkManager, credentialsProvider, url)
          ]);
          let multiscaleInfo: ZarrMultiscaleInfo;
          if (metadata === undefined) {
            // May be an OME-zarr multiscale dataset.
            const multiscale = parseOmeMetadata(url, attrs);
            if (multiscale === undefined) {
              throw new Error(`Neither .zarray metadata nor OME multiscale metadata found`);
            }
            multiscaleInfo = await resolveOmeMultiscale(
                options.chunkManager, credentialsProvider, dimensionSeparator, multiscale);
          } else {
            multiscaleInfo = getMultiscaleInfoForSingleArray(url, dimensionSeparator, metadata, attrs);
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
