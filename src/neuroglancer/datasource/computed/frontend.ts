/**
 * @license
 * Copyright 2018 Google Inc.
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

import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {DataSourceProvider, DataSourceProviderRegistry, GetVolumeOptions} from 'neuroglancer/datasource';
import {ComputationParameters, ComputedVolumeChunkSourceParameters} from 'neuroglancer/datasource/computed/base';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyString} from 'neuroglancer/util/json';
import {SharedObject} from 'neuroglancer/worker_rpc';


class ComputedVolumeChunkSource extends
(WithParameters(VolumeChunkSource, ComputedVolumeChunkSourceParameters)) {}

export abstract class VolumeComputationFrontend extends SharedObject {
  constructor(public params: ComputationParameters) {
    super();
  }
}

export interface VolumeComputationFrontendProvider {
  /**
   * Modifes the ComputedVolumeDataSourceParameters as needed and returns
   * a VolumeComputationFrontend in a Promise.
   * @param config a JSON object parsed from the URL
   * @param volumes A volumes array as returned by
   *   GenericMultiscaleVolumeChunkSource.getSources()
   * @param params volume data source parameters, populated with defaults
   *   from the native resolution origin source. These are to be modified.
   * @returns a Promise containing containg the frontend computation.
   */
  getComputation(
      config: any, volumes: VolumeChunkSource[][],
      params: ComputedVolumeDataSourceParameters): Promise<VolumeComputationFrontend>;
}

export interface ComputedVolumeDataSourceParameters {
  // URL of the origin volume chunk source, used as computational input.
  originUrl: string;
  // Index of the input scale on the origin source.
  inputScaleIndex: number;
  // Index of the input volume at the given scale on the origin source.
  inputSourceIndex: number;
  // Output voxel size.
  outputVoxelSize: vec3;
  // Output voxel offset.
  outputVoxelOffset: vec3;
  // Output volume size.
  outputVolumeSize: vec3;
  // Determines input buffer size as well as output data chunks size, etc.
  computationParameters: ComputationParameters;

  dataSourceProvider: DataSourceProviderRegistry;
}

interface ComputedVolumeSpecs {
  sources: VolumeChunkSource[][];
  volumeType: VolumeType;
  dataType: DataType;
  numChannels: number;
}

export class ComputedMultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  numChannels: number;
  dataType: DataType;
  volumeType: VolumeType;

  constructor(
      public params: ComputedVolumeDataSourceParameters, public sources: VolumeChunkSource[][],
      public computation: VolumeComputationFrontend, public chunkManager: ChunkManager) {
    this.numChannels = params.computationParameters.outputSpec.numChannels;
    this.dataType = params.computationParameters.outputSpec.dataType;
    this.volumeType = params.computationParameters.outputSpec.volumeType;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const spec = VolumeChunkSpecification.getDefaults({
      voxelSize: this.params.outputVoxelSize,
      dataType: this.dataType,
      numChannels: this.numChannels,
      chunkDataSizes: [this.params.computationParameters.outputSpec.size],
      transform: mat4.fromTranslation(
          mat4.create(),
          vec3.multiply(vec3.create(), this.params.outputVoxelSize, this.params.outputVoxelOffset)),
      upperVoxelBound: this.params.outputVolumeSize,
      volumeType: this.volumeType,
      baseVoxelOffset: this.params.outputVoxelOffset,
      volumeSourceOptions,
    })[0];

    const originSource = this.sources[this.params.inputScaleIndex][this.params.inputSourceIndex];
    const inputResolution = originSource.spec.voxelSize;

    const parameters: ComputedVolumeChunkSourceParameters = {
      computationRef: this.computation.addCounterpartRef(),
      sourceRef: originSource.addCounterpartRef(),
      inputSize: this.params.computationParameters.inputSpec.size,
      scaleFactor: vec3.divide(vec3.create(), this.params.outputVoxelSize, inputResolution)
    };

    const computedSource =
        this.chunkManager.getChunkSource(ComputedVolumeChunkSource, {spec, parameters});

    return [[computedSource]];
  }

  getMeshSource() {
    return null;
  }
}


