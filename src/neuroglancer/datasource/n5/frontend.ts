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

import {AnnotationSource, makeDataBoundsBoundingBox} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {DataSource} from 'neuroglancer/datasource';
import {VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/n5/base';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {fetchOk, HttpError, parseSpecialUrl} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, verifyEnumString, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty, verifyPositiveInt} from 'neuroglancer/util/json';

class N5VolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType: VolumeType;

  get numChannels() {
    return 1;
  }

  getMeshSource() {
    return null;
  }

  baseScaleIndex: number;

  constructor(
      public chunkManager: ChunkManager, public url: string,
      public topLevelMetadata: TopLevelMetadata, public scales: (ScaleMetadata|undefined)[]) {
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
    this.dataType = dataType;
    this.volumeType = VolumeType.IMAGE;
    this.baseScaleIndex = baseScaleIndex!;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const {topLevelMetadata} = this;
    const sources: VolumeChunkSource[][] = [];
    this.scales.forEach((scale, i) => {
      if (scale === undefined) return;
      sources.push(
          VolumeChunkSpecification
              .getDefaults({
                voxelSize: vec3.multiply(
                    vec3.create(), topLevelMetadata.pixelResolution, topLevelMetadata.scales[i]),
                dataType: scale.dataType,
                numChannels: 1,
                upperVoxelBound: scale.size,
                volumeType: this.volumeType,
                chunkDataSizes: [scale.chunkSize],
                volumeSourceOptions,
              })
              .map(spec => this.chunkManager.getChunkSource(N5VolumeChunkSource, {
                spec,
                parameters: {'url': `${this.url}/s${i}`, 'encoding': scale.encoding}
              })));
    });
    return sources;
  }

  getStaticAnnotations() {
    const {topLevelMetadata, baseScaleIndex} = this;
    const annotationSet = new AnnotationSource(mat4.fromScaling(
        mat4.create(),
        vec3.multiply(
            vec3.create(), topLevelMetadata.pixelResolution,
            topLevelMetadata.scales[baseScaleIndex])));
    annotationSet.readonly = true;
    annotationSet.add(makeDataBoundsBoundingBox(vec3.create(), this.scales[baseScaleIndex]!.size));
    return annotationSet;
  }
}

const pixelResolutionUnits = new Map<string, number>([
  ['mm', 1e6],
  ['m', 1e9],
  ['um', 1000],
  ['nm', 1],
]);

class TopLevelMetadata {
  pixelResolution: vec3;
  scales: vec3[];
  constructor(obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, 'pixelResolution', resObj => {
      verifyObject(resObj);
      const unitScale = verifyObjectProperty(resObj, 'unit', x => {
        const s = pixelResolutionUnits.get(x);
        if (s === undefined) {
          throw new Error(`Unsupported unit: ${JSON.stringify(x)}.`);
        }
        return s;
      });
      const dimensions = verifyObjectProperty(
          resObj, 'dimensions',
          x => parseFixedLengthArray(vec3.create(), x, verifyFinitePositiveFloat));
      this.pixelResolution = vec3.scale(dimensions, dimensions, unitScale);
    });
    this.scales = verifyObjectProperty(
        obj, 'scales',
        scalesObj => parseArray(
            scalesObj,
            scaleObj => parseFixedLengthArray(vec3.create(), scaleObj, verifyFinitePositiveFloat)));
  }
}

class ScaleMetadata {
  dataType: DataType;
  encoding: VolumeChunkEncoding;
  size: vec3;
  chunkSize: vec3;

  constructor(obj: any) {
    verifyObject(obj);
    this.dataType = verifyObjectProperty(obj, 'dataType', x => verifyEnumString(x, DataType));
    this.size = verifyObjectProperty(
        obj, 'dimensions', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
    this.chunkSize = verifyObjectProperty(
      obj, 'blockSize', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));

    let encoding: VolumeChunkEncoding|undefined;
    verifyObjectProperty(obj, 'compression', compression => {
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

function getTopLevelMetadata(chunkManager: ChunkManager, url: string): Promise<TopLevelMetadata> {
  return chunkManager.memoize.getUncounted(
      {'type': 'n5:topLevelMetadata', url},
      () => fetchOk(url)
                .then(response => response.json())
                .then(response => new TopLevelMetadata(response)));
}

function getScaleMetadata(chunkManager: ChunkManager, url: string): Promise<ScaleMetadata> {
  return chunkManager.memoize.getUncounted(
      {'type': 'n5:scaleMetadata', url},
      () => fetchOk(url)
                .then(response => response.json())
                .then(response => new ScaleMetadata(response)));
}

function getAllScales(chunkManager: ChunkManager, url: string, topLevelMetadata: TopLevelMetadata):
    Promise<(ScaleMetadata | undefined)[]> {
  return Promise.all(topLevelMetadata.scales.map((_scale, i) => {
    return getScaleMetadata(chunkManager, `${url}/s${i}/attributes.json`).catch(e => {
      if (e instanceof HttpError && e.status === 404) {
        return undefined;
      }
      throw e;
    });
  }));
}

export class N5DataSource extends DataSource {
  get description() {
    return 'N5 data source';
  }
  getVolume(chunkManager: ChunkManager, url: string) {
    url = parseSpecialUrl(url);
    const m = url.match(/^(.*)\/(c[0-9]+)$/);
    let topLevelMetadataUrl: string;
    if (m !== null) {
      topLevelMetadataUrl = `${m[1]}/attributes.json`;
    } else {
      topLevelMetadataUrl = `${url}/attributes.json`;
    }
    return chunkManager.memoize.getUncounted(
        {'type': 'n5:MultiscaleVolumeChunkSource', url},
        () =>
            getTopLevelMetadata(chunkManager, topLevelMetadataUrl)
                .then(
                    topLevelMetadata => getAllScales(chunkManager, url, topLevelMetadata)
                                            .then(
                                                scales => new MultiscaleVolumeChunkSource(
                                                    chunkManager, url, topLevelMetadata, scales))));
  }
}
