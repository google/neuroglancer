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
import { OcdbtKvStore } from "#src/kvstore/ocdbt/backend.js";
import { completeOcdbtUrl } from "#src/kvstore/ocdbt/complete_url.js";
import { parseOcdbtUrl } from "#src/kvstore/ocdbt/url.js";

function ocdbtProvider(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
): KvStoreAdapterProvider {
  return {
    scheme: "ocdbt",
    description: "OCDBT database",
    getKvStore(parsedUrl, base) {
      const { baseUrl, version, path } = parseOcdbtUrl(parsedUrl, base);
      return {
        store: new OcdbtKvStore(sharedKvStoreContext, baseUrl, version),
        path,
      };
    },

    completeUrl(options) {
      return completeOcdbtUrl(sharedKvStoreContext, options);
    },
  };
}

backendOnlyKvStoreProviderRegistry.registerKvStoreAdapterProvider(
  ocdbtProvider,
);
