/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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
  AnonymousFirstCredentialsProvider,
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import { getCredentialsWithStatus } from "#src/credentials_provider/interactive_credentials_provider.js";
import type { DVIDToken } from "#src/datasource/dvid/api.js";
import { fetchOk } from "#src/util/http_request.js";

async function getAuthToken(
  authServer: string,
  abortSignal: AbortSignal,
): Promise<DVIDToken> {
  const response = await fetchOk(authServer, {
    method: "GET",
    credentials: "include",
    signal: abortSignal,
  });
  const token = await response.text();
  return { token };
}

class BaseDVIDCredentialsProvider extends CredentialsProvider<DVIDToken> {
  constructor(public authServer: string | undefined) {
    super();
  }

  get = makeCredentialsGetter(async (abortSignal) => {
    const { authServer } = this;
    if (!authServer) return { token: "" };
    return await getCredentialsWithStatus(
      {
        description: `DVID server ${this.authServer}`,
        supportsImmediate: true,
        get: async (abortSignal, immediate) => {
          if (immediate) {
            return await getAuthToken(authServer, abortSignal);
          }
          // In the current DVID setup, https://flyemlogin.<domain> is expected for the login server
          const match = authServer.match(/^[^/]+\/\/[^/.]+\.([^/]+)/);
          if (match) {
            const loginServer = `https://flyemlogin.${match[1]}/login`;
            throw new Error(
              `Please log into ${loginServer} and then refresh the neurogalncer page to try again.\nIf you are unable to log into ${loginServer}, please check your authorization server ${authServer} to make sure it is correct.`,
            );
          } else {
            throw new Error(
              `Please check your authorization server ${authServer} to make sure it is correct.`,
            );
          }
        },
      },
      abortSignal,
    );
  });
}

export class DVIDCredentialsProvider extends AnonymousFirstCredentialsProvider<DVIDToken> {
  constructor(_dvidServer: string, authServer: string | undefined) {
    super(new BaseDVIDCredentialsProvider(authServer), {});
  }
}
