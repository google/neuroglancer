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

import type { MultiscaleAnnotationSource } from "#src/annotation/frontend_source.js";
import type { AnnotationSource } from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type {
  CoordinateSpace,
  CoordinateSpaceTransform,
  CoordinateTransformSpecification,
} from "#src/coordinate_transform.js";
import type { SharedCredentialsManager } from "#src/credentials_provider/shared.js";
import { getKvStoreCompletions } from "#src/datasource/kvstore_completions.js";
import type { LocalDataSource } from "#src/datasource/local.js";
import {
  AutoDetectRegistry,
  autoDetectFormat,
} from "#src/kvstore/auto_detect.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import type { UrlWithParsedScheme } from "#src/kvstore/url.js";
import {
  extractQueryAndFragment,
  finalPipelineUrlComponent,
  parsePipelineUrlComponent,
  splitPipelineUrl,
} from "#src/kvstore/url.js";
import type { MeshSource, MultiscaleMeshSource } from "#src/mesh/frontend.js";
import type { SegmentPropertyMap } from "#src/segmentation_display_state/property_map.js";
import type { SegmentationGraphSource } from "#src/segmentation_graph/source.js";
import type { SingleMeshSource } from "#src/single_mesh/frontend.js";
import type { SkeletonSource } from "#src/skeleton/frontend.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type {
  BasicCompletionResult,
  CompletionWithDescription,
} from "#src/util/completion.js";
import {
  applyCompletionOffset,
  emptyCompletionResult,
  getPrefixMatchesWithDescriptions,
} from "#src/util/completion.js";
import { RefCounted } from "#src/util/disposable.js";
import { type ProgressOptions } from "#src/util/progress_listener.js";
import type { Trackable } from "#src/util/trackable.js";

export type CompletionResult = BasicCompletionResult<CompletionWithDescription>;

/**
 * Returns the length of the prefix of path that corresponds to the "group", according to the
 * specified separator.
 *
 * If the separator is not specified, gueses whether it is '/' or ':'.
 */
export function findSourceGroupBasedOnSeparator(
  path: string,
  separator?: string,
) {
  if (separator === undefined) {
    // Try to guess whether '/' or ':' is the separator.
    if (path.indexOf("/") === -1) {
      separator = ":";
    } else {
      separator = "/";
    }
  }
  const index = path.lastIndexOf(separator);
  if (index === -1) {
    return 0;
  }
  return index + 1;
}

/**
 * Returns the last "component" of path, according to the specified separator.
 * If the separator is not specified, gueses whether it is '/' or ':'.
 */
export function suggestLayerNameBasedOnSeparator(
  path: string,
  separator?: string,
) {
  const groupIndex = findSourceGroupBasedOnSeparator(path, separator);
  return path.substring(groupIndex);
}

export interface GetDataSourceOptionsBase extends Partial<ProgressOptions> {
  url: string;
  transform: CoordinateTransformSpecification | undefined;
  globalCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  state?: any;
}

export interface GetDataSourceOptions extends GetDataSourceOptionsBase {
  registry: DataSourceRegistry;
  providerUrl: string;
  signal: AbortSignal;
  providerScheme: string;
}

export interface ConvertLegacyUrlOptionsBase {
  url: string;
  type: "mesh" | "skeletons" | "single_mesh";
}

export interface ConvertLegacyUrlOptions extends ConvertLegacyUrlOptionsBase {
  registry: DataSourceRegistry;
  providerUrl: string;
  providerScheme: string;
}

export interface DataSubsource {
  volume?: MultiscaleVolumeChunkSource;
  mesh?: MeshSource | MultiscaleMeshSource | SkeletonSource;
  annotation?: MultiscaleAnnotationSource;
  staticAnnotations?: AnnotationSource;
  local?: LocalDataSource;
  singleMesh?: SingleMeshSource;
  segmentPropertyMap?: SegmentPropertyMap;
  segmentationGraph?: SegmentationGraphSource;
}

export interface CompleteUrlOptionsBase extends Partial<ProgressOptions> {
  url: string;
}

export interface CompleteUrlOptions extends CompleteUrlOptionsBase {
  registry: DataSourceRegistry;
  providerUrl: string;
  signal: AbortSignal;
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
  state?: Trackable;
  canonicalUrl?: string;
}

export interface DataSourceRedirect {
  // Canonical URL of the source.
  canonicalUrl?: string;

  // Target URL.
  targetUrl: string;
}

export type DataSourceLookupResult = DataSource | DataSourceRedirect;

export interface DataSourceWithRedirectInfo extends DataSource {
  // Canonical URL prior to any redirects.
  originalCanonicalUrl?: string;
  redirectLog: Set<string>;
}

