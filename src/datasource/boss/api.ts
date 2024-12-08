/**
 * @license
 * Copyright 2017 Google Inc.
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

export type BossToken = string;

/**
 * Key used for retrieving the CredentialsProvider from a CredentialsManager.
 */
export const credentialsKey = "boss";

export async function fetchWithBossCredentials(
  credentialsProvider: CredentialsProvider<BossToken>,
  input: RequestInfo,
  init: RequestInit,
): Promise<Response> {
  return fetchOk(input, init).catch((error) => {
    if (
      error.status !== 500 &&
      error.status !== 401 &&
      error.status !== 403 &&
      error.status !== 504
    ) {
      // Prevent an infinite loop of error = 0 where the request
      // has been cancelled
      throw error;
    }
    return fetchWithCredentials(
      credentialsProvider,
      input,
      init,
      (credentials) => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${credentials}`);
        return { ...init, headers };
      },
      (error) => {
        const { status } = error;
        if (status === 403 || status === 401) {
          // Authorization needed.  Retry with refreshed token.
          return "refresh";
        }
        throw error;
      },
    );
  });
}
