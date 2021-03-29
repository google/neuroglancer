/**
 * @license
 * Copyright 2019 Google Inc.
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
 * Supports single-resolution and multi-resolution N5 datasets
 *
 * The multi-resolution support is compatible with:
 *
 * https://github.com/saalfeldlab/n5-viewer
 * https://github.com/bigdataviewer/bigdataviewer-core/blob/master/BDV%20N5%20format.md
 */

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateArray, CoordinateSpace, makeCoordinateSpace, makeIdentityTransform} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/n5/base';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {DataType, makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {Borrowed} from 'neuroglancer/util/disposable';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {isNotFoundError, parseUrl, responseJson} from 'neuroglancer/util/http_request';
import {expectArray, parseArray, parseFixedLengthArray, verifyEnumString, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyPositiveInt, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {createHomogeneousScaleMatrix} from 'neuroglancer/util/matrix';
import {getObjectId} from 'neuroglancer/util/object_id';
import {scaleByExp10, unitFromJson} from 'neuroglancer/util/si_units';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

class N5VolumeChunkSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {}

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType: VolumeType;
  baseScaleIndex: number;

  modelSpace: CoordinateSpace;

  get rank() {
    return this.modelSpace.rank;
  }

  constructor(
      chunkManager: Borrowed<ChunkManager>,
      public credentialsProvider: SpecialProtocolCredentialsProvider,
      public multiscaleMetadata: MultiscaleMetadata, public scales: (ScaleMetadata|undefined)[]) {
    super(chunkManager);
    let dataType: DataType|undefined;
    let baseScaleIndex: number|undefined;
    scales.forEach((scale, i) => {
      if (scale === undefined) return;
      if (baseScaleIndex === undefined) {
        baseScaleIndex = i;
      }
      if (dataType !== undefined && scale.dataType !== dataType) {
        throw new Error(`Scale s${i} has data type ${DataType[scale.dataType]} but expected ${
            DataType[dataType]}.`);
      }
      dataType = scale.dataType;
    });
    if (dataType === undefined) {
      throw new Error(`At least one scale must be specified.`);
    }
    const baseDownsamplingInfo = multiscaleMetadata.scales[baseScaleIndex!]!;
    const baseScale = scales[baseScaleIndex!]!;
    this.dataType = dataType;
    this.volumeType = VolumeType.IMAGE;
    this.baseScaleIndex = baseScaleIndex!;
    const baseModelSpace = multiscaleMetadata.modelSpace;
    const {rank} = baseModelSpace;
    this.modelSpace = makeCoordinateSpace({
      names: baseModelSpace.names,
      scales: baseModelSpace.scales,
      units: baseModelSpace.units,
      boundingBoxes: [
        {
          transform: createHomogeneousScaleMatrix(
              Float64Array, baseDownsamplingInfo.downsamplingFactor, /*square=*/ false),
          box: {
            lowerBounds: new Float64Array(rank),
            upperBounds: new Float64Array(baseScale.size),
          },
        },
      ],
      coordinateArrays: baseModelSpace.coordinateArrays,
    });
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const {} = this;
    const {scales, rank} = this;
    const scalesDownsamplingInfo = this.multiscaleMetadata.scales;
    return transposeNestedArrays(
        (scales.filter(scale => scale !== undefined) as ScaleMetadata[]).map((scale, i) => {
          const scaleDownsamplingInfo = scalesDownsamplingInfo[i];
          const transform =
              createHomogeneousScaleMatrix(Float32Array, scaleDownsamplingInfo.downsamplingFactor);
          return makeDefaultVolumeChunkSpecifications({
                   rank,
                   chunkToMultiscaleTransform: transform,
                   dataType: scale.dataType,
                   upperVoxelBound: scale.size,
                   volumeType: this.volumeType,
                   chunkDataSizes: [scale.chunkSize],
                   volumeSourceOptions,
                 })
              .map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                     chunkSource: this.chunkManager.getChunkSource(N5VolumeChunkSource, {
                       credentialsProvider: this.credentialsProvider,
                       spec,
                       parameters: {url: scaleDownsamplingInfo.url, encoding: scale.encoding}
                     }),
                     chunkToMultiscaleTransform: transform,
                   }));
        }));
  }
}

interface MultiscaleMetadata {
  url: string;
  attributes: any;
  modelSpace: CoordinateSpace;
  scales: {readonly url: string; readonly downsamplingFactor: Float64Array;}[];
}
;

class ScaleMetadata {
  dataType: DataType;
  encoding: VolumeChunkEncoding;
  size: Float32Array;
  chunkSize: Uint32Array;