export interface DataSubsourceSpecification {
  enabled?: boolean;
}

export interface DataSourceSpecification {
  url: string;
  transform: CoordinateTransformSpecification | undefined;
  enableDefaultSubsources: boolean;
  subsources: Map<string, DataSubsourceSpecification>;
  state?: any;

  // Indicates that the spec was set manually in the UI.
  setManually?: boolean;
}

export function makeEmptyDataSourceSpecification(): DataSourceSpecification {
  return {
    url: "",
    transform: undefined,
    enableDefaultSubsources: true,
    subsources: new Map(),
  };
}

export interface DataSourceProvider {
  scheme: string;
  description?: string;
  // Exclude from completion list.
  hidden?: boolean;

  get(options: GetDataSourceOptions): Promise<DataSourceLookupResult>;

  convertLegacyUrl?: (options: ConvertLegacyUrlOptions) => string;

  completeUrl?: (options: CompleteUrlOptions) => Promise<CompletionResult>;
}

export interface KvStoreBasedDataSourceProvider {
  scheme: string;
  description?: string;
  singleFile?: boolean;
  expectsDirectory?: boolean;
  get(
    options: GetKvStoreBasedDataSourceOptions,
  ): Promise<DataSourceLookupResult>;
  completeUrl?: (
    options: GetKvStoreBasedDataSourceOptions,
  ) => Promise<CompletionResult>;
}

export interface GetKvStoreBasedDataSourceOptions
  extends Partial<ProgressOptions> {
  registry: DataSourceRegistry;
  kvStoreUrl: string;
  url: UrlWithParsedScheme;
  state?: any;
}

const schemePattern = /^(?:([a-zA-Z][a-zA-Z0-9-+_]*):\/\/)?(.*)$/;

export class DataSourceRegistry extends RefCounted {
  get credentialsManager(): SharedCredentialsManager {
    return this.sharedKvStoreContext.credentialsManager;
  }

  get chunkManager(): ChunkManager {
    return this.sharedKvStoreContext.chunkManager;
  }

  constructor(public sharedKvStoreContext: SharedKvStoreContext) {
    super();
  }
  dataSources = new Map<string, DataSourceProvider>();
  kvStoreBasedDataSources = new Map<string, KvStoreBasedDataSourceProvider>();
  autoDetectRegistry = new AutoDetectRegistry();

  register(provider: DataSourceProvider) {
    this.dataSources.set(provider.scheme, provider);
  }
  registerKvStoreBasedProvider(provider: KvStoreBasedDataSourceProvider) {
    this.kvStoreBasedDataSources.set(provider.scheme, provider);
  }

  getProvider(url: string): [DataSourceProvider, string, string] {
    const m = url.match(schemePattern);
    if (m === null || m[1] === undefined) {
      throw new Error(
        `Data source URL must have the form "<scheme>://<path>".`,
      );
    }
    const [, providerScheme, providerUrl] = m;
    const factory = this.dataSources.get(providerScheme);
    if (factory === undefined) {
      throw new Error(
        `Unsupported data source: ${JSON.stringify(providerScheme)}.`,
      );
    }
    return [factory, providerUrl, providerScheme];
  }

  private async autoDetectFormat(options: GetDataSourceOptionsBase) {
    const { matches, url } = await autoDetectFormat({
      url: options.url,
      kvStoreContext: this.sharedKvStoreContext.kvStoreContext,
      signal: options.signal,
      progressListener: options.progressListener,
      autoDetectDirectory: () => this.autoDetectRegistry.directorySpec,
      autoDetectFile: () => this.autoDetectRegistry.fileSpec,
    });
    if (matches.length !== 1) {
      let message: string;
      if (matches.length === 0) {
        message = "no format detected";
      } else {
        message = `multiple formats detected: ${JSON.stringify(matches)}`;
      }
      throw new Error(
        `Failed to auto-detect data source for ${JSON.stringify(options.url)}: ${message}`,
      );
    }
    return `${url}|${matches[0].suffix}`;
  }

  private async resolveKvStoreBasedDataSource(
    options: GetDataSourceOptionsBase,
  ): Promise<DataSourceLookupResult> {
    while (true) {
      const finalPart = parsePipelineUrlComponent(
        finalPipelineUrlComponent(options.url),
      );
      const dataSourceProvider = this.kvStoreBasedDataSources.get(
        finalPart.scheme,
      );
      if (dataSourceProvider === undefined) {
        // Attempt to auto-detect format.
        const newUrl = await this.autoDetectFormat(options);
        options = { ...options, url: newUrl };
        continue;
      }
      return await dataSourceProvider.get({
        registry: this,
        url: finalPart,
        kvStoreUrl: options.url.substring(
          0,
          options.url.length - finalPart.url.length - 1,
        ),
        signal: options.signal,
        progressListener: options.progressListener,
        state: options.state,
      });
    }
  }

