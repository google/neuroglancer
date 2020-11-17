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

import {AnnotationSource} from 'neuroglancer/annotation';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateSpace, CoordinateSpaceTransform, CoordinateTransformSpecification, emptyValidCoordinateSpace, makeCoordinateSpace, makeIdentityTransform} from 'neuroglancer/coordinate_transform';
import {CredentialsManager} from 'neuroglancer/credentials_provider';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {SegmentPropertyMap} from 'neuroglancer/segmentation_display_state/property_map';
import {SegmentationGraphSource} from 'neuroglancer/segmentation_graph/source';
import {SingleMeshSource} from 'neuroglancer/single_mesh/frontend';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {applyCompletionOffset, BasicCompletionResult, CompletionWithDescription, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {createIdentity} from 'neuroglancer/util/matrix';

export type CompletionResult = BasicCompletionResult<CompletionWithDescription>;

export class RedirectError extends Error {
  constructor(public redirectTarget: string) {
    super(`Redirected to: ${redirectTarget}`);
  }
}

/**
 * Returns the length of the prefix of path that corresponds to the "group", according to the
 * specified separator.
 *
 * If the separator is not specified, gueses whether it is '/' or ':'.
 */
export function findSourceGroupBasedOnSeparator(path: string, separator?: string) {
  if (separator === undefined) {
    // Try to guess whether '/' or ':' is the separator.
    if (path.indexOf('/') === -1) {
      separator = ':';
    } else {
      separator = '/';
    }
  }
  let index = path.lastIndexOf(separator);
  if (index === -1) {
    return 0;
  }
  return index + 1;
}


/**
 * Returns the last "component" of path, according to the specified separator.
 * If the separator is not specified, gueses whether it is '/' or ':'.
 */
export function suggestLayerNameBasedOnSeparator(path: string, separator?: string) {
  let groupIndex = findSourceGroupBasedOnSeparator(path, separator);
  return path.substring(groupIndex);
}

export interface GetDataSourceOptionsBase {
  chunkManager: ChunkManager;
  cancellationToken?: CancellationToken;
  url: string;
  transform: CoordinateTransformSpecification|undefined;
  globalCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
}

export interface GetDataSourceOptions extends GetDataSourceOptionsBase {
  registry: DataSourceProviderRegistry;
  providerUrl: string;
  cancellationToken: CancellationToken;
  providerProtocol: string;
  credentialsManager: CredentialsManager;
}

export interface ConvertLegacyUrlOptionsBase {
  url: string;
  type: 'mesh'|'skeletons'|'single_mesh';
}

export interface ConvertLegacyUrlOptions extends ConvertLegacyUrlOptionsBase {
  registry: DataSourceProviderRegistry;
  providerUrl: string;
  providerProtocol: string;
}

export interface NormalizeUrlOptionsBase {
  url: string;
}

export interface NormalizeUrlOptions extends NormalizeUrlOptionsBase {
  registry: DataSourceProviderRegistry;
  providerUrl: string;
  providerProtocol: string;
}

export enum LocalDataSource {
  annotations,
  equivalences,
}

export interface DataSubsource {
  volume?: MultiscaleVolumeChunkSource;
  mesh?: MeshSource|MultiscaleMeshSource|SkeletonSource;
  annotation?: MultiscaleAnnotationSource;
  staticAnnotations?: AnnotationSource;
  local?: LocalDataSource;
  singleMesh?: SingleMeshSource;
  segmentPropertyMap?: SegmentPropertyMap;
  segmentationGraph?: SegmentationGraphSource;
}

export interface CompleteUrlOptionsBase {
  url: string;
  cancellationToken?: CancellationToken;
  chunkManager: ChunkManager;
}

export interface CompleteUrlOptions extends CompleteUrlOptionsBase {
  registry: DataSourceProviderRegistry;
  providerUrl: string;
  cancellationToken: CancellationToken;
  credentialsManager: CredentialsManager;
}

export interface DataSubsourceEntry {
  /**
   * Unique identifier (within the group) for this subsource.  Stored in the JSON state
   * representation to indicate which subsources are enabled.  The empty string `""` should be used
   * for the first/primary subsource.
   */
  id: string;

  subsource: DataSubsource;

  /**
   * Homoegeneous transformation from the subsource to the model subspace corresponding to
   * `modelSubspceDimensionIndices`.  The rank is equal to the length of
   * `modelSubspaceDimensionIndices`.  If this is greater than the subsource rank, the subsource
   * coordinate space is implicitly padded at the end with additional dummy dimensions with a range
   * of `[0, 1]`.  If unspecified, defaults to the identity transform.
   */
  subsourceToModelSubspaceTransform?: Float32Array;

  /**
   * Specifies the model dimensions corresponding to this subsource.  If unspecified, defaults to
   * `[0, ..., modelSpace.rank)`.
   */
  modelSubspaceDimensionIndices?: number[];

  /**
   * Specifies whether this associated data source is enabled by default.
   */
  default: boolean;
}

export interface DataSource {
  subsources: DataSubsourceEntry[];
  modelTransform: CoordinateSpaceTransform;
  canChangeModelSpaceRank?: boolean;
}

export interface DataSourceProvider {
  /**
   * Returns a suggested layer name for the given volume source.
   */
  suggestLayerName?(path: string): string;

  /**
   * Returns the length of the prefix of path that is its 'group'.  This is used for suggesting a
   * default URL for adding a new layer.
   */
  findSourceGroup?(path: string): number;
}

export interface DataSubsourceSpecification {
  enabled?: boolean;
}

export interface DataSourceSpecification {
  url: string;
  transform: CoordinateTransformSpecification|undefined;
  enableDefaultSubsources: boolean;
  subsources: Map<string, DataSubsourceSpecification>;
}

export function makeEmptyDataSourceSpecification(): DataSourceSpecification {
  return {url: '', transform: undefined, enableDefaultSubsources: true, subsources: new Map()};
}

export abstract class DataSourceProvider extends RefCounted {
  abstract description?: string;

  abstract get(options: GetDataSourceOptions): Promise<DataSource>;

  normalizeUrl(options: NormalizeUrlOptions): string {
    return options.url;
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    return options.url;
  }

  async completeUrl(options: CompleteUrlOptions): Promise<CompletionResult> {
    options;
    throw null;
  }
}

export const localAnnotationsUrl = 'local://annotations';
export const localEquivalencesUrl = 'local://equivalences';

class LocalDataSourceProvider extends DataSourceProvider {
  get description() {
    return 'Local in-memory';
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    switch (options.url) {
      case localAnnotationsUrl: {
        const {transform} = options;
        let modelTransform: CoordinateSpaceTransform;
        if (transform === undefined) {
          const baseSpace = options.globalCoordinateSpace.value;
          const {rank, names, scales, units} = baseSpace;
          const inputSpace = makeCoordinateSpace({
            rank,
            scales,
            units,
            names: names.map((_, i) => `${i}`),
          });
          const outputSpace = makeCoordinateSpace({rank, scales, units, names});
          modelTransform = {
            rank,
            sourceRank: rank,
            inputSpace,
            outputSpace,
            transform: createIdentity(Float64Array, rank + 1),
          };
        } else {
          modelTransform = makeIdentityTransform(emptyValidCoordinateSpace);
        }
        return {
          modelTransform,
          canChangeModelSpaceRank: true,
          subsources: [
            {
              id: 'default',
              default: true,
              subsource: {
                local: LocalDataSource.annotations,
              },
            },
          ],
        };
      }
      case localEquivalencesUrl: {
        return {
          modelTransform: makeIdentityTransform(emptyValidCoordinateSpace),
          canChangeModelSpaceRank: false,
          subsources: [
            {
              id: 'default',
              default: true,
              subsource: {
                local: LocalDataSource.equivalences,
              },
            },
          ],
        };
      }
    }
    throw new Error('Invalid local data source URL');
  }

  async completeUrl(options: CompleteUrlOptions) {
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions(
          options.providerUrl,
          [
            {
              value: 'annotations',
              description: 'Annotations stored in the JSON state',
            },
            {
              value: 'equivalences',
              description: 'Segmentation equivalence graph stored in the JSON state'
            },
          ],
          x => x.value, x => x.description)
    };
  }
}

