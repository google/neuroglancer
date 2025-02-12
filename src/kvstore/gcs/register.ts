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

import pythonIntegration from "#python_integration_build";
import type { BaseKvStoreProvider } from "#src/kvstore/context.js";
import { GcsKvStore } from "#src/kvstore/gcs/index.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry } from "#src/kvstore/register.js";

function gcsProvider(_context: SharedKvStoreContextBase): BaseKvStoreProvider {
  return {
    scheme: "gs",
    description: pythonIntegration
      ? "Google Cloud Storage"
      : "Google Cloud Storage (anonymous)",
    getKvStore(url) {
      const m = (url.suffix ?? "").match(/^\/\/([^/]+)(\/.*)?$/);
      if (m === null) {
        throw new Error("Invalid URL, expected `gs://<bucket>/<path>`");
      }
      const [, bucket, path] = m;
      return {
        store: new GcsKvStore(bucket),
        path: decodeURIComponent((path ?? "").substring(1)),
      };
    },
  };
}

frontendBackendIsomorphicKvStoreProviderRegistry.registerBaseKvStoreProvider(
  gcsProvider,
);
