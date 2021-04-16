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
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {applyCompletionOffset, completeQueryStringParametersFromTable} from 'neuroglancer/util/completion';
import {Borrowed} from 'neuroglancer/util/disposable';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {isNotFoundError, responseJson} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseQueryStringParameters, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {createIdentity} from 'neuroglancer/util/matrix';
import {parseNumpyDtype} from 'neuroglancer/util/numpy_dtype';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

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
    return {
      rank: shape.length,
      shape,
      chunks,
      order,
      dataType: numpyDtype.dataType,
      encoding: {compressor, endianness: numpyDtype.endianness},
      dimensionSeparator,
    };
  } catch (e) {
    throw new Error(`Error parsing zarr metadata: ${e.message}`);
  }
}

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType: VolumeType;
  modelSpace: CoordinateSpace;

  get rank() {
    return this.metadata.rank;
  }

  constructor(
      chunkManager: Borrowed<ChunkManager>,
      public credentialsProvider: SpecialProtocolCredentialsProvider, public url: string,
      public separator: ZarrSeparator, public metadata: ZarrMetadata, public attrs: unknown) {
    super(chunkManager);
    this.dataType = metadata.dataType;
    this.volumeType = VolumeType.IMAGE;
    let names = verifyOptionalObjectProperty(
        attrs, '_ARRAY_DIMENSIONS',
        names => parseFixedLengthArray(new Array<string>(metadata.rank), names, verifyString));
    if (names === undefined) {
      names = Array.from(metadata.shape, (_, i) => `d${i}`);
    }
    this.modelSpace = makeCoordinateSpace({
      names,
      scales: Float64Array.from(metadata.shape, () => 1),
      units: Array.from(metadata.shape, () => ''),
      boundingBoxes: [makeIdentityTransformedBoundingBox({
        lowerBounds: new Float64Array(metadata.rank),
        upperBounds: Float64Array.from(metadata.shape),
      })],
    });
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const {metadata} = this;
    const {rank, chunks, shape} = metadata;
    let permutedChunkShape: Uint32Array;
    let permutedDataShape: Float32Array;
    let transform: Float32Array;
    if (metadata.order === 'F') {
      permutedChunkShape = Uint32Array.from(chunks);
      permutedDataShape = Float32Array.from(shape);
      transform = createIdentity(Float32Array, rank + 1);
    } else {
      permutedChunkShape = new Uint32Array(rank);
      permutedDataShape = new Float32Array(rank);
      transform = new Float32Array((rank + 1) ** 2);
      transform[(rank + 1) ** 2 - 1] = 1;
      for (let i = 0; i < rank; ++i) {
        permutedChunkShape[i] = chunks[rank - 1 - i];
        permutedDataShape[i] = shape[rank - 1 - i];
        transform[i + (rank - 1 - i) * (rank + 1)] = 1;
      }
    }
    return transposeNestedArrays(
        [makeDefaultVolumeChunkSpecifications({
           rank,
           chunkToMultiscaleTransform: transform,
           dataType: metadata.dataType,
           upperVoxelBound: permutedDataShape,
           volumeType: this.volumeType,
           chunkDataSizes: [permutedChunkShape],
           volumeSourceOptions,
         }).map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                  chunkSource: this.chunkManager.getChunkSource(ZarrVolumeChunkSource, {
                    credentialsProvider: this.credentialsProvider,
                    spec,
                    parameters: {
                      url: this.url,
                      encoding: metadata.encoding,
                      separator: this.separator,
                    }
                  }),
                  chunkToMultiscaleTransform: transform,
                }))]);
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
    url: string): Promise<any> {
  return chunkManager.memoize.getUncounted(
      {type: 'zarr:.zarray json', url, credentialsProvider: getObjectId(credentialsProvider)},
      async () => {
        const json = await cancellableFetchSpecialOk(
            credentialsProvider, url + '/.zarray', {}, responseJson);
        return parseZarrMetadata(json);
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
          if (metadata.dimensionSeparator !== undefined && dimensionSeparator !== undefined &&
              metadata.dimensionSeparator !== dimensionSeparator) {
            throw new Error(
                `Explicitly specified dimension separator ` +
                `${JSON.stringify(dimensionSeparator)} does not match value ` +
                `in .zarray ${JSON.stringify(metadata.dimensionSeparator)}`);
          }
          const volume = new MultiscaleVolumeChunkSource(
              options.chunkManager, credentialsProvider, url,
              dimensionSeparator || metadata.dimensionSeparator || '.', metadata, attrs);
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
