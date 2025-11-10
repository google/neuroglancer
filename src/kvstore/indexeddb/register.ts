/**
 * @license
 * Copyright 2025
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
import { frontendOnlyKvStoreProviderRegistry } from "#src/kvstore/frontend.js";
import type { KvStoreWithPath } from "#src/kvstore/index.js";
import { IndexedDBKvStore } from "#src/kvstore/indexeddb/implementation.js";
import type { UrlWithParsedScheme } from "#src/kvstore/url.js";

function getProvider(): BaseKvStoreProvider {
  return {
    scheme: "local",
    description: "Stockage local dans le navigateur (IndexedDB)",
    getKvStore(parsedUrl: UrlWithParsedScheme): KvStoreWithPath {
      const suffix = parsedUrl.suffix;
      if (suffix === undefined) {
        throw new Error("local:// URL must include database and store names, e.g., local://db/store");
      }
      // Expect suffix to start with //db/store[/path]
      const m = suffix.match(/^\/\/([^\/]*)\/([^\/]*)(?:\/(.*))?$/);
      if (m === null) {
        throw new Error(`Invalid local URL suffix ${JSON.stringify(suffix)}; expected local://<database>/<store>[/path]`);
      }
      const databaseName = decodeURIComponent(m[1]);
      const storeName = decodeURIComponent(m[2]);
      const path = m[3] !== undefined ? decodeURIComponent(m[3]) : "";
      return { store: new IndexedDBKvStore(databaseName, storeName), path };
    },
  };
}

frontendOnlyKvStoreProviderRegistry.registerBaseKvStoreProvider(() => getProvider());