const protocolPattern = /^(?:([a-zA-Z][a-zA-Z0-9-+_]*):\/\/)?(.*)$/;

export class DataSourceProviderRegistry extends RefCounted {
  constructor(public credentialsManager: CredentialsManager) {
    super();
  }
  dataSources =
      new Map<string, Owned<DataSourceProvider>>([['local', new LocalDataSourceProvider()]]);

  register(name: string, dataSource: Owned<DataSourceProvider>) {
    this.dataSources.set(name, this.registerDisposer(dataSource));
  }

  getProvider(url: string): [DataSourceProvider, string, string] {
    const m = url.match(protocolPattern);
    if (m === null || m[1] === undefined) {
      throw new Error(`Data source URL must have the form "<protocol>://<path>".`);
    }
    const [, providerProtocol, providerUrl] = m;
    const factory = this.dataSources.get(providerProtocol);
    if (factory === undefined) {
      throw new Error(`Unsupported data source: ${JSON.stringify(providerProtocol)}.`);
    }
    return [factory, providerUrl, providerProtocol];
  }

  async get(options: GetDataSourceOptionsBase): Promise<DataSource> {
    const redirectLog = new Set<string>();
    const {cancellationToken = uncancelableToken} = options;
    let url: string = options.url;
    while (true) {
      const [provider, providerUrl, providerProtocol] = this.getProvider(options.url);
      redirectLog.add(options.url);
      try {
        return provider.get({
          ...options,
          url,
          providerProtocol,
          providerUrl,
          registry: this,
          cancellationToken,
          credentialsManager: this.credentialsManager,
        });
      } catch (e) {
        if (e instanceof RedirectError) {
          const redirect = e.redirectTarget;
          if (redirectLog.has(redirect)) {
            throw Error(`Layer source redirection contains loop: ${
                JSON.stringify(Array.from(redirectLog))}`);
          }
          if (redirectLog.size >= 10) {
            throw Error(
                `Too many layer source redirections: ${JSON.stringify(Array.from(redirectLog))}`);
          }
          url = redirect;
          continue;
        }
        throw e;
      }
    }
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptionsBase): string {
    try {
      const [provider, providerUrl, providerProtocol] = this.getProvider(options.url);
      return provider.convertLegacyUrl({...options, providerUrl, providerProtocol, registry: this});
    } catch {
      return options.url;
    }
  }

