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

import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import {
  getCredentialsWithStatus,
  monitorAuthPopupWindow,
} from "#src/credentials_provider/interactive_credentials_provider.js";
import { raceWithAbort } from "#src/util/abort.js";
import { removeFromParent } from "#src/util/dom.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { getRandomHexString } from "#src/util/random.js";

export const EMAIL_SCOPE = "email";
export const OPENID_SCOPE = "openid";

export const AUTH_SERVER = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * OAuth2 Token
 */
export interface OAuth2Token {
  accessToken: string;
  expiresIn: string;
  tokenType: string;
  scope: string;
  email: string | undefined;
}

function extractEmailFromIdToken(idToken: string): string {
  const idTokenParts = idToken.split(".");
  try {
    if (idTokenParts.length !== 3) throw new Error("Invalid JWT format");
    const decoded = atob(idTokenParts[1]);
    const parsed = JSON.parse(decoded);
    verifyObject(parsed);
    return verifyObjectProperty(parsed, "email", verifyString);
  } catch (e) {
    throw new Error(`Failed to decode id token: ${e.message}`);
  }
}

// Note: `abortSignal` is guaranteed to be aborted once the operation completes.
function waitForAuthResponseMessage(
  source: Window,
  state: string,
  abortSignal: AbortSignal,
): Promise<OAuth2Token> {
  return new Promise((resolve, reject) => {
    window.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (event.origin !== location.origin) {
          return;
        }

        if (event.source !== source) return;

        try {
          const obj = verifyObject(event.data);
          const receivedState = verifyObjectProperty(
            obj,
            "state",
            verifyString,
          );
          if (receivedState !== state) {
            throw new Error("invalid state");
          }
          const idToken = verifyObjectProperty(obj, "id_token", verifyString);
          const token: OAuth2Token = {
            accessToken: verifyObjectProperty(
              obj,
              "access_token",
              verifyString,
            ),
            tokenType: verifyObjectProperty(obj, "token_type", verifyString),
            expiresIn: verifyObjectProperty(obj, "expires_in", verifyString),
            scope: verifyObjectProperty(obj, "scope", verifyString),
            email: extractEmailFromIdToken(idToken),
          };
          resolve(token);
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

function makeAuthRequestUrl(options: {
  clientId: string;
  scopes: string[];
  nonce?: string;
  approvalPrompt?: "force" | "auto";
  state?: string;
  loginHint?: string;
  authUser?: number;
  includeGrantedScopes?: boolean;
  immediate?: boolean;
}) {
  let url = `${AUTH_SERVER}?client_id=${encodeURIComponent(options.clientId)}`;
  const redirectUri = new URL("./google_oauth2_redirect.html", import.meta.url)
    .href;
  url += `&redirect_uri=${redirectUri}`;
  let responseType = "token";
  const { scopes } = options;
  if (scopes.includes("email") && scopes.includes("openid")) {
    responseType = "token%20id_token";
  }
  url += `&response_type=${responseType}`;
  if (options.includeGrantedScopes === true) {
    url += "&include_granted_scopes=true";
  }
  url += `&scope=${encodeURIComponent(scopes.join(" "))}`;
  if (options.state) {
    url += `&state=${options.state}`;
  }
  if (options.loginHint) {
    url += `&login_hint=${encodeURIComponent(options.loginHint)}`;
  }
  if (options.immediate) {
    url += "&immediate=true";
  }
  if (options.nonce !== undefined) {
    url += `&nonce=${options.nonce}`;
  }
  if (options.authUser !== undefined) {
    url += `&authuser=${options.authUser}`;
  }
  return url;
}

function createAuthIframe(
  url: string,
  abortController: AbortController,
): Window {
  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.style.display = "none";
  iframe.addEventListener(
    "load",
    () => {
      if (iframe.contentDocument == null) {
        // Error received
        abortController.abort(new Error("Immediate authentication failed"));
      }
    },
    { signal: abortController.signal },
  );
  document.body.appendChild(iframe);
  abortController.signal.addEventListener("abort", () => {
    removeFromParent(iframe);
  });
  return iframe.contentWindow!;
}

/**
 * Obtain a Google OAuth2 authentication token.
 * @return A Promise that resolves to an authentication token.
 */
export async function authenticateGoogleOAuth2(
  options: {
    clientId: string;
    scopes: string[];
    approvalPrompt?: "force" | "auto";
    loginHint?: string;
    immediate?: boolean;
    authUser?: number;
  },
  abortSignal: AbortSignal,
) {
  const state = getRandomHexString();
  const nonce = getRandomHexString();
  const url = makeAuthRequestUrl({
    state,
    nonce,
    clientId: options.clientId,
    scopes: options.scopes,
    approvalPrompt: options.approvalPrompt,
    loginHint: options.loginHint,
    immediate: options.immediate,
    authUser: options.authUser,
  });
  const abortController = new AbortController();
  abortSignal = AbortSignal.any([abortController.signal, abortSignal]);
  try {
    let source: Window;
    if (options.immediate) {
      source = createAuthIframe(url, abortController);
    } else {
      const newWindow = open(url);
      if (newWindow === null) {
        throw new Error("Failed to create authentication popup window");
      }
      monitorAuthPopupWindow(newWindow, abortController);
      source = newWindow!;
    }
    return await raceWithAbort(
      waitForAuthResponseMessage(source, state, abortController.signal),
      abortSignal,
    );
  } finally {
    abortController.abort();
  }
}

export class GoogleOAuth2CredentialsProvider extends CredentialsProvider<OAuth2Token> {
  constructor(
    public options: { clientId: string; scopes: string[]; description: string },
  ) {
    super();
  }

  get = makeCredentialsGetter((abortSignal) =>
    getCredentialsWithStatus(
      {
        description: this.options.description,
        supportsImmediate: true,
        get: (abortSignal, immediate) =>
          authenticateGoogleOAuth2(
            {
              clientId: this.options.clientId,
              scopes: this.options.scopes,
              immediate: immediate,
              authUser: 0,
            },
            abortSignal,
          ),
      },
      abortSignal,
    ),
  );
}
