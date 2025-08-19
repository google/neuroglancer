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

import type {
  CredentialsManager,
  CredentialsProvider,
} from "#src/credentials_provider/index.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { fetchOkWithOAuth2CredentialsAdapter } from "#src/credentials_provider/oauth2.js";
import { isGlobusEnabled } from "#src/datasource/globus/register_credentials_provider.js";
import type { BaseKvStoreProvider } from "#src/kvstore/context.js";
import { HttpKvStore } from "#src/kvstore/http/index.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry } from "#src/kvstore/register.js";
import { getBaseHttpUrlAndPath } from "#src/kvstore/url.js";

function getGlobusCredentialsProvider(
  credentialsManager: CredentialsManager,
  url: string,
): CredentialsProvider<OAuth2Credentials> {
  return credentialsManager.getCredentialsProvider("globus", new URL(url));
}

const SCHEME_PREFIX = "globus+";

function globusProvider(
  scheme: string,
  context: SharedKvStoreContextBase,
): BaseKvStoreProvider {
  return {
    scheme: SCHEME_PREFIX + scheme,
    description: `Globus Connect Server via ${scheme}`,
    getKvStore(url) {
      const httpUrl = url.url.substring(SCHEME_PREFIX.length);
      const credentialsProvider = getGlobusCredentialsProvider(
        context.credentialsManager,
        httpUrl,
      );
      try {
        const { baseUrl, path } = getBaseHttpUrlAndPath(httpUrl);
        return {
          store: new HttpKvStore(
            context.chunkManager.memoize,
            baseUrl,
            SCHEME_PREFIX + baseUrl,
            fetchOkWithOAuth2CredentialsAdapter(credentialsProvider),
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

if (isGlobusEnabled()) {
  frontendBackendIsomorphicKvStoreProviderRegistry.registerBaseKvStoreProvider(
    (context) => globusProvider("https", context),
  );
}