  private async resolvePipeline(
    options: GetDataSourceOptionsBase,
  ): Promise<DataSourceLookupResult> {
    const pipelineParts = splitPipelineUrl(options.url);

    const basePart = pipelineParts[0];
    const baseScheme = basePart.scheme;

    // Check kvstore providers
    {
      const provider =
        this.sharedKvStoreContext.kvStoreContext.baseKvStoreProviders.get(
          baseScheme,
        );
      if (provider !== undefined) {
        return await this.resolveKvStoreBasedDataSource(options);
      }
    }

    if (pipelineParts.length !== 1) {
      throw new Error(`${baseScheme}: scheme does not support | URL pipelines`);
    }

    const suffix = basePart.suffix ?? "";
    if (!suffix.startsWith("//")) {
      throw new Error(`${baseScheme}: URLs must start with "${baseScheme}://"`);
    }

    const providerUrl = suffix.substring(2);

    // Check non-kvstore-based providers
    {
      const provider = this.dataSources.get(baseScheme);
      if (provider !== undefined) {
        return await provider.get({
          ...options,
          url: pipelineParts[0].url,
          providerScheme: baseScheme,
          providerUrl,
          registry: this,
          signal: options.signal ?? new AbortController().signal,
        });
      }
    }

    throw new Error(`Unsupported scheme: ${baseScheme}:`);
  }

  async get(
    options: GetDataSourceOptionsBase,
  ): Promise<DataSourceWithRedirectInfo> {
    const redirectLog = new Set<string>();
    let url: string = options.url;
    url = url.trim();
    // Trim any trailing "|" characters.
    url = url.replace(/\|+$/, "");
    let originalCanonicalUrl: string | undefined;
    while (true) {
      redirectLog.add(url);
      const dataSource = await this.resolvePipeline({ ...options, url });
      if (originalCanonicalUrl === undefined) {
        originalCanonicalUrl = dataSource.canonicalUrl;
      }
      if ("targetUrl" in dataSource) {
        const { targetUrl } = dataSource;
        if (redirectLog.has(targetUrl)) {
          throw Error(
            `Layer source redirection contains loop: ${JSON.stringify([
              ...redirectLog,
              targetUrl,
            ])}`,
          );
        }
        if (redirectLog.size >= 10) {
          throw Error(
            `Too many layer source redirections: ${JSON.stringify([
              ...redirectLog,
              targetUrl,
            ])}`,
          );
        }
        url = targetUrl;
        continue;
      }
      return { ...dataSource, redirectLog, originalCanonicalUrl };
    }
  }

  // Converts legacy precomputed mesh and skeleton datasource URLs.
  convertLegacyUrl(options: ConvertLegacyUrlOptionsBase): string {
    try {
      const [provider, providerUrl, providerScheme] = this.getProvider(
        options.url,
      );
      if (provider.convertLegacyUrl === undefined) return options.url;
      return provider.convertLegacyUrl({
        ...options,
        providerUrl,
        providerScheme: providerScheme,
        registry: this,
      });
    } catch {
      return options.url;
    }
  }

