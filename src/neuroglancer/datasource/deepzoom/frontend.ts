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
import {responseText} from 'neuroglancer/datasource/dvid/api';
import {parseProviderUrl, resolvePath, unparseProviderUrl} from 'neuroglancer/datasource/precomputed/frontend';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';
import {verifyEnumString, verifyInt, verifyObject, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

/*export*/ class DeepzoomImageTileSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(VolumeChunkSource), ImageTileSourceParameters)) {}

interface LevelInfo {
  width: number;
  height: number;
}

/*export*/ interface PyramidalImageInfo {
  levels: LevelInfo[];
  modelSpace: CoordinateSpace;
  overlap: number;
  tilesize: number;
  format: string;
  encoding: ImageTileEncoding;
}

/*export*/ function buildPyramidalImageInfo(metadata: DZIMetaData): PyramidalImageInfo {
  const {width, height, tilesize, overlap, format} = metadata;
  const encoding = verifyEnumString(format, ImageTileEncoding);
  const levelInfos = new Array<LevelInfo>();
  let w = width, h = height;
  while (w > 1 || h > 1) {
    levelInfos.push({width: w, height: h});
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
  }
  levelInfos.push({width: w, height: h});

  const rank = 3;
  const scales = Float64Array.of(1 / 1e9, 1 / 1e9, 1);
  const lowerBounds = new Float64Array(rank);
  const upperBounds = Float64Array.of(width, height, 3);
  const names = ['x', 'y', 'c^'];
  const units = ['m', 'm', ''];

  const box: BoundingBox = {lowerBounds, upperBounds};
  const modelSpace = makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
  });
  return {levels: levelInfos, modelSpace, overlap, tilesize, format, encoding};
}

/*export*/ class DeepzoomPyramidalImageTileSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return DataType.UINT8;
  }

  get volumeType() {
    return VolumeType.IMAGE;
  }

  get rank() {
    return this.info.modelSpace.rank;
  }

  url: string;

  constructor(
      chunkManager: ChunkManager, public credentialsProvider: SpecialProtocolCredentialsProvider,
      /*public*/ url: string, public info: PyramidalImageInfo) {
    super(chunkManager);
    this.url = url.substring(0, url.lastIndexOf('.')) + '_files';
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const {rank} = this;
    const chunkDataSizes = [Uint32Array.of(this.info.tilesize, this.info.tilesize, 3)];
    return transposeNestedArrays(this.info.levels.map((levelInfo, index, array) => {
      const relativeScale = 1 << index;
      const stride = rank + 1;
      const chunkToMultiscaleTransform = new Float32Array(stride * stride);
      chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
      const {upperBounds: baseUpperBound} =
          this.info.modelSpace.boundingBoxes[0].box;
      const upperClipBound = new Float32Array(rank);
      for (let i = 0; i < 2; ++i) {
        chunkToMultiscaleTransform[stride * i + i] = relativeScale;
        upperClipBound[i] = baseUpperBound[i] / relativeScale;
      }
      chunkToMultiscaleTransform[stride * 2 + 2] = 1;
      upperClipBound[2] = baseUpperBound[2];
      return makeDefaultVolumeChunkSpecifications({
               rank,
               dataType: this.dataType,
               chunkToMultiscaleTransform,
               upperVoxelBound: Float32Array.of(levelInfo.width, levelInfo.height, 3),
               volumeType: this.volumeType,
               chunkDataSizes,
               volumeSourceOptions,
             })
          .map((spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
                 chunkSource: this.chunkManager.getChunkSource(DeepzoomImageTileSource, {
                   credentialsProvider: this.credentialsProvider,
                   spec,
                   parameters: {
                     url: resolvePath(this.url, (array.length - 1 - index).toString()),
                     encoding: this.info.encoding,
                     format: this.info.format,
                     overlap: this.info.overlap,
                     tilesize: this.info.tilesize
                   }
                 }),
                 chunkToMultiscaleTransform,
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
  format: string;
}

function getDZIMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<DZIMetaData> {
  if (url.endsWith('.json') || url.includes('.json?')) {
    /* http://openseadragon.github.io/examples/tilesource-dzi/
     * JSON variant is a bit of a hack, it's not known how much it is in use for real.
     * The actual reason for not implementing it right now is the lack of CORS-enabled
     * test data.
     */
    throw new Error('DZI-JSON: OpenSeadragon hack not supported yet.');
  }
  return chunkManager.memoize.getUncounted(
      {'type': 'deepzoom:metadata', url, credentialsProvider: getObjectId(credentialsProvider)},
      async () => {
        const text = await cancellableFetchSpecialOk(credentialsProvider, url, {}, responseText);
        const xml = new DOMParser().parseFromString(text, 'text/xml');
        const image = xml.documentElement;
        const size = verifyObject(image.getElementsByTagName('Size').item(0));
        return {
          width: verifyPositiveInt(size.getAttribute('Width')),
          height: verifyPositiveInt(size.getAttribute('Height')),
          tilesize: verifyPositiveInt(verifyString(image.getAttribute('TileSize'))),
          overlap: verifyInt(verifyString(image.getAttribute('Overlap'))),
          format: verifyString(image.getAttribute('Format'))
        };
      });
}

async function getImageDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, metadata: DZIMetaData): Promise<DataSource> {
  const info = buildPyramidalImageInfo(metadata);
  const volume =
      new DeepzoomPyramidalImageTileSource(options.chunkManager, credentialsProvider, url, info);
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
          return getImageDataSource(options, credentialsProvider, url, metadata);
        });
  }
  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}
