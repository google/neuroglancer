/**
 * @license
 * Copyright 2016 Google Inc.
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
 * @file
 * Support for Python integration.
 */

import {makeDataBoundsBoundingBoxAnnotationSet} from 'neuroglancer/annotation';
import {ChunkManager, ChunkSource, ChunkSourceConstructor, GettableChunkSource, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateSpace, coordinateSpaceFromJson, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox} from 'neuroglancer/coordinate_transform';
import {DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {MeshSourceParameters, PythonSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/python/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {ChunkLayoutPreference, DataType, DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2} from 'neuroglancer/sliceview/base';
import {SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {makeDefaultVolumeChunkSpecifications, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {transposeNestedArrays} from 'neuroglancer/util/array';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {fetchOk} from 'neuroglancer/util/http_request';
import {parseFixedLengthArray, verifyEnumString, verifyFiniteFloat, verifyInt, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyOptionalObjectProperty, verifyPositiveInt} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {getObjectId} from 'neuroglancer/util/object_id';
import * as vector from 'neuroglancer/util/vector';

interface PythonChunkSource extends ChunkSource {
  dataSource: PythonDataSource;
  generation: number;
}

function WithPythonDataSource<
    TBase extends ChunkSourceConstructor<GettableChunkSource&ChunkSource&
                                         {OPTIONS: {parameters: PythonSourceParameters}}>>(
    Base: TBase) {
  type Options = InstanceType<TBase>['OPTIONS']&{
    dataSource: Borrowed<PythonDataSource>;
    generation: number;
  };
  class C extends Base {
    OPTIONS: Options;
    dataSource: Owned<PythonDataSource>;
    generation: number;
    parameters: PythonSourceParameters;
    constructor(...args: any[]) {
      super(...args);
      const options: Options = args[1];
      const dataSource = this.dataSource = this.registerDisposer(options.dataSource.addRef());
      this.generation = options.generation;
      const key = options.parameters.key;
      dataSource.registerSource(key, this);
    }
    static encodeOptions(options: Options) {
      const encoding = super.encodeOptions(options);
      // `generation` is not encoded in cache key, since it is not fixed.
      encoding['dataSource'] = getObjectId(options.dataSource);
      return encoding;
    }
  }
  return C as (typeof C) & {encodeOptions: (options: Options) => any};
}

class PythonVolumeChunkSource extends
(WithPythonDataSource(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters))) {
}
class PythonMeshSource extends
(WithPythonDataSource(WithParameters(MeshSource, MeshSourceParameters))) {}

export function computeNearIsotropicDownsamplingLevels(
    shape: Float32Array, downsampleDims: readonly number[], effectiveVoxelSize: Float32Array,
    maxDownsampling: number, maxDownsamplingScales: number, maxDownsampledSize: number) {
  const rank = shape.length;
  const curDownsampleFactors = new Float32Array(rank);
  curDownsampleFactors.fill(1);
  const downsampleLevels: Float32Array[] = [curDownsampleFactors.slice()];
  let curDownsampleProduct = 1;
  const numDownsampleDims = downsampleDims.length;
  if (numDownsampleDims === 0) return downsampleLevels;
  while (true) {
    if (downsampleLevels.length >= maxDownsamplingScales) break;
    if (curDownsampleProduct >= maxDownsampling) break;
    if (curDownsampleFactors.every((f, i) => shape[i] / f <= maxDownsampledSize)) break;
    let curSmallestScaleDim = downsampleDims[0];
    const getEffectiveScale = (i: number) => curDownsampleFactors[i] * effectiveVoxelSize[i];
    for (let i = 1; i < numDownsampleDims; ++i) {
      const dim = downsampleDims[i];
      if (getEffectiveScale(dim) < getEffectiveScale(curSmallestScaleDim)) {
        curSmallestScaleDim = dim;
      }
    }
    curDownsampleFactors[curSmallestScaleDim] *= 2;
    curDownsampleProduct *= 2;
    const targetScale = getEffectiveScale(curSmallestScaleDim);
    for (let i = 0; i < numDownsampleDims && curDownsampleProduct < maxDownsampling; ++i) {
      const dim = downsampleDims[i];
      if (dim === curSmallestScaleDim) continue;
      const effectiveScale = getEffectiveScale(dim);
      if (Math.abs(effectiveScale - targetScale) > Math.abs(effectiveScale * 2 - targetScale)) {
        curDownsampleFactors[dim] *= 2;
        curDownsampleProduct *= 2;
      }
    }
    downsampleLevels.push(new Float32Array(curDownsampleFactors));
  }
  return downsampleLevels;
}

function parseCoordinateSpaceAndVoxelOffset(response: any) {
  verifyObject(response);
  const baseModelSpace: CoordinateSpace = {
    ...verifyObjectProperty(response, 'coordinateSpace', coordinateSpaceFromJson),
    valid: true
  };
  const {rank} = baseModelSpace;
  // Mark all coordinate arrays as implicit, since they are obtained from the data source and need
  // not be preserved in the Neuroglancer JSON state.
  baseModelSpace.coordinateArrays.forEach(coordinateArray => {
    if (coordinateArray === undefined) return;
    coordinateArray.explicit = false;
  });
  const subsourceToModelTransform =
      matrix.identity(new Float32Array((rank + 1) * (rank + 1)), rank + 1, rank + 1);

  const voxelOffset = verifyObjectProperty(
      response, 'voxelOffset',
      x => parseFixedLengthArray(new Float64Array(rank), x, verifyFiniteFloat));
  for (let i = 0; i < rank; ++i) {
    subsourceToModelTransform[(rank + 1) * rank + i] = voxelOffset[i];
  }
  return {subsourceToModelTransform, baseModelSpace, voxelOffset};
}

export class PythonMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType: VolumeType;
  encoding: VolumeChunkEncoding;
  generation: number;
  modelSpace: CoordinateSpace;
  downsamplingLayout: ChunkLayoutPreference;
  chunkLayoutPreference: ChunkLayoutPreference;
  shape: Float32Array;
  maxDownsampling: number;
  maxDownsampledSize: number;
  maxDownsamplingScales: number;
  maxVoxelsPerChunkLog2: number;
  subsourceToModelTransform: Float32Array;

  get rank() {
    return this.modelSpace.rank;
  }
  skeletonVertexAttributes: Map<string, VertexAttributeInfo>|undefined;

  // TODO(jbms): Properly handle reference counting of `dataSource`.
  constructor(
      public dataSource: Borrowed<PythonDataSource>, chunkManager: ChunkManager, public key: string,
      public response: any) {
    super(chunkManager);
    const {baseModelSpace, subsourceToModelTransform, voxelOffset} =
        parseCoordinateSpaceAndVoxelOffset(response);
    this.dataType = verifyObjectProperty(response, 'dataType', x => verifyEnumString(x, DataType));
    this.volumeType =
        verifyObjectProperty(response, 'volumeType', x => verifyEnumString(x, VolumeType));
    this.encoding =
        verifyObjectProperty(response, 'encoding', x => verifyEnumString(x, VolumeChunkEncoding));
    const rank = baseModelSpace.rank;
    this.subsourceToModelTransform = subsourceToModelTransform;
    const shape = verifyObjectProperty(
        response, 'shape',
        x => parseFixedLengthArray(new Float32Array(rank), x, verifyPositiveInt));
    this.shape = shape;

    this.maxDownsampling = verifyObjectProperty(
        response, 'maxDownsampling', x => x === null ? Number.POSITIVE_INFINITY : verifyInt(x));
    this.maxDownsampledSize = verifyObjectProperty(
        response, 'maxDownsampledSize', x => x === null ? Number.POSITIVE_INFINITY : verifyInt(x));
    this.maxDownsamplingScales = verifyObjectProperty(
        response, 'maxDownsamplingScales',
        x => x === null ? Number.POSITIVE_INFINITY : verifyInt(x));

    this.downsamplingLayout = verifyObjectProperty(
        response, 'downsamplingLayout',
        x => x === '2d' ? ChunkLayoutPreference.FLAT : ChunkLayoutPreference.ISOTROPIC);
    this.chunkLayoutPreference = verifyObjectProperty(
        response, 'chunkLayout', x => verifyEnumString(x, ChunkLayoutPreference));

    const box = {
      lowerBounds: voxelOffset,
      upperBounds: vector.add(new Float64Array(rank), voxelOffset, shape)
    };

    const modelSpace = makeCoordinateSpace({
      rank,
      names: baseModelSpace.names,
      scales: baseModelSpace.scales,
      units: baseModelSpace.units,
      boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
      coordinateArrays: baseModelSpace.coordinateArrays,
    });
    this.modelSpace = modelSpace;
    this.generation = verifyObjectProperty(response, 'generation', x => x);
    this.maxVoxelsPerChunkLog2 = verifyOptionalObjectProperty(
        response, 'maxVoxelsPerChunkLog2', verifyPositiveInt, DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const downsampleDims: number[] = [];
    const {rank, volumeType, dataType, shape, encoding} = this;
    const effectiveDisplayScales = new Float32Array(rank);
    const {multiscaleToViewTransform, modelChannelDimensionIndices} = volumeSourceOptions;
    for (let modelDim = 0; modelDim < rank; ++modelDim) {
      let factor = 0;
      for (let viewDim = 0; viewDim < 3; ++viewDim) {
        const c = multiscaleToViewTransform[modelDim * 3 + viewDim];
        factor += c * c;
      }
      if (factor !== 0) downsampleDims.push(modelDim);
      effectiveDisplayScales[modelDim] = Math.sqrt(factor);
    }
    const getSourcesFromDownsampleFactors =
        (downsampleFactors: Float32Array, chunkDims: readonly number[],
         chunkLayoutPreference: ChunkLayoutPreference):
            SliceViewSingleResolutionSource<VolumeChunkSource>[] => {
              const chunkToMultiscaleTransform = new Float32Array((rank + 1) ** 2);
              chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
              for (let i = 0; i < rank; ++i) {
                chunkToMultiscaleTransform[(rank + 2) * i] = downsampleFactors[i];
              }
              const downsampledShape = new Float32Array(rank);
              const upperClipBound = new Float32Array(rank);
              for (let i = 0; i < rank; ++i) {
                downsampledShape[i] = Math.ceil(shape[i] / downsampleFactors[i]);
                upperClipBound[i] = shape[i] / downsampleFactors[i];
              }
              const maxBlockSize = new Uint32Array(rank);
              maxBlockSize.fill(1);
              for (const chunkDim of chunkDims) {
                maxBlockSize[chunkDim] = 0xffffffff;
              }
              for (const chunkDim of modelChannelDimensionIndices) {
                maxBlockSize[chunkDim] = 0xffffffff;
              }
              return makeDefaultVolumeChunkSpecifications({
                       chunkToMultiscaleTransform,
                       rank,
                       dataType,
                       volumeType,
                       maxBlockSize,
                       upperVoxelBound: downsampledShape,
                       volumeSourceOptions,
                       chunkLayoutPreference,
                     })
                  .map(spec => {
                    return {
                      chunkSource: this.chunkManager.getChunkSource(PythonVolumeChunkSource, {
                        spec,
                        dataSource: this.dataSource,
                        generation: this.generation,
                        parameters:
                            {key: this.key, scaleKey: downsampleFactors.join(), encoding: encoding}
                      }),
                      chunkToMultiscaleTransform,
                      upperClipBound,
                    };
                  });
            };

    const get2dDownsampledSources = (downsampleDims: readonly number[]) => {
      return computeNearIsotropicDownsamplingLevels(
                 this.shape, downsampleDims, effectiveDisplayScales, this.maxDownsampling,
                 this.maxDownsamplingScales, this.maxDownsampledSize)
          .map(
              downsampleFactors => getSourcesFromDownsampleFactors(
                  downsampleFactors, downsampleDims, ChunkLayoutPreference.ISOTROPIC)[0]);
    };

    const {downsamplingLayout} = this;
    if (downsamplingLayout === ChunkLayoutPreference.FLAT) {
      return [
        get2dDownsampledSources([downsampleDims[0], downsampleDims[1]]),
        get2dDownsampledSources([downsampleDims[0], downsampleDims[2]]),
        get2dDownsampledSources([downsampleDims[1], downsampleDims[2]]),
      ];
    }

    return transposeNestedArrays(
        computeNearIsotropicDownsamplingLevels(
            this.shape, downsampleDims, effectiveDisplayScales, this.maxDownsampling,
            this.maxDownsamplingScales, this.maxDownsampledSize)
            .map(
                downsampleFactors => getSourcesFromDownsampleFactors(
                    downsampleFactors, downsampleDims, this.chunkLayoutPreference)));
  }

  getMeshSource() {
    const {skeletonVertexAttributes} = this;
    if (skeletonVertexAttributes !== undefined) {
      return this.chunkManager.getChunkSource(PythonSkeletonSource, {
        dataSource: this.dataSource,
        generation: this.generation,
        parameters: {
          key: this.key,
          vertexAttributes: skeletonVertexAttributes,
        }
      });
    }
    return this.chunkManager.getChunkSource(PythonMeshSource, {
      dataSource: this.dataSource,
      generation: this.generation,
      parameters: {
        key: this.key,
      }
    });
  }
}

export class PythonSkeletonSource extends
(WithPythonDataSource(WithParameters(SkeletonSource, SkeletonSourceParameters))) {
  get vertexAttributes() {
    return this.parameters.vertexAttributes;
  }
}

function parseVertexAttributeInfo(x: any): VertexAttributeInfo {
  verifyObject(x);
  return {
    dataType: verifyObjectProperty(x, 'dataType', y => verifyEnumString(y, DataType)),
    numComponents: verifyObjectProperty(x, 'numComponents', verifyPositiveInt),
  };
}

function getVolumeDataSource(
    dataSourceProvider: PythonDataSource, options: GetDataSourceOptions, key: string) {
  return options.chunkManager.memoize.getUncounted(
      {'type': 'python:VolumeDataSource', key}, async () => {
        const response = await (await fetchOk(`../../neuroglancer/info/${key}`)).json();
        const volume = new PythonMultiscaleVolumeChunkSource(
            dataSourceProvider, options.chunkManager, key, response);
        const dataSource: DataSource = {
          modelTransform: makeIdentityTransform(volume.modelSpace),
          subsources: [
            {
              id: 'default',
              default: true,
              subsource: {volume},
              subsourceToModelSubspaceTransform: volume.subsourceToModelTransform,
            },
            {
              id: 'bounds',
              default: true,
              subsource: {
                staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(volume.modelSpace.bounds)
              },
            },
          ],
        };
        if (volume.rank === 3 && volume.dataType !== DataType.FLOAT32) {
          const subsourceToModelSubspaceTransform =
              new Float32Array(volume.subsourceToModelTransform);
          const {scales, rank} = volume.modelSpace;
          for (let i = 0; i < rank; ++i) {
            subsourceToModelSubspaceTransform[(rank + 2) * i] = 1 / scales[i];
          }
          dataSource.subsources.push({
            id: 'meshes',
            default: true,
            subsourceToModelSubspaceTransform,
            subsource: {
              mesh: options.chunkManager.getChunkSource(PythonMeshSource, {
                dataSource: dataSourceProvider,
                generation: volume.generation,
                parameters: {
                  key: key,
                }
              })
            },
          });
        }
        return dataSource;
      });
}

function getSkeletonDataSource(
    dataSourceProvider: PythonDataSource, options: GetDataSourceOptions, key: string) {
  return options.chunkManager.memoize.getUncounted(
      {'type': 'python:SkeletonDataSource', key}, async () => {
        const response = await (await fetchOk(`../../neuroglancer/skeletoninfo/${key}`)).json();
        const {baseModelSpace, subsourceToModelTransform} =
            parseCoordinateSpaceAndVoxelOffset(response);
        const vertexAttributes = verifyObjectProperty(
            response, 'attributes', x => verifyObjectAsMap(x, parseVertexAttributeInfo));
        const generation = verifyObjectProperty(response, 'generation', x => x);
        const skeletonSource = options.chunkManager.getChunkSource(PythonSkeletonSource, {
          dataSource: dataSourceProvider,
          generation,
          parameters: {
            key,
            vertexAttributes,
          }
        });
        const dataSource: DataSource = {
          modelTransform: makeIdentityTransform(baseModelSpace),
          subsources: [
            {
              id: 'default',
              subsourceToModelSubspaceTransform: subsourceToModelTransform,
              default: true,
              subsource: {
                mesh: skeletonSource,
              },
            },
          ],
        };
        return dataSource;
      });
}

export class PythonDataSource extends DataSourceProvider {
  private sources = new Map<string, Set<PythonChunkSource>>();
  sourceGenerations = new Map<string, number>();

  registerSource(key: string, source: PythonChunkSource) {
    let existingSet = this.sources.get(key);
    if (existingSet === undefined) {
      existingSet = new Set();
      this.sources.set(key, existingSet);
    }
    const generation = this.sourceGenerations.get(key);
    if (generation !== undefined) {
      source.generation = generation;
    }
    existingSet.add(source);
    source.registerDisposer(() => {
      existingSet!.delete(source);
      if (existingSet!.size === 0) {
        this.sources.delete(key);
      }
    });
  }

  setSourceGeneration(key: string, generation: number) {
    const {sourceGenerations} = this;
    if (sourceGenerations.get(key) === generation) {
      return;
    }
    sourceGenerations.set(key, generation);
    const sources = this.sources.get(key);
    if (sources !== undefined) {
      for (const source of sources) {
        if (source.generation !== generation) {
          source.generation = generation;
          source.invalidateCache();
        }
      }
    }
  }

  deleteSourceGeneration(key: string) {
    this.sourceGenerations.delete(key);
  }

  get description() {
    return 'Python-served volume';
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    const m = options.providerUrl.match(`^(volume|skeleton)/(.*)$`);
    if (m === null) {
      throw new Error(`Invalid Python data source URL: ${JSON.stringify(options.providerUrl)}`);
    }
    const key = m[2];
    if (m[1] === 'volume') {
      return getVolumeDataSource(this, options, key);
    } else {
      return getSkeletonDataSource(this, options, key);
    }
  }
}
