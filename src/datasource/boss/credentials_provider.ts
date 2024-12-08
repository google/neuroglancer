/**
 * @license
 * Copyright 2016 Google Inc.
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

/**
 * @file
 * This implements a CredentialsProvider based on Keycloak.
 */

import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import {
  getCredentialsWithStatus,
  monitorAuthPopupWindow,
} from "#src/credentials_provider/interactive_credentials_provider.js";
import { raceWithAbort } from "#src/util/abort.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { getRandomHexString } from "#src/util/random.js";

export type BossToken = string;

function makeAuthRequestUrl(options: {
  authServer: string;
  clientId: string;
  redirect_uri: string;
  state?: string;
  nonce?: string;
}) {
  let url = `${options.authServer}/realms/BOSS/protocol/openid-connect/auth?`;
  url += `client_id=${encodeURIComponent(options.clientId)}`;
  url += `&redirect_uri=${encodeURIComponent(options.redirect_uri)}`;
  url += "&response_mode=fragment";
  url += "&response_type=code%20id_token%20token";
  if (options.state) {
    url += `&state=${options.state}`;
  }
  if (options.nonce) {
    url += `&nonce=${options.nonce}`;
  }
  return url;
}

function waitForAuthResponseMessage(
  source: Window,
  state: string,
  abortSignal: AbortSignal,
): Promise<BossToken> {
  return new Promise((resolve, reject) => {
    window.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (event.origin !== location.origin) {
          return;
        }

        if (event.source !== source) return;

        try {
          const obj = verifyObject(JSON.parse(event.data));
          if (
            verifyObjectProperty(obj, "service", verifyString) !==
            "bossAuthCallback"
          ) {
            throw new Error("Unexpected service");
          }
          const receivedState = verifyObjectProperty(
            obj,
            "state",
            verifyString,
          );
          if (receivedState !== state) {
            throw new Error("invalid state");
          }
          const accessToken = verifyObjectProperty(
            obj,
            "access_token",
            verifyString,
          );
          resolve(accessToken);
        } catch (parseError) {
          reject(
            new Error(
              `Received unexpected authentication response: ${parseError.message}`,
            ),
          );
          console.error("Response received: ", event.data);
        }
      },
      { signal: abortSignal },
    );
  });
}

/**
 * Obtain a Keycloak OIDC authentication token.
 * @return A Promise that resolves to an authentication token.
 */
export async function authenticateKeycloakOIDC(
  options: { realm: string; clientId: string; authServer: string },
  abortSignal: AbortSignal,
): Promise<BossToken> {
  const state = getRandomHexString();
  const nonce = getRandomHexString();
  const url = makeAuthRequestUrl({
    state: state,
    clientId: options.clientId,
    redirect_uri: new URL("./bossauth.html", import.meta.url).href,
    authServer: options.authServer,
    nonce: nonce,
  });
  const abortController = new AbortController();
  abortSignal = AbortSignal.any([abortController.signal, abortSignal]);
  try {
    const newWindow = open(url);
    if (newWindow === null) {
      throw new Error("Failed to create authentication popup window");
    }
    monitorAuthPopupWindow(newWindow, abortController);
    return await raceWithAbort(
      waitForAuthResponseMessage(newWindow, state, abortController.signal),
      abortSignal,
    );
  } finally {
    abortController.abort();
  }
}

export class BossCredentialsProvider extends CredentialsProvider<BossToken> {
  constructor(public authServer: string) {
    super();
  }

  get = makeCredentialsGetter((abortSignal) =>
    getCredentialsWithStatus(
      {
        description: "Boss",
        get: (signal) =>
          authenticateKeycloakOIDC(
            {
              realm: "boss",
              clientId: "endpoint",
              authServer: this.authServer,
            },
            signal,
          ),
      },
      abortSignal,
    ),
  );
}
