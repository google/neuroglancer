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

import type { BaseKvStoreProvider } from "#src/kvstore/context.js";
import { HttpKvStore } from "#src/kvstore/http/index.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry } from "#src/kvstore/register.js";
import { getBaseHttpUrlAndPath } from "#src/kvstore/url.js";

function httpProvider(
  scheme: string,
  sharedKvStoreContext: SharedKvStoreContextBase,
): BaseKvStoreProvider {
  return {
    scheme,
    description: `${scheme} (unauthenticated)`,
    getKvStore(url) {
      try {
        const { baseUrl, path } = getBaseHttpUrlAndPath(url.url);
        return {
          store: new HttpKvStore(
            sharedKvStoreContext.chunkManager.memoize,
            baseUrl,
          ),
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

for (const httpScheme of ["http", "https"]) {
  frontendBackendIsomorphicKvStoreProviderRegistry.registerBaseKvStoreProvider(
    (context) => httpProvider(httpScheme, context),
  );
}
