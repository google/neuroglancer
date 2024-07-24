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
  import { StatusMessage } from "#src/status.js";
  import {
    verifyObject,
    verifyObjectProperty,
    verifyString,
    verifyStringArray,
  } from "#src/util/json.js";
  
  export type GlobusAuthToken = {
    tokenType: string;
    accessToken: string;
    url: string;
    appUrls: string[];
  };
  
  
  async function waitForLogin(serverUrl: string): Promise<GlobusAuthToken> {
    const status = new StatusMessage(/*delay=*/ false);
    const res: Promise<GlobusAuthToken> = new Promise((f) => {
      function writeLoginStatus(message: string, buttonMessage: string) {
        status.element.textContent = message + " ";
        const button = document.createElement("button");
        button.textContent = buttonMessage;
        status.element.appendChild(button);

        button.addEventListener("click", () => {
          writeLoginStatus(
            `Waiting for login to Globus server ${serverUrl}...`,
            "Retry",
          );
          console.log(serverUrl)
          const auth_popup =  window.open(
            serverUrl,
            undefined,
            `toolbar=no, menubar=no`,
          );
  
          const checkClosed = setInterval(() => {
            if (auth_popup?.closed) {
              clearInterval(checkClosed);
              writeLoginStatus(
                `Login window closed for Globus server ${serverUrl}.`,
                "Retry",
              );
            }
          }, 1000);
  
          const tokenListener = async (ev: MessageEvent) => {
            if (ev.source === auth_popup) {
              clearInterval(checkClosed);
              window.removeEventListener("message", tokenListener);
              // closeAuthPopup();
  
              verifyObject(ev.data);
              const accessToken = verifyObjectProperty(
                ev.data,
                "access_token",
                verifyString,
              );
              const appUrls = verifyObjectProperty(
                ev.data,
                "app_urls",
                verifyStringArray,
              );
  
              const token: GlobusAuthToken = {
                tokenType: "Bearer",
                accessToken,
                url: serverUrl,
                appUrls,
              };
              f(token);
            }
          };
  
          window.addEventListener("message", tokenListener);
        });
      }
  
      writeLoginStatus(`Globus server ${serverUrl} login required.`, "Login");
    });
  
    try {
      return await res;
    } finally {
      status.dispose();
    }
  }
  
  const LOCAL_STORAGE_AUTH_KEY = "globus_auth_token_v2";
  
  function getAuthTokenFromLocalStorage(authURL: string) {
    const token = localStorage.getItem(`${LOCAL_STORAGE_AUTH_KEY}_${authURL}`);
    if (token) {
      return <GlobusAuthToken>JSON.parse(token);
    }
    return null;
  }
  
  function saveAuthTokenToLocalStorage(authURL: string, value: GlobusAuthToken) {
    localStorage.setItem(
      `${LOCAL_STORAGE_AUTH_KEY}_${authURL}`,
      JSON.stringify(value),
    );
  }
  
  export class GlobusAuthCredentialsProvider extends CredentialsProvider<GlobusAuthToken> {
    alreadyTriedLocalStorage = false;
  
    constructor(private serverUrl: string) {
      super();
    }
    get = makeCredentialsGetter(async () => {
      let token = undefined;
  
      if (!this.alreadyTriedLocalStorage) {
        this.alreadyTriedLocalStorage = true;
        token = getAuthTokenFromLocalStorage(this.serverUrl);
      }
  
      if (!token) {
        token = await waitForLogin(this.serverUrl);
        console.log('iamhere2')
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
  
  export class GlobusAuthAppCredentialsProvider extends CredentialsProvider<GlobusAuthToken> {
    private credentials: CredentialsWithGeneration<GlobusAuthToken> | undefined =
      undefined;
  
    constructor(
      private serverUrl: string,
      private credentialsManager: CredentialsManager,
    ) {
      super();
    }
  
    get = makeCredentialsGetter(async () => {

      const provider = this.credentialsManager.getCredentialsProvider(
        "globus",
        this.serverUrl,
      ) as GlobusAuthCredentialsProvider;

      this.credentials = await provider.get(this.credentials);
  
      if (this.credentials.credentials.appUrls.includes(this.serverUrl)) {
        return this.credentials.credentials;
      }
      const status = new StatusMessage(/*delay=*/ false);
      status.setText(`Globus: unverified app ${this.serverUrl}`);
      throw new UnverifiedApp(this.serverUrl);
    });
  }
  