  constructor(obj: any) {
    verifyObject(obj);
    this.dataType = verifyObjectProperty(obj, 'dataType', x => verifyEnumString(x, DataType));
    this.size = Float32Array.from(
        verifyObjectProperty(obj, 'dimensions', x => parseArray(x, verifyPositiveInt)));
    this.chunkSize = verifyObjectProperty(
        obj, 'blockSize',
        x => parseFixedLengthArray(new Uint32Array(this.size.length), x, verifyPositiveInt));

    let encoding: VolumeChunkEncoding|undefined;
    verifyOptionalObjectProperty(obj, 'compression', compression => {
      encoding =
          verifyObjectProperty(compression, 'type', x => verifyEnumString(x, VolumeChunkEncoding));
    });
    if (encoding === undefined) {
      encoding = verifyObjectProperty(
          obj, 'compressionType', x => verifyEnumString(x, VolumeChunkEncoding));
    }
    this.encoding = encoding;
  }
}

function getAllScales(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    multiscaleMetadata: MultiscaleMetadata): Promise<(ScaleMetadata | undefined)[]> {
  return Promise.all(multiscaleMetadata.scales.map(async scale => {
    const attributes = await getAttributes(chunkManager, credentialsProvider, scale.url, true);
    if (attributes === undefined) return undefined;
    return new ScaleMetadata(attributes);
  }));
}

function getAttributesJsonUrls(url: string): string[] {
  let {protocol, host, path} = parseUrl(url);
  if (path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }
  const urls: string[] = [];
  while (true) {
    urls.push(`${protocol}://${host}${path}/attributes.json`);
    const index = path.lastIndexOf('/');
    if (index === -1) break;
    path = path.substring(0, index);
  }
  return urls;
}

function getIndividualAttributesJson(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, required: boolean): Promise<any> {
  return chunkManager.memoize.getUncounted(
      {type: 'n5:attributes.json', url, credentialsProvider: getObjectId(credentialsProvider)},
      () => cancellableFetchSpecialOk(credentialsProvider, url, {}, responseJson)
                .then(j => {
                  try {
                    return verifyObject(j);
                  } catch (e) {
                    throw new Error(`Error reading attributes from ${url}: ${e.message}`);
                  }
                })
                .catch(e => {
                  if (isNotFoundError(e)) {
                    if (required) return undefined;
                    return {};
                  }
                  throw e;
                }));
}

async function getAttributes(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, required: boolean): Promise<unknown> {
  const attributesJsonUrls = getAttributesJsonUrls(url);
  const metadata = await Promise.all(attributesJsonUrls.map(
      (u, i) => getIndividualAttributesJson(
          chunkManager, credentialsProvider, u, required && i === attributesJsonUrls.length - 1)));
  if (metadata.indexOf(undefined) !== -1) return undefined;
  metadata.reverse();
  return Object.assign({}, ...metadata);
}

function verifyRank(existing: number, n: number) {
  if (existing !== -1 && n !== existing) {
    throw new Error(`Rank mismatch, received ${n} but expected ${existing}`);
  }
  return n;
}

function parseSingleResolutionDownsamplingFactors(obj: any) {
  return Float64Array.from(parseArray(obj, verifyFinitePositiveFloat));
}

function parseMultiResolutionDownsamplingFactors(obj: any) {
  const a = expectArray(obj);
  if (a.length === 0) throw new Error('Expected non-empty array');
  let rank = -1;
  const allFactors = parseArray(a, x => {
    const f = parseSingleResolutionDownsamplingFactors(x);
    rank = verifyRank(rank, f.length);
    return f;
  });
  return {all: allFactors, single: undefined, rank};
}

function parseDownsamplingFactors(obj: any) {
  const a = expectArray(obj);
  if (a.length === 0) throw new Error('Expected non-empty array');
  if (Array.isArray(a[0])) {
    return parseMultiResolutionDownsamplingFactors(a);
  }
  const f = parseSingleResolutionDownsamplingFactors(obj);
  return {all: undefined, single: f, rank: f.length};
}

const defaultAxes = ['x', 'y', 'z', 't', 'c'];

function getDefaultAxes(rank: number) {
  const axes = defaultAxes.slice(0, rank);
  while (axes.length < rank) {
    axes.push(`d${axes.length + 1}`);
  }
  return axes;
}

