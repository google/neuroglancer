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
  makeCachedCredentialsGetter,
} from "#src/credentials_provider/index.js";
import type { CatmaidToken } from "#src/datasource/catmaid/api.js";
import { StatusMessage } from "#src/status.js";
import { scopedAbortCallback } from "#src/util/abort.js";
import { fetchOk } from "#src/util/http_request.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

const CATMAID_TOKEN_STORAGE_PREFIX = "neuroglancer:catmaid:api-token:v1:";

export interface CatmaidTokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function canonicalizeCatmaidServerUrl(serverUrl: string) {
  return serverUrl.replace(/\/+$/, "");
}

export function getCatmaidTokenStorageKey(serverUrl: string) {
  return `${CATMAID_TOKEN_STORAGE_PREFIX}${canonicalizeCatmaidServerUrl(
    serverUrl,
  )}`;
}

function getSessionTokenStorage(): CatmaidTokenStorage | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

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
    return { token: json.token, kind: "anonymous" };
  }
  throw new Error(
    `Unexpected response from ${tokenUrl}: ${JSON.stringify(json)}`,
  );
}

function requestPersonalToken(
  serverUrl: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const status = new StatusMessage(/*delay=*/ false, /*modal=*/ true);
  status.setPreventFocusChangeOnMouseDown(false);

  const form = document.createElement("form");
  const instructions = document.createElement("p");
  instructions.append(
    `A personal CATMAID API token is required for ${serverUrl}. `,
  );
  const serverLink = document.createElement("a");
  serverLink.href = serverUrl;
  serverLink.target = "_blank";
  serverLink.rel = "noopener noreferrer";
  serverLink.textContent = "Open CATMAID";
  instructions.append(
    serverLink,
    " and use the account menu to obtain an API token.",
  );
  form.appendChild(instructions);

  const label = document.createElement("label");
  label.textContent = "API token: ";
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "CATMAID API token");
  label.appendChild(input);
  form.appendChild(label);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Use token";
  form.appendChild(submit);

  const error = document.createElement("span");
  error.setAttribute("role", "alert");
  form.appendChild(error);
  status.element.replaceChildren(form);
  status.setVisible(true);

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const abortCleanup = scopedAbortCallback(signal, (reason) => {
    status.dispose();
    reject(reason);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = input.value.trim();
    if (token.length === 0) {
      error.textContent = " Enter a non-empty API token.";
      input.focus();
      return;
    }
    abortCleanup?.[Symbol.dispose]();
    status.dispose();
    resolve(token);
  });
  queueMicrotask(() => input.focus());
  return promise;
}

export class CatmaidCredentialsProvider extends CredentialsProvider<CatmaidToken> {
  public readonly serverUrl: string;
  private generation = 0;
  private personalToken: string | undefined;
  private readonly storageKey: string;

  constructor(
    serverUrl: string,
    private tokenStorage:
      | CatmaidTokenStorage
      | undefined = getSessionTokenStorage(),
  ) {
    super();
    this.serverUrl = canonicalizeCatmaidServerUrl(serverUrl);
    this.storageKey = getCatmaidTokenStorageKey(this.serverUrl);
  }

  private getStoredPersonalToken() {
    if (this.personalToken !== undefined) return this.personalToken;
    try {
      const token = this.tokenStorage?.getItem(this.storageKey)?.trim();
      if (token) {
        this.personalToken = token;
        return token;
      }
    } catch {
      // Browser storage can be disabled. In-memory credentials still work.
    }
    return undefined;
  }

  private storePersonalToken(token: string) {
    this.personalToken = token;
    try {
      this.tokenStorage?.setItem(this.storageKey, token);
    } catch {
      // Fall back to the in-memory copy.
    }
  }

  private clearPersonalToken(token: string) {
    if (this.personalToken === token) {
      this.personalToken = undefined;
    }
    try {
      if (this.tokenStorage?.getItem(this.storageKey) === token) {
        this.tokenStorage.removeItem(this.storageKey);
      }
    } catch {
      // Ignore unavailable browser storage.
    }
  }

  get = makeCachedCredentialsGetter<CatmaidToken>(
    async (invalidCredentials, options) => {
      using _span = new ProgressSpan(options.progressListener, {
        message: `Requesting CATMAID access token from ${this.serverUrl}`,
      });

      let credentials: CatmaidToken;
      if (invalidCredentials === undefined) {
        const storedToken = this.getStoredPersonalToken();
        credentials =
          storedToken === undefined
            ? await getAnonymousToken(this.serverUrl, options.signal)
            : { token: storedToken, kind: "personal" };
      } else {
        if (invalidCredentials.credentials.kind === "personal") {
          this.clearPersonalToken(invalidCredentials.credentials.token);
        }
        const token = await requestPersonalToken(
          this.serverUrl,
          options.signal,
        );
        this.storePersonalToken(token);
        credentials = { token, kind: "personal" };
      }

      return { generation: ++this.generation, credentials };
    },
  );
}