export class ComputedDataSource extends DataSourceProvider {
  getOriginVolumes(
      dataSourceProvider: DataSourceProviderRegistry, originUrl: string, chunkManager: ChunkManager,
      cancellationToken: CancellationToken): Promise<ComputedVolumeSpecs> {
    return dataSourceProvider.getVolume(chunkManager, originUrl, {}, cancellationToken)
        .then((multiScaleVolumeChunkSource: GenericMultiscaleVolumeChunkSource) => {
          const sources = multiScaleVolumeChunkSource.getSources({});
          const specs = sources.map((volumeChunkSources) => {
            return volumeChunkSources.map((volumeChunkSource) => {
              return volumeChunkSource.spec;
            });
          });

          return {
            specs,
            sources,
            volumeType: multiScaleVolumeChunkSource.volumeType,
            dataType: multiScaleVolumeChunkSource.dataType,
            numChannels: multiScaleVolumeChunkSource.numChannels,
          };
        });
  }

  /**
   * Creates a ComputedVolumeDataSourceParameters object with default values
   * populated from the first volume spec at native resolution.
   * @param volumeSpecs ComputedVolumeSpecs
   * @param originUrl url for the origin data source
   * @param dataSourceProvider
   * @returns ComputedVolumeDataSourceParameters
   */
  defaultParams(
      volumeSpecs: ComputedVolumeSpecs, originUrl: string,
      dataSourceProvider: DataSourceProviderRegistry): ComputedVolumeDataSourceParameters {
    const spec = volumeSpecs.sources[0][0].spec;
    // Default DataType, VolumeType, channel count
    const {dataType, volumeType, numChannels} = volumeSpecs;
    // Default chunk size, used for input and output computation buffer sizes.
    const size = spec.chunkDataSize;
    return {
      originUrl,
      computationParameters: {
        inputSpec: {size: vec3.copy(vec3.create(), size), dataType, volumeType, numChannels},
        outputSpec: {size: vec3.copy(vec3.create(), size), dataType, volumeType, numChannels}
      },
      inputScaleIndex: 0,
      inputSourceIndex: 0,
      outputVoxelSize: vec3.copy(vec3.create(), spec.voxelSize),
      outputVolumeSize: vec3.copy(vec3.create(), spec.upperVoxelBound),
      outputVoxelOffset: vec3.copy(vec3.create(), spec.baseVoxelOffset),
      dataSourceProvider
    };
  }

  get description() {
    return 'Computed data source.';
  }

  getVolume(
      chunkManager: ChunkManager, config: string, options: GetVolumeOptions,
      cancellationToken: CancellationToken) {
    // Config is expected to be a json string, for example:
    //   {"origin":"brainmaps://p:d:v","computation":"example","inputSize":
    //     [36,36,32],"outputSize":[32,32,32]}
    console.log('Computed datasource config:', config);
    if (!options.dataSourceProvider) {
      return Promise.reject(new Error('Need a DataSourceProvider'));
    }

    const dataSourceProvider = options.dataSourceProvider!;
    let configObj: any;
    try {
      configObj = verifyObject(JSON.parse(config));
    } catch (error) {
      return Promise.reject(new Error(
          `Could not parse JSON configuration while initializing computational datasource: ${
              error}`));
    }

    if (!configObj) {
      return Promise.reject(new Error('Could not verify configuration JSON'));
    }
    if (configObj['origin'] === undefined) {
      return Promise.reject(new Error('Config is missing origin'));
    }
    if (configObj['computation'] === undefined) {
      return Promise.reject(new Error('Config is missing computation'));
    }

    const computationName = verifyString(configObj['computation']);
    const computationProvider = ComputedDataSource.computationMap.get(computationName);

    const originUrl = verifyString(configObj['origin']);

    if (!computationProvider) {
      return Promise.reject(new Error(`Unable to find computation ${computationName}`));
    }

    return this.getOriginVolumes(dataSourceProvider, originUrl, chunkManager, cancellationToken)
        .then((volumes) => {
          const dataSourceParams = this.defaultParams(volumes, originUrl, dataSourceProvider);
          return chunkManager.memoize.getUncounted(
              {type: 'computed:getVolume', config: configObj},
              () => computationProvider.getComputation(configObj, volumes.sources, dataSourceParams)
                        .then((computation: VolumeComputationFrontend) => {
                          computation.initializeCounterpart(chunkManager.rpc!, computation.params);
                          return new ComputedMultiscaleVolumeChunkSource(
                              dataSourceParams, volumes.sources, computation, chunkManager);
                        }));
        });
  }

  static computationMap = new Map<string, VolumeComputationFrontendProvider>();

  static registerComputation(key: string, computationProvider: VolumeComputationFrontendProvider) {
    this.computationMap.set(key, computationProvider);
  }
}