function getMultiscaleMetadata(url: string, attributes: any): MultiscaleMetadata {
  verifyObject(attributes);
  let rank = -1;

  let scales = verifyOptionalObjectProperty(attributes, 'resolution', x => {
    const scales = Float64Array.from(parseArray(x, verifyFinitePositiveFloat));
    rank = verifyRank(rank, scales.length);
    return scales;
  });
  let axes = verifyOptionalObjectProperty(attributes, 'axes', x => {
    const names = parseArray(x, verifyString);
    rank = verifyRank(rank, names.length);
    return names;
  });
  let units = verifyOptionalObjectProperty(attributes, 'units', x => {
    const units = parseArray(x, unitFromJson);
    rank = verifyRank(rank, units.length);
    return units;
  });
  let defaultUnit = {unit: 'm', exponent: -9};
  let singleDownsamplingFactors: Float64Array|undefined;
  let allDownsamplingFactors: Float64Array[]|undefined;
  verifyOptionalObjectProperty(attributes, 'downsamplingFactors', dObj => {
    const {single, all, rank: curRank} = parseDownsamplingFactors(dObj);
    rank = verifyRank(rank, curRank);
    if (single !== undefined) {
      singleDownsamplingFactors = single;
    }
    if (all !== undefined) {
      allDownsamplingFactors = all;
    }
  });
  // Handle n5-viewer "pixelResolution" attribute
  verifyOptionalObjectProperty(attributes, 'pixelResolution', resObj => {
    defaultUnit = verifyObjectProperty(resObj, 'unit', unitFromJson);
    verifyOptionalObjectProperty(resObj, 'dimensions', scalesObj => {
      scales = Float64Array.from(parseArray(scalesObj, verifyFinitePositiveFloat));
      rank = verifyRank(rank, scales.length);
    });
  });
  // Handle n5-viewer "scales" attribute
  verifyOptionalObjectProperty(attributes, 'scales', scalesObj => {
    const {all, rank: curRank} = parseMultiResolutionDownsamplingFactors(scalesObj);
    rank = verifyRank(rank, curRank);
    allDownsamplingFactors = all;
  });
  const dimensions = verifyOptionalObjectProperty(attributes, 'dimensions', x => {
    const dimensions = parseArray(x, verifyPositiveInt);
    rank = verifyRank(rank, dimensions.length);
    return dimensions;
  });

  if (rank === -1) {
    throw new Error('Unable to determine rank of dataset');
  }
  if (units === undefined) {
    units = new Array(rank);
    units.fill(defaultUnit);
  }
  if (scales === undefined) {
    scales = new Float64Array(rank);
    scales.fill(1);
  }
  for (let i = 0; i < rank; ++i) {
    scales[i] = scaleByExp10(scales[i], units[i].exponent);
  }
  // Handle coordinateArrays
  const coordinateArrays = new Array<CoordinateArray|undefined>(rank);
  if (axes !== undefined) {
    verifyOptionalObjectProperty(attributes, 'coordinateArrays', coordinateArraysObj => {
      verifyObject(coordinateArraysObj);
      for (let i = 0; i < rank; ++i) {
        const name = axes![i];
        if (Object.prototype.hasOwnProperty.call(coordinateArraysObj, name)) {
          const labels = verifyStringArray(coordinateArraysObj[name]);
          coordinateArrays[i] = {
            explicit: false,
            labels,
            coordinates: Array.from(labels, (_, i) => i)
          };
          units![i] = {unit: '', exponent: 0};
          scales![i] = 1;
        }
      }
    });
  }
  if (axes === undefined) {
    axes = getDefaultAxes(rank);
  }
  const modelSpace = makeCoordinateSpace({
    rank,
    valid: true,
    names: axes,
    scales,
    units: units.map(x => x.unit),
    coordinateArrays,
  });
  if (dimensions === undefined) {
    if (allDownsamplingFactors === undefined) {
      throw new Error('Not valid single-resolution or multi-resolution dataset');
    }
    return {
      modelSpace,
      url,
      attributes,
      scales: allDownsamplingFactors.map((f, i) => ({url: `${url}/s${i}`, downsamplingFactor: f})),
    };
  }
  if (singleDownsamplingFactors === undefined) {
    singleDownsamplingFactors = new Float64Array(rank);
    singleDownsamplingFactors.fill(1);
  }
  return {
    modelSpace,
    url,
    attributes,
    scales: [{url, downsamplingFactor: singleDownsamplingFactors}]
  };
}

export class N5DataSource extends DataSourceProvider {
  get description() {
    return 'N5 data source';
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    let {providerUrl} = options;
    if (providerUrl.endsWith('/')) {
      providerUrl = providerUrl.substring(0, providerUrl.length - 1);
    }
    return options.chunkManager.memoize.getUncounted(
        {'type': 'n5:MultiscaleVolumeChunkSource', providerUrl}, async () => {
          const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);
          const attributes =
              await getAttributes(options.chunkManager, credentialsProvider, url, false);
          const multiscaleMetadata = getMultiscaleMetadata(url, attributes);
          const scales =
              await getAllScales(options.chunkManager, credentialsProvider, multiscaleMetadata);
          const volume = new MultiscaleVolumeChunkSource(
              options.chunkManager, credentialsProvider, multiscaleMetadata, scales);
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

  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
  }
