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

import type { BaseKvStoreProvider } from "#src/kvstore/context.js";
import type { KvStore } from "#src/kvstore/index.js";
import type {
  KvStoreProviderRegistry,
  SharedKvStoreContextBase,
} from "#src/kvstore/register.js";
import type { UrlWithParsedScheme } from "#src/kvstore/url.js";

function parseOpfsUrlSuffix(suffix: string | undefined): {
  basePath: string;
  path: string;
} {
  // Accept opfs://<path>, opfs:/<path>, or opfs:<path>
  const s = suffix ?? "";
  const m = s.match(/^\/?\/?(.*)$/);
  if (m === null) {
    throw new Error(
      `Invalid opfs URL suffix ${JSON.stringify(s)}; expected opfs://<path>`,
    );
  }
  const decoded = decodeURIComponent(m[1] ?? "");
  // Choose to have basePath be empty and return full path as initial kv path.
  return { basePath: "", path: decoded };
}

export function registerProviders<
  SharedKvStoreContext extends SharedKvStoreContextBase,
>(
  registry: KvStoreProviderRegistry<SharedKvStoreContext>,
  OpfsKvStoreClass: {
    new (sharedKvStoreContext: SharedKvStoreContext, basePath: string): KvStore;
  },
) {
  const provider: (context: SharedKvStoreContext) => BaseKvStoreProvider = (
    sharedKvStoreContext: SharedKvStoreContext,
  ) => ({
    scheme: "opfs",
    description: "Origin Private File System (browser)",
    getKvStore(url: UrlWithParsedScheme) {
      const { basePath, path } = parseOpfsUrlSuffix(url.suffix);
      return {
        store: new OpfsKvStoreClass(sharedKvStoreContext, basePath),
        path,
      };
    },
  });
  registry.registerBaseKvStoreProvider(provider);
}
