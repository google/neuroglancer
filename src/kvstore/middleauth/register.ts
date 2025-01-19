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
import type { BaseKvStoreProvider } from "#src/kvstore/context.js";
import { getBaseUrlAndPath, HttpKvStore } from "#src/kvstore/http/index.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry } from "#src/kvstore/register.js";

const SCHEME_PREFIX = "middleauth+";

function getMiddleAuthCredentialsProvider(
  credentialsManager: CredentialsManager,
  url: string,
): CredentialsProvider<OAuth2Credentials> {
  return credentialsManager.getCredentialsProvider(
    "middleauthapp",
    new URL(url).origin,
  );
}

function middleauthProvider(
  scheme: string,
  context: SharedKvStoreContextBase,
): BaseKvStoreProvider {
  return {
    scheme: SCHEME_PREFIX + scheme,
    description: `${scheme} with middleauth`,
    getKvStore(url) {
      const httpUrl = url.url.substring(SCHEME_PREFIX.length);
      const credentialsProvider = getMiddleAuthCredentialsProvider(
        context.credentialsManager,
        httpUrl,
      );
      try {
        const { baseUrl, path } = getBaseUrlAndPath(httpUrl);
        return {
          store: new HttpKvStore(
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

frontendBackendIsomorphicKvStoreProviderRegistry.registerBaseKvStoreProvider(
  (context) => middleauthProvider("https", context),
);
