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
import type {
  CredentialsManager,
  CredentialsProvider,
} from "#src/credentials_provider/index.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { fetchOkWithOAuth2CredentialsAdapter } from "#src/credentials_provider/oauth2.js";
import type { BaseKvStoreProvider } from "#src/kvstore/context.js";
import { GcsKvStore } from "#src/kvstore/gcs/index.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry } from "#src/kvstore/register.js";

function getNgauthCredentialsProvider(
  credentialsManager: CredentialsManager,
  authServer: string,
  bucket: string,
): CredentialsProvider<OAuth2Credentials> {
  return pythonIntegration
    ? credentialsManager.getCredentialsProvider("gcs", { bucket })
    : credentialsManager.getCredentialsProvider("ngauth_gcs", {
        authServer: authServer,
        bucket,
      });
}

const SCHEME_PREFIX = "gs+ngauth+";

function gcsNgauthProvider(
  scheme: string,
  context: SharedKvStoreContextBase,
): BaseKvStoreProvider {
  return {
    scheme,
    description: pythonIntegration
      ? "Google Cloud Storage"
      : "Google Cloud Storage (ngauth)",
    getKvStore(url) {
      const m = (url.suffix ?? "").match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (m === null) {
        throw new Error(
          `Invalid URL, expected ${url.scheme}://<ngauth-server>/<bucket>/<path>`,
        );
      }
      const [, authHost, bucket, path] = m;
      const authUrl =
        url.scheme.substring(SCHEME_PREFIX.length) + "://" + authHost;
      const credentialsProvider = getNgauthCredentialsProvider(
        context.credentialsManager,
        authUrl,
        bucket,
      );
      return {
        store: new GcsKvStore(
          bucket,
          `${url.scheme}://${authHost}/${bucket}/`,
          fetchOkWithOAuth2CredentialsAdapter(credentialsProvider),
        ),
        path: decodeURIComponent((path ?? "").substring(1)),
      };
    },
  };
}

for (const scheme of ["http", "https"]) {
  frontendBackendIsomorphicKvStoreProviderRegistry.registerBaseKvStoreProvider(
    (context) => gcsNgauthProvider(`${SCHEME_PREFIX}${scheme}`, context),
  );
}
