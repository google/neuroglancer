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
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry } from "#src/kvstore/register.js";

import { S3KvStore } from "#src/kvstore/s3/index.js";

function s3Provider(_context: SharedKvStoreContextBase): BaseKvStoreProvider {
  return {
    scheme: "s3",
    description: "S3 (anonymous)",
    getKvStore(url) {
      const m = (url.suffix ?? "").match(/^\/\/([^/]+)(\/.*)?$/);
      if (m === null) {
        throw new Error("Invalid URL, expected `s3://<bucket>/<path>`");
      }
      const [, bucket, path] = m;
      return {
        store: new S3KvStore(
          `https://${bucket}.s3.amazonaws.com/`,
          `s3://${bucket}/`,
        ),
        path: decodeURIComponent((path ?? "").substring(1)),
      };
    },
  };
}

frontendBackendIsomorphicKvStoreProviderRegistry.registerBaseKvStoreProvider(
  s3Provider,
);
