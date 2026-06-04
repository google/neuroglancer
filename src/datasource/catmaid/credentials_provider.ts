/**
 * @license
 * Copyright 2026 Google Inc.
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

import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import { getCredentialsWithStatus } from "#src/credentials_provider/interactive_credentials_provider.js";
import type { CatmaidToken } from "#src/datasource/catmaid/api.js";
import { fetchOk } from "#src/util/http_request.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

async function getAnonymousToken(
  serverUrl: string,
  signal: AbortSignal,
): Promise<CatmaidToken> {
  // serverUrl passed here is the base URL.

  const tokenUrl = `${serverUrl}/accounts/anonymous-api-token`;

  const response = await fetchOk(tokenUrl, {
    method: "GET",
    signal: signal,
  });

  const json = await response.json();
  if (
    typeof json === "object" &&
    json !== null &&
    typeof json.token === "string"
  ) {
    return { token: json.token };
  }
  throw new Error(
    `Unexpected response from ${tokenUrl}: ${JSON.stringify(json)}`,
  );
}

export class CatmaidCredentialsProvider extends CredentialsProvider<CatmaidToken> {
  constructor(public serverUrl: string) {
    super();
  }

  get = makeCredentialsGetter(async (options) => {
    using _span = new ProgressSpan(options.progressListener, {
      message: `Requesting CATMAID access token from ${this.serverUrl}`,
    });
    return await getCredentialsWithStatus(
      {
        description: `CATMAID server ${this.serverUrl}`,
        supportsImmediate: true,
        get: async (signal, immediate) => {
          if (immediate) {
            return await getAnonymousToken(this.serverUrl, signal);
          }
          return await getAnonymousToken(this.serverUrl, signal);
        },
      },
      options.signal,
    );
  });
}
