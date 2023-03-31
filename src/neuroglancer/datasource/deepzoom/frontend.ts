/**
 * @license
 * Copyright 2016 Google Inc., 2023 Gergely Csucs
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
import {BoundingBox, CoordinateSpace, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {CompleteUrlOptions, ConvertLegacyUrlOptions, DataSource, DataSourceProvider, DataSubsourceEntry, GetDataSourceOptions, NormalizeUrlOptions} from 'neuroglancer/datasource';
import {ImageTileEncoding, ImageTileSourceParameters} from 'neuroglancer/datasource/deepzoom/base';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
// import {responseJson} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, parseQueryStringParameters, unparseQueryStringParameters, verifyEnumString, verifyFinitePositiveFloat, verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import { responseText } from '../dvid/api';

/*export*/ class DeepzoomImageTileSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), ImageTileSourceParameters)) {}

/*export*/ function resolvePath(a: string, b: string) {
  const outputParts = a.split('/');
  for (const part of b.split('/')) {
    if (part === '..') {
      if (outputParts.length !== 0) {
        outputParts.length = outputParts.length - 1;
        continue;
      }
    }
    outputParts.push(part);
  }
  return outputParts.join('/');
}

class ScaleInfo {
  key: string;
  encoding: ImageTileEncoding;
  resolution: Float64Array;
  voxelOffset: Float32Array;
  size: Float32Array;
  chunkSizes: Uint32Array[];
  constructor(obj: any, numChannels: number) {
    verifyObject(obj);
    const rank = (numChannels === 1) ? 3 : 4;
    const resolution = this.resolution = new Float64Array(rank);
    const voxelOffset = this.voxelOffset = new Float32Array(rank);
    const size = this.size = new Float32Array(rank);
    if (rank === 4) {
      resolution[3] = 1;
      size[3] = numChannels;
    }
    verifyObjectProperty(
        obj, 'resolution',
        x => parseFixedLengthArray(resolution.subarray(0, 3), x, verifyFinitePositiveFloat));
    verifyOptionalObjectProperty(
        obj, 'voxel_offset', x => parseFixedLengthArray(voxelOffset.subarray(0, 3), x, verifyInt));
    verifyObjectProperty(
        obj, 'size', x => parseFixedLengthArray(size.subarray(0, 3), x, verifyPositiveInt));
    this.chunkSizes = verifyObjectProperty(
        obj, 'chunk_sizes', x => parseArray(x, y => {
                              const chunkSize = new Uint32Array(rank);
                              if (rank === 4) chunkSize[3] = numChannels;
                              parseFixedLengthArray(chunkSize.subarray(0, 3), y, verifyPositiveInt);
                              return chunkSize;
                            }));
    if (this.chunkSizes.length === 0) {
      throw new Error('No chunk sizes specified.');
    }
    this.encoding =
        verifyObjectProperty(obj, 'encoding', x => verifyEnumString(x, ImageTileEncoding));
    this.key = verifyObjectProperty(obj, 'key', verifyString);
  }
}

/*export*/ interface PyramidalImageInfo {
  dataType: DataType;
  volumeType: VolumeType;
  scales: ScaleInfo[];
  modelSpace: CoordinateSpace;
  overlap: number;
  tilesize: number;
}

/*export*/ function buildPyramidalImageInfo(metadata: DZIMetaData): PyramidalImageInfo {
  // verifyObject(obj);
  const {width, height, tilesize, overlap, format} = metadata;
  // const dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
  const dataType = DataType.UINT8;
  // const numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
  const numChannels = 3;
  // const volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
  const volumeType = VolumeType.IMAGE;
  // const scaleInfos =
  //     verifyObjectProperty(obj, 'scales', x => parseArray(x, y => new ScaleInfo(y, numChannels)));
  const scaleInfos = new Array<ScaleInfo>();
  let w = width, h = height;
  let maxlevel = Math.ceil(Math.log2(Math.max(w,h)));
  do {
    const lvl = scaleInfos.length;
    const res = 1 << lvl;
    scaleInfos.push(new ScaleInfo({
      key: (maxlevel - lvl).toString(),
      size: [w,h,1],
      resolution: [res,res,res],
      chunk_sizes: [[tilesize,tilesize,1]],
      encoding: format
    },numChannels));
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
  } while(w > 1 || h > 1);

  if (scaleInfos.length === 0) throw new Error('Expected at least one scale');
  const baseScale = scaleInfos[0];
  const rank = 4; // (numChannels === 1) ? 3 : 4;
  const scales = new Float64Array(rank);
  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const names = ['x', 'y', 'z'];
  const units = ['m', 'm', 'm'];

  for (let i = 0; i < 3; ++i) {
    scales[i] = baseScale.resolution[i] / 1e9;
    lowerBounds[i] = baseScale.voxelOffset[i];
    upperBounds[i] = lowerBounds[i] + baseScale.size[i];
  }
  if (rank === 4) {
    scales[3] = 1;
    upperBounds[3] = numChannels;
    names[3] = 'c^';
    units[3] = '';
  }
  const box: BoundingBox = {lowerBounds, upperBounds};
  const modelSpace = makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });
  return {
    dataType,
    volumeType,
    scales: scaleInfos,
    modelSpace,
    overlap,
    tilesize
  };
}

/*export*/ class DeepzoomPyramidalImageTileSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return this.info.dataType;
  }

  get volumeType() {
    return this.info.volumeType;
  }

  get rank() {
    return this.info.modelSpace.rank;
  }

  url: string;

  constructor(
      chunkManager: ChunkManager, public credentialsProvider: SpecialProtocolCredentialsProvider,
      /*public*/ url: string, public info: PyramidalImageInfo) {
    super(chunkManager);
    this.url = url.substring(0, url.lastIndexOf(".")) + "_files";
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const modelResolution = this.info.scales[0].resolution;
    const {rank} = this;
    return transposeNestedArrays(this.info.scales.map(scaleInfo => {
      const {resolution} = scaleInfo;
      const stride = rank + 1;
      const chunkToMultiscaleTransform = new Float32Array(stride * stride);
      chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
      const {lowerBounds: baseLowerBound, upperBounds: baseUpperBound} =
          this.info.modelSpace.boundingBoxes[0].box;
      const lowerClipBound = new Float32Array(rank);
      const upperClipBound = new Float32Array(rank);
      for (let i = 0; i < 3; ++i) {
        const relativeScale = resolution[i] / modelResolution[i];
        chunkToMultiscaleTransform[stride * i + i] = relativeScale;
        const voxelOffsetValue = scaleInfo.voxelOffset[i];
        chunkToMultiscaleTransform[stride * rank + i] = voxelOffsetValue * relativeScale;
        lowerClipBound[i] = baseLowerBound[i] / relativeScale - voxelOffsetValue;
        upperClipBound[i] = baseUpperBound[i] / relativeScale - voxelOffsetValue;
      }
      if (rank === 4) {
        chunkToMultiscaleTransform[stride * 3 + 3] = 1;
        lowerClipBound[3] = baseLowerBound[3];
        upperClipBound[3] = baseUpperBound[3];
      }
      return makeDefaultVolumeChunkSpecifications({
               rank,
               dataType: this.dataType,
               chunkToMultiscaleTransform,
               upperVoxelBound: scaleInfo.size,
               volumeType: this.volumeType,
               chunkDataSizes: scaleInfo.chunkSizes,
               baseVoxelOffset: scaleInfo.voxelOffset,
               volumeSourceOptions,
             })
          .map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                 chunkSource: this.chunkManager.getChunkSource(DeepzoomImageTileSource, {
                   credentialsProvider: this.credentialsProvider,
                   spec,
                   parameters: {
                     url: resolvePath(this.url, scaleInfo.key),
                     encoding: scaleInfo.encoding,
                     overlap: this.info.overlap,
                     tilesize: this.info.tilesize
                   }
                 }),
                 chunkToMultiscaleTransform,
                 lowerClipBound,
                 upperClipBound,
               }));
    }));
  }
}

interface DZIMetaData {
  width: number;
  height: number;
  tilesize: number;
  overlap: number;
  format: string; // ImageTileEncoding;
}

function getDZIMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<DZIMetaData> {
    if (url.endsWith(".json") || url.includes(".json?"))
      throw new Error("DZI-JSON: OpenSeadragon hack not supported yet.");
      return chunkManager.memoize.getUncounted(
        {'type': 'deepzoom:metadata', url, credentialsProvider: getObjectId(credentialsProvider)},
        async () => {
          return await cancellableFetchSpecialOk(
              credentialsProvider, url, {}, responseText)
              .then(text => {
                const xml = new DOMParser().parseFromString(text, "text/xml");
                const image = xml.documentElement;
                const size = verifyObject(image.getElementsByTagName("Size").item(0));
                return {
                  width: verifyPositiveInt(size.getAttribute("Width")),
                  height: verifyPositiveInt(size.getAttribute("Height")),
                  tilesize: verifyPositiveInt(verifyString(image.getAttribute("TileSize"))),
                  overlap: verifyInt(verifyString(image.getAttribute("Overlap"))),
                  format: verifyString(image.getAttribute("Format")) // verifyEnumString(image.getAttribute("Format"), ImageTileEncoding)
                };
              });
        });
  }

async function getImageDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, metadata: DZIMetaData): Promise<DataSource> {
  const info = buildPyramidalImageInfo(metadata);
  const volume = new DeepzoomPyramidalImageTileSource(
      options.chunkManager, credentialsProvider, url, info);
  const {modelSpace} = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: 'default',
      default: true,
      subsource: {volume},
    },
    {
      id: 'bounds',
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(modelSpace.bounds),
      },
    },
  ];
  return {modelTransform: makeIdentityTransform(modelSpace), subsources};
}

const urlPattern = /^([^#]*)(?:#(.*))?$/;

/*export*/ function parseProviderUrl(providerUrl: string) {
  let [, url, fragment] = providerUrl.match(urlPattern)!;
  if (url.endsWith('/')) {
    url = url.substring(0, url.length - 1);
  }
  const parameters = parseQueryStringParameters(fragment || '');
  return {url, parameters};
}

function unparseProviderUrl(url: string, parameters: any) {
  const fragment = unparseQueryStringParameters(parameters);
  if (fragment) {
    url += `#${fragment}`;
  }
  return url;
}

export class DeepzoomDataSource extends DataSourceProvider {
  get description() {
    return 'Deep Zoom file-backed data source';
  }

  normalizeUrl(options: NormalizeUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const {url: providerUrl, parameters} = parseProviderUrl(options.providerUrl);
    return options.chunkManager.memoize.getUncounted(
        {'type': 'deepzoom:get', providerUrl, parameters}, async(): Promise<DataSource> => {
          const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);
          const metadata = await getDZIMetadata(options.chunkManager, credentialsProvider, url);
          return await getImageDataSource(options, credentialsProvider, url, metadata);
        });
  }
  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}
