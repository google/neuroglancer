/**
 * @license
 * Copyright 2023 Google Inc.
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

import type { BaseKvStoreProvider } from "#src/kvstore/context.js";
import { read, stat } from "#src/kvstore/http/read.js";
import type {
  KvStore,
  DriverReadOptions,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import type {
  KvStoreProviderRegistry,
  SharedKvStoreContextBase,
} from "#src/kvstore/register.js";
import { getBaseHttpUrlAndPath, joinBaseUrlAndPath } from "#src/kvstore/url.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk } from "#src/util/http_request.js";

export class ReadableHttpKvStore<
  SharedKvStoreContext extends SharedKvStoreContextBase,
> implements KvStore
{
  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    public baseUrl: string,
    public baseUrlForDisplay: string = baseUrl,
    public fetchOkImpl: FetchOk = fetchOk,
  ) {}

  stat(key: string, options: StatOptions): Promise<StatResponse | undefined> {
    return stat(
      this,
      key,
      joinBaseUrlAndPath(this.baseUrl, key),
      options,
      this.fetchOkImpl,
    );
  }

  read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    return read(
      this,
      key,
      joinBaseUrlAndPath(this.baseUrl, key),
      options,
      this.fetchOkImpl,
    );
  }

  getUrl(path: string) {
    return joinBaseUrlAndPath(this.baseUrlForDisplay, path);
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}

function httpProvider<SharedKvStoreContext extends SharedKvStoreContextBase>(
  scheme: string,
  sharedKvStoreContext: SharedKvStoreContext,
  httpKvStoreClass: typeof ReadableHttpKvStore<SharedKvStoreContext>,
): BaseKvStoreProvider {
  return {
    scheme,
    description: `${scheme} (unauthenticated)`,
    getKvStore(url) {
      try {
        const { baseUrl, path } = getBaseHttpUrlAndPath(url.url);
        return {
          store: new httpKvStoreClass(sharedKvStoreContext, baseUrl),
          path,
        };
      } catch (e) {
        throw new Error(`Invalid URL ${JSON.stringify(url.url)}`, {
          cause: e,
        });
      }
    },
  };
}

export function registerProviders<
  SharedKvStoreContext extends SharedKvStoreContextBase,
>(
  registry: KvStoreProviderRegistry<SharedKvStoreContext>,
  httpKvStoreClass: typeof ReadableHttpKvStore<SharedKvStoreContext>,
) {
  for (const httpScheme of ["http", "https"]) {
    registry.registerBaseKvStoreProvider((context) =>
      httpProvider(httpScheme, context, httpKvStoreClass),
    );
  }
}
