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
import {DataSource, DataSourceProvider, GetVolumeOptions} from 'neuroglancer/datasource';
import {ComputationParameters, ComputedVolumeChunkSourceParameters, REQUEST_FRONTEND_CHUNK, RETURN_FRONTEND_CHUNK} from 'neuroglancer/datasource/computed/base';
import {UncompressedVolumeChunk} from 'neuroglancer/sliceview/uncompressed_chunk_format';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {registerRPC, RPC, SharedObject} from 'neuroglancer/worker_rpc';


class ComputedVolumeChunkSource extends
(WithParameters(VolumeChunkSource, ComputedVolumeChunkSourceParameters)) {}

export abstract class VolumeComputationFrontend<T extends ComputationParameters> extends
    SharedObject {
  /**
   * Modifes the ComputedVolumeDataSourceParameters as needed and returns
   * parameters for the backend computation.
   * @param config Config data supplied from the URL
   * @param volumes A volumes array as returned by
   *   GenericMultiscaleVolumeChunkSource.getSources()
   * @param params volume data source parameters, populated with defaults
   *   from the native resolution origin source. These are to be modified.
   * @returns a Promise containing parameters passed to the backend
   *   computation.
   */
  abstract initialize(
      config: string, volumes: VolumeChunkSource[][],
      params: ComputedVolumeDataSourceParameters): Promise<T>;
}

export interface VolumeComputationFrontendProvider<T extends ComputationParameters> {
  makeComputation(): VolumeComputationFrontend<T>;
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

  dataSourceProvider: DataSourceProvider;
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
      public computation: VolumeComputationFrontend<any>, public chunkManager: ChunkManager) {
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


export class ComputedDataSource extends DataSource {
  parseConfig(config: string, {} /*dataSourceProvider: DataSourceProvider*/) {
    // config is expected to be like computeName(computeParams)source(url)
    // In which case, matches will be ['(computeParams)', '(url)']
    const re = /\([^)]*\)/g;
    const matches = config.match(re);
    if (!matches || matches.length < 1) {
      return [[], []];
    }

    const sourceNames = [];
    const sourceConfigs = [];
    let lastEnd = 0;
    for (const match of matches) {
      const tokenEnd = config.indexOf(match);
      sourceNames.push(config.substring(lastEnd, tokenEnd));
      sourceConfigs.push(match.substring(1, match.length - 1));
      lastEnd = tokenEnd + match.length;
    }

    return [sourceNames, sourceConfigs];
  }

  getOriginVolumes(
      dataSourceProvider: DataSourceProvider, originUrl: string, config: string,
      chunkManager: ChunkManager,
      cancellationToken: CancellationToken): Promise<ComputedVolumeSpecs> {
    return new Promise((resolve, reject) => {
             const dataSource = dataSourceProvider.getDataSource(originUrl)[0];
             if (!dataSource || !dataSource.getVolume) {
               reject();
             }
             resolve(dataSource.getVolume!(chunkManager, config, {}, cancellationToken));
           })
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
      dataSourceProvider: DataSourceProvider): ComputedVolumeDataSourceParameters {
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
    if (!options.dataSourceProvider) {
      return Promise.reject('Need a DataSourceProvider');
    }

    const dataSourceProvider = options.dataSourceProvider!;
    const [sourceNames, sourceConfigs] = this.parseConfig(config, dataSourceProvider);

    if (sourceNames.length < 2) {
      return Promise.reject();
    }

    // The first source name should be the key to a VolumeComputation
    const computationProvider = ComputedDataSource.computationMap.get(sourceNames[0]);
    const originUrl = sourceNames[1] + '://' + sourceConfigs[1];

    if (!computationProvider) {
      return Promise.reject();
    }

    return this
        .getOriginVolumes(
            dataSourceProvider, originUrl, sourceConfigs[1], chunkManager, cancellationToken)
        .then((volumes) => {
          const dataSourceParams = this.defaultParams(volumes, originUrl, dataSourceProvider);
          const computation = computationProvider.makeComputation();
          return computation.initialize(sourceConfigs[0], volumes.sources, dataSourceParams)
              .then((computationParams: ComputationParameters) => {
                computation.initializeCounterpart(chunkManager.rpc!, computationParams);
                return new ComputedMultiscaleVolumeChunkSource(
                    dataSourceParams, volumes.sources, computation, chunkManager);
              });
        });
  }

  static computationMap = new Map<string, VolumeComputationFrontendProvider<any>>();

  static registerComputation(
      key: string, computationProvider: VolumeComputationFrontendProvider<any>) {
    this.computationMap.set(key, computationProvider);
  }
}

const MAX_FETCH_TRIES = 5;
const FETCH_DELAY = 50;  // ms

function fetchFrontendChunkData(rpc: RPC, x: any) {
  const source: VolumeChunkSource = rpc.getRef(x['originSourceRef']);
  const chunkKey: string = x['chunkKey'];
  const originGridKey: string = x['originGridKey'];
  const requestorSourceRef: any = x['requestorSourceRef'];
  if (!x.hasOwnProperty('try')) {
    x['try'] = 1;
  }
  const nTry = x['try'];

  if (source.chunks.has(chunkKey)) {
    const chunk = <UncompressedVolumeChunk>source.chunks.get(chunkKey);
    rpc.invoke(
        RETURN_FRONTEND_CHUNK,
        {requestorSourceRef, chunkKey, originGridKey, error: undefined, data: chunk.data});
    return;
  }

  // When we can't find data on the frontend, it usually means that we're in a
  // race condition: we started listening just after the origin chunk's data
  // was sent to the frontend, but this request arrived before the data was
  // fully transferred. This is a fairly rare occurrence, but it does happen.
  // Here, we wait for progressively longer periods of time, giving up after
  // about 1.25s.
  //
  // This is simpler than a listener-callback structure, but is not
  // deterministic.

  if (nTry > MAX_FETCH_TRIES) {
    console.log('Requested source does not have data for chunk', originGridKey);
    rpc.invoke(
        RETURN_FRONTEND_CHUNK,
        {requestorSourceRef, chunkKey, originGridKey, error: 'Does Not Exist', data: undefined});
    return;
  }

  const timeout = FETCH_DELAY * (2 ** nTry);
  ++x['try'];
  setTimeout(() => {
    fetchFrontendChunkData(rpc, x);
  }, timeout);
}

registerRPC(REQUEST_FRONTEND_CHUNK, function(x) {
  fetchFrontendChunkData(this, x);
});
