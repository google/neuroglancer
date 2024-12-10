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

import type {
  CredentialsManager,
  CredentialsWithGeneration,
} from "#src/credentials_provider/index.js";
import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import {
  getCredentialsWithStatus,
  monitorAuthPopupWindow,
} from "#src/credentials_provider/interactive_credentials_provider.js";
import { StatusMessage } from "#src/status.js";
import { raceWithAbort } from "#src/util/abort.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";

export type MiddleAuthToken = {
  tokenType: string;
  accessToken: string;
  url: string;
  appUrls: string[];
};

function openPopupCenter(url: string, width: number, height: number) {
  const top =
    window.outerHeight -
    window.innerHeight +
    window.innerHeight / 2 -
    height / 2;
  const left = window.innerWidth / 2 - width / 2;
  return window.open(
    url,
    undefined,
    `toolbar=no, menubar=no, width=${width}, height=${height}, top=${top}, left=${left}`,
  );
}

function waitForAuthResponseMessage(
  serverUrl: string,
  source: Window,
  abortSignal: AbortSignal,
): Promise<MiddleAuthToken> {
  return new Promise((resolve, reject) => {
    window.addEventListener(
      "message",
      (event) => {
        if (event.source !== source) return;
        try {
          const obj = verifyObject(event.data);
          const accessToken = verifyObjectProperty(obj, "token", verifyString);
          const appUrls = verifyObjectProperty(
            obj,
            "app_urls",
            verifyStringArray,
          );

          const token: MiddleAuthToken = {
            tokenType: "Bearer",
            accessToken,
            url: serverUrl,
            appUrls,
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

async function waitForLogin(
  serverUrl: string,
  abortSignal: AbortSignal,
): Promise<MiddleAuthToken> {
  const abortController = new AbortController();
  abortSignal = AbortSignal.any([abortController.signal, abortSignal]);
  try {
    const newWindow = openPopupCenter(
      `${serverUrl}/api/v1/authorize`,
      400,
      650,
    );
    if (newWindow === null) {
      throw new Error("Failed to create authentication popup window");
    }
    monitorAuthPopupWindow(newWindow, abortController);
    return await raceWithAbort(
      waitForAuthResponseMessage(serverUrl, newWindow, abortController.signal),
      abortSignal,
    );
  } finally {
    abortController.abort();
  }
}

const LOCAL_STORAGE_AUTH_KEY = "auth_token_v2";

function getAuthTokenFromLocalStorage(authURL: string) {
  const token = localStorage.getItem(`${LOCAL_STORAGE_AUTH_KEY}_${authURL}`);
  if (token) {
    return <MiddleAuthToken>JSON.parse(token);
  }
  return null;
}

function saveAuthTokenToLocalStorage(authURL: string, value: MiddleAuthToken) {
  localStorage.setItem(
    `${LOCAL_STORAGE_AUTH_KEY}_${authURL}`,
    JSON.stringify(value),
  );
}

export class MiddleAuthCredentialsProvider extends CredentialsProvider<MiddleAuthToken> {
  alreadyTriedLocalStorage = false;

  constructor(private serverUrl: string) {
    super();
  }
  get = makeCredentialsGetter(async (abortSignal) => {
    let token = undefined;

    if (!this.alreadyTriedLocalStorage) {
      this.alreadyTriedLocalStorage = true;
      token = getAuthTokenFromLocalStorage(this.serverUrl);
    }

    if (!token) {
      token = await getCredentialsWithStatus(
        {
          description: `middleauth server ${this.serverUrl}`,
          requestDescription: "login",
          get: (abortSignal) => waitForLogin(this.serverUrl, abortSignal),
        },
        abortSignal,
      );
      saveAuthTokenToLocalStorage(this.serverUrl, token);
    }

    return token;
  });
}

export class UnverifiedApp extends Error {
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }
}

export class MiddleAuthAppCredentialsProvider extends CredentialsProvider<MiddleAuthToken> {
  private credentials: CredentialsWithGeneration<MiddleAuthToken> | undefined =
    undefined;

  constructor(
    private serverUrl: string,
    private credentialsManager: CredentialsManager,
  ) {
    super();
  }

  get = makeCredentialsGetter(async () => {
    const authInfo = await fetch(`${this.serverUrl}/auth_info`).then((res) =>
      res.json(),
    );
    const provider = this.credentialsManager.getCredentialsProvider(
      "middleauth",
      authInfo.login_url,
    ) as MiddleAuthCredentialsProvider;

    this.credentials = await provider.get(this.credentials);

    if (this.credentials.credentials.appUrls.includes(this.serverUrl)) {
      return this.credentials.credentials;
    }
    const status = new StatusMessage(/*delay=*/ false);
    status.setText(`middleauth: unverified app ${this.serverUrl}`);
    throw new UnverifiedApp(this.serverUrl);
  });
}