  async completeUrl(
    options: CompleteUrlOptionsBase,
  ): Promise<CompletionResult> {
    // Check if url matches a scheme.  Note that schemePattern always matches.
    const { signal } = options;

    const { url } = options;

    const finalComponent = finalPipelineUrlComponent(url);
    const parsedFinalComponent = parsePipelineUrlComponent(finalComponent);
    const { scheme } = parsedFinalComponent;

    // Check if we need to complete a scheme.
    if (
      finalComponent === url &&
      !(parsedFinalComponent.suffix ?? "").startsWith("//")
    ) {
      const providers: {
        scheme: string;
        description?: string;
      }[] = [];
      const add = <Provider extends { scheme: string; description?: string }>(
        iterable: Iterable<Provider>,
        predicate?: (provider: Provider) => boolean,
      ) => {
        for (const provider of iterable) {
          if (predicate?.(provider) === false) continue;
          providers.push(provider);
        }
      };

      if (finalComponent === url) {
        add(
          this.sharedKvStoreContext.kvStoreContext.baseKvStoreProviders.values(),
        );
        add(this.dataSources.values(), (provider) => provider.hidden !== true);
      } else {
        add(this.kvStoreBasedDataSources.values());
        add(
          this.sharedKvStoreContext.kvStoreContext.kvStoreAdapterProviders.values(),
        );
      }

      const schemeSuffix = finalComponent === url ? "//" : "";
      return {
        offset: url.length - finalComponent.length,
        completions: getPrefixMatchesWithDescriptions(
          scheme,
          providers,
          ({ scheme }) => `${scheme}:${schemeSuffix}`,
          ({ description }) => description,
        ),
      };
    }

    if (parsedFinalComponent.suffix === undefined) {
      const prevPipelineUrl = options.url.substring(
        0,
        options.url.length - finalComponent.length - 1,
      );
      const { matches } = await autoDetectFormat({
        url: prevPipelineUrl,
        kvStoreContext: this.sharedKvStoreContext.kvStoreContext,
        signal: options.signal,
        progressListener: options.progressListener,
        autoDetectDirectory: () => this.autoDetectRegistry.directorySpec,
        autoDetectFile: () => this.autoDetectRegistry.fileSpec,
      });
      if (matches.length === 0) {
        throw new Error(
          `Failed to auto-detect data source for ${JSON.stringify(prevPipelineUrl)}`,
        );
      }
      return {
        offset: url.length - finalComponent.length,
        completions: getPrefixMatchesWithDescriptions(
          parsedFinalComponent.scheme,
          matches,
          ({ suffix }) => suffix,
          ({ description }) => description,
        ),
      };
    }

    if (finalComponent === url) {
      // Single component pipeline.
      const provider = this.dataSources.get(scheme);
      if (provider !== undefined) {
        // Non-kvstore-based protocol.
        if (provider.completeUrl === undefined) return emptyCompletionResult;
        const completions = await provider.completeUrl({
          registry: this,
          url: options.url,
          providerUrl: parsedFinalComponent.suffix!.substring(2),
          signal: signal ?? new AbortController().signal,
          progressListener: options.progressListener,
        });
        return applyCompletionOffset(scheme.length + 3, completions);
      }
    }

    {
      const provider = this.kvStoreBasedDataSources.get(scheme);
      if (provider !== undefined) {
        if (provider.completeUrl === undefined) return emptyCompletionResult;
        const completions = await provider.completeUrl({
          registry: this,
          signal: signal ?? new AbortController().signal,
          progressListener: options.progressListener,
          kvStoreUrl: url.substring(0, url.length - finalComponent.length - 1),
          url: parsedFinalComponent,
        });
        return applyCompletionOffset(
          url.length -
            finalComponent.length +
            parsedFinalComponent.scheme.length +
            1,
          completions,
        );
      }
    }

    return await getKvStoreCompletions(this.sharedKvStoreContext, {
      url,
      signal,
      progressListener: options.progressListener,
      autoDetectDirectory: () => this.autoDetectRegistry.directorySpec,
    });
  }

  suggestLayerName(url: string): string | undefined {
    const parts = splitPipelineUrl(url);
    for (let i = parts.length - 1; i >= 0; --i) {
      let { suffix } = parts[i];
      if (!suffix) continue;
      suffix = suffix.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!suffix) continue;
      return suggestLayerNameBasedOnSeparator(suffix);
    }
    return undefined;
  }
}

export class KvStoreBasedDataSourceLegacyUrlAdapter
  implements DataSourceProvider
{
  constructor(
    public base: KvStoreBasedDataSourceProvider,
    public scheme = base.scheme,
  ) {}

  get hidden() {
    return true;
  }

  get description() {
    return this.base.description;
  }

  private parseProviderUrl(url: string) {
    if (url.includes("|")) {
      throw new Error("Only a single pipeline component supported");
    }
    const { base, queryAndFragment } = extractQueryAndFragment(url);
    return {
      kvStoreUrl: base,
      queryAndFragment,
      url: parsePipelineUrlComponent(`${this.base.scheme}:${queryAndFragment}`),
    };
  }

  get(options: GetDataSourceOptions): Promise<DataSourceLookupResult> {
    const { kvStoreUrl, url } = this.parseProviderUrl(options.providerUrl);
    return this.base.get({
      registry: options.registry,
      url,
      kvStoreUrl,
      state: options.state,
      signal: options.signal,
      progressListener: options.progressListener,
    });
  }

  async completeUrl(options: CompleteUrlOptions): Promise<CompletionResult> {
    const { kvStoreUrl, url, queryAndFragment } = this.parseProviderUrl(
      options.providerUrl,
    );
    if (queryAndFragment === "") {
      return await getKvStoreCompletions(
        options.registry.sharedKvStoreContext,
        {
          url: options.providerUrl,
          signal: options.signal,
          progressListener: options.progressListener,
          singlePipelineComponent: true,
          directoryOnly: this.base.expectsDirectory,
        },
      );
    }
    if (!this.base.completeUrl) return emptyCompletionResult;
    return this.base.completeUrl({
      registry: options.registry,
      signal: options.signal,
      progressListener: options.progressListener,
      kvStoreUrl,
      url,
    });
  }
}