  normalizeUrl(options: NormalizeUrlOptionsBase): string {
    try {
      const [provider, providerUrl, providerProtocol] = this.getProvider(options.url);
      return provider.normalizeUrl({...options, providerUrl, providerProtocol, registry: this});
    } catch {
      return options.url;
    }
  }

  async completeUrl(options: CompleteUrlOptionsBase): Promise<CompletionResult> {
    // Check if url matches a protocol.  Note that protocolPattern always matches.
    const {url, cancellationToken = uncancelableToken} = options;
    let protocolMatch = url.match(protocolPattern)!;
    let protocol = protocolMatch[1];
    if (protocol === undefined) {
      return Promise.resolve({
        offset: 0,
        completions: getPrefixMatchesWithDescriptions(
            url, this.dataSources, ([name]) => `${name}://`, ([, factory]) => factory.description)
      });
    } else {
      const factory = this.dataSources.get(protocol);
      if (factory !== undefined) {
        const completions = await factory.completeUrl({
          registry: this,
          url,
          providerUrl: protocolMatch[2],
          chunkManager: options.chunkManager,
          cancellationToken,
          credentialsManager: this.credentialsManager,
        });
        return applyCompletionOffset(protocol.length + 3, completions);
      }
      throw null;
    }
  }

  suggestLayerName(url: string) {
    let [dataSource, path] = this.getProvider(url);
    if (path.endsWith('/')) {
      path = path.substring(0, path.length - 1);
    }
    let suggestor = dataSource.suggestLayerName;
    if (suggestor !== undefined) {
      return suggestor(path);
    }
    return suggestLayerNameBasedOnSeparator(path);
  }

  findSourceGroup(url: string) {
    let [dataSource, path, dataSourceName] = this.getProvider(url);
    let helper = dataSource.findSourceGroup || findSourceGroupBasedOnSeparator;
    return helper(path) + dataSourceName.length + 3;
  }
}
