/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { backendOnlyKvStoreProviderRegistry } from "#src/kvstore/backend.js";
import type { KvStoreAdapterProvider } from "#src/kvstore/context.js";
import { IcechunkKvStore } from "#src/kvstore/icechunk/backend.js";
import { completeIcechunkUrl } from "#src/kvstore/icechunk/complete_url.js";
import { parseIcechunkUrl } from "#src/kvstore/icechunk/url.js";

function icechunkProvider(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
): KvStoreAdapterProvider {
  return {
    scheme: "icechunk",
    description: "Icechunk repository",
    getKvStore(parsedUrl, base) {
      const { baseUrl, version, path } = parseIcechunkUrl(parsedUrl, base);
      return {
        store: new IcechunkKvStore(sharedKvStoreContext, baseUrl, version),
        path,
      };
    },

    completeUrl(options) {
      return completeIcechunkUrl(sharedKvStoreContext, options);
    },
  };
}

backendOnlyKvStoreProviderRegistry.registerKvStoreAdapterProvider(
  icechunkProvider,
);
