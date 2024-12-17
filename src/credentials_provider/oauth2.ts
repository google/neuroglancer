/**
 * @license
 * Copyright 2020 Google Inc.
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

import { fetchWithCredentials } from "#src/credentials_provider/http_request.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import { fetchOk } from "#src/util/http_request.js";

/**
 * OAuth2 token
 */
export interface OAuth2Credentials {
  tokenType: string;
  accessToken: string;
  email?: string;
}

export function fetchWithOAuth2Credentials(
  credentialsProvider: CredentialsProvider<OAuth2Credentials> | undefined,
  input: RequestInfo,
  init: RequestInit,
): Promise<Response> {
  if (credentialsProvider === undefined) {
    return fetchOk(input, init);
  }
  return fetchWithCredentials(
    credentialsProvider,
    input,
    init,
    (credentials, init) => {
      if (!credentials.accessToken) return init;
      const headers = new Headers(init.headers);
      headers.set(
        "Authorization",
        `${credentials.tokenType} ${credentials.accessToken}`,
      );
      return { ...init, headers };
    },
    (error, credentials) => {
      const { status } = error;
      if (status === 401) {
        // 401: Authorization needed.  OAuth2 token may have expired.
        return "refresh";
      }
      if (status === 403 && !credentials.accessToken) {
        // Anonymous access denied.  Request credentials.
        return "refresh";
      }
      if (error instanceof Error && credentials.email !== undefined) {
        error.message += `  (Using credentials for ${JSON.stringify(
          credentials.email,
        )})`;
      }
      throw error;
    },
  );
}
