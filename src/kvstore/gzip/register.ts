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

import type { KvStoreAdapterProvider } from "#src/kvstore/context.js";
import { GzipKvStore, registerAutoDetect } from "#src/kvstore/gzip/index.js";
import { KvStoreFileHandle } from "#src/kvstore/index.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry } from "#src/kvstore/register.js";
import { ensureEmptyUrlSuffix } from "#src/kvstore/url.js";

function gzipProvider(
  scheme: string,
  format: CompressionFormat,
): KvStoreAdapterProvider {
  return {
    scheme,
    description: `transparent ${scheme} decoding`,
    getKvStore(url, base) {
      ensureEmptyUrlSuffix(url);
      return {
        store: new GzipKvStore(
          new KvStoreFileHandle(base.store, base.path),
          scheme,
          format,
        ),
        path: "",
      };
    },
  };
}

frontendBackendIsomorphicKvStoreProviderRegistry.registerKvStoreAdapterProvider(
  () => gzipProvider("gzip", "gzip"),
);

registerAutoDetect(
  frontendBackendIsomorphicKvStoreProviderRegistry.autoDetectRegistry,
);
