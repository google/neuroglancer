/**
 * @license
 * Copyright 2024 Google Inc.
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

import { AutoDetectRegistry } from "#src/kvstore/auto_detect.js";
import type {
  KvStoreWithPath,
  ListResponse,
  ReadResponse,
  ReadOptions,
  ListOptions,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { listKvStore, readKvStore } from "#src/kvstore/index.js";
import type { UrlWithParsedScheme } from "#src/kvstore/url.js";
import { resolveRelativePath, splitPipelineUrl } from "#src/kvstore/url.js";
import type {
  BasicCompletionResult,
  CompletionWithDescription,
} from "#src/util/completion.js";

export type CompletionResult = BasicCompletionResult<CompletionWithDescription>;

export interface BaseKvStoreProvider {
  scheme: string;
  hidden?: boolean;
  description?: string;
  getKvStore(parsedUrl: UrlWithParsedScheme): KvStoreWithPath;
}

export interface KvStoreAdapterProvider {
  scheme: string;
  hidden?: boolean;
  description?: string;
  getKvStore(
    parsedUrl: UrlWithParsedScheme,
    base: KvStoreWithPath,
  ): KvStoreWithPath;
}

export class KvStoreContext {
  baseKvStoreProviders = new Map<string, BaseKvStoreProvider>();
  kvStoreAdapterProviders = new Map<string, KvStoreAdapterProvider>();
  autoDetectRegistry = new AutoDetectRegistry();

  getKvStore(url: string): KvStoreWithPath {
    const pipeline = splitPipelineUrl(url);
    let kvStore: KvStoreWithPath;
    {
      const basePart = pipeline[0];
      const provider = this.baseKvStoreProviders.get(basePart.scheme);
      if (provider === undefined) {
        const usage = this.describeProtocolUsage(basePart.scheme);
        let message = `Invalid base kvstore protocol "${basePart.scheme}:"`;
        if (usage !== undefined) {
          message += `; ${usage}`;
        }
        throw new Error(message);
      }
      kvStore = provider.getKvStore(basePart);
    }

    for (let i = 1; i < pipeline.length; ++i) {
      const part = pipeline[i];
      const provider = this.kvStoreAdapterProviders.get(part.scheme);
      if (provider === undefined) {
        const usage = this.describeProtocolUsage(part.scheme);
        let message = `Invalid kvstore adapter protocol "${part.scheme}:" in ${JSON.stringify(url)}`;
        if (usage !== undefined) {
          message += `; ${usage}`;
        }
        throw new Error(message);
      }
      kvStore = provider.getKvStore(part, kvStore);
    }
    return kvStore;
  }

  // Describes valid uses of `protocol`, for error messages indicating an
  // invalid protocol.  If the protocol is unknown, returns `undefined`.
  describeProtocolUsage(protocol: string): string | undefined {
    if (this.baseKvStoreProviders.has(protocol)) {
      return `"${protocol}:" may only be used as a base kvstore protocol`;
    }
    if (this.kvStoreAdapterProviders.has(protocol)) {
      return `"${protocol}:" may only be used as a kvstore adapter protocol`;
    }
    return undefined;
  }

  stat(
    url: string,
    options: StatOptions = {},
  ): Promise<StatResponse | undefined> {
    const kvStore = this.getKvStore(url);
    return kvStore.store.stat(kvStore.path, options);
  }

  read(
    url: string,
    options: ReadOptions & { throwIfMissing: true },
  ): Promise<ReadResponse>;

  read(url: string, options?: ReadOptions): Promise<ReadResponse | undefined>;

  read(
    url: string,
    options: ReadOptions = {},
  ): Promise<ReadResponse | undefined> {
    const kvStore = this.getKvStore(url);
    return readKvStore(kvStore.store, kvStore.path, options);
  }

  list(urlPrefix: string, options: ListOptions = {}): Promise<ListResponse> {
    const kvStore = this.getKvStore(urlPrefix);
    return listKvStore(kvStore.store, kvStore.path, options);
  }

  resolveRelativePath(baseUrl: string, relativePath: string): string {
    const kvStore = this.getKvStore(baseUrl);
    return kvStore.store.getUrl(
      resolveRelativePath(kvStore.path, relativePath),
    );
  }
}
