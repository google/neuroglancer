/**
 * @license
 * Copyright 2025 Google Inc.
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
import {
  getCredentialsWithStatus,
  monitorAuthPopupWindow,
} from "#src/credentials_provider/interactive_credentials_provider.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { raceWithAbort } from "#src/util/abort.js";
import { fetchOk } from "#src/util/http_request.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

interface SsaConfiguration {
  issuer: string;
  authorizationUrl: string;
  // Optional field to allow the SSA deployment to specify a dedicated popup endpoint.
  popupAuthorizationUrl?: string;
}

interface SsaPopupAuthResult {
  access_token: string;
  token_type: string;
  email?: string;
}

function parseSsaConfiguration(json: unknown): SsaConfiguration {
  const obj = verifyObject(json);
  const issuer = verifyObjectProperty(obj, "issuer", verifyString);
  const authorizationUrl = verifyObjectProperty(
    obj,
    "authorization_url",
    verifyString,
  );
  const popupAuthorizationUrl = verifyOptionalObjectProperty(
    obj,
    "popup_authorization_url",
    verifyString,
  );
  return { issuer, authorizationUrl, popupAuthorizationUrl };
}

async function discoverSsaConfiguration(workerOrigin: string): Promise<SsaConfiguration> {
  const response = await fetchOk(`${workerOrigin}/.well-known/ssa-configuration`);
  const config = parseSsaConfiguration(await response.json());
  return config;
}

async function waitForPopupAuthMessage(
  expectedOrigin: string,
  source: Window,
  signal: AbortSignal,
): Promise<SsaPopupAuthResult> {
  return new Promise((resolve, reject) => {
    window.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (event.source !== source) return;
        if (event.origin !== expectedOrigin) return;
        try {
          const data = verifyObject(event.data);
          const access_token = verifyObjectProperty(data, "access_token", verifyString);
          const token_type = verifyObjectProperty(data, "token_type", verifyString);
          const email = verifyOptionalObjectProperty(data, "email", verifyString);
          resolve({ access_token, token_type, email });
        } catch (e) {
          reject(
            new Error(
              `Received unexpected SSA authentication response: ${(e as Error).message}`,
            ),
          );
        }
      },
      { signal },
    );
  });
}

function openPopupCentered(url: string, width: number, height: number) {
  const top =
    window.outerHeight - window.innerHeight + window.innerHeight / 2 - height / 2;
  const left = window.innerWidth / 2 - width / 2;
  const popup = window.open(
    url,
    undefined,
    `toolbar=no, menubar=no, width=${width}, height=${height}, top=${top}, left=${left}`,
  );
  if (popup === null) {
    throw new Error("Failed to create authentication popup window");
  }
  return popup;
}

export class SsaCredentialsProvider extends CredentialsProvider<OAuth2Credentials> {
  constructor(public readonly workerOrigin: string) {
    super();
    try {
      // Throws if invalid URL.
      const parsed = new URL(workerOrigin);
      if (parsed.origin !== workerOrigin) {
        throw new Error("workerOrigin must be an origin like https://host");
      }
    } catch (e) {
      throw new Error(`Invalid worker origin ${JSON.stringify(workerOrigin)}`, {
        cause: e,
      });
    }
  }

  get = makeCredentialsGetter(async (options) => {
    using _span = new ProgressSpan(options.progressListener, {
      message: `Requesting SSA login via ${this.workerOrigin}`,
    });

    const config = await discoverSsaConfiguration(this.workerOrigin);
    const popupUrl = config.popupAuthorizationUrl ?? config.authorizationUrl;

    return await getCredentialsWithStatus<OAuth2Credentials>(
      {
        description: `SSA at ${this.workerOrigin}`,
        requestDescription: "login",
        get: async (signal, _immediate) => {
          // For SSA, we do not support a silent/iframe flow; immediate just attempts a direct
          // load of the authorization page and the worker may choose to complete without user
          // interaction if a session is present.
          const abortController = new AbortController();
          signal = AbortSignal.any([abortController.signal, signal]);
          try {
            const popup = openPopupCentered(popupUrl, 450, 700);
            monitorAuthPopupWindow(popup, abortController);
            const result = await raceWithAbort(
              waitForPopupAuthMessage(this.workerOrigin, popup, abortController.signal),
              signal,
            );
            return {
              tokenType: result.token_type,
              accessToken: result.access_token,
              email: result.email,
            };
          } finally {
            abortController.abort();
          }
        },
      },
      options.signal,
    );
  });
}
