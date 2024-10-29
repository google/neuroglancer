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


import pkceChallenge from "pkce-challenge";

import type {
  CredentialsManager,
  CredentialsWithGeneration,
} from "#src/credentials_provider/index.js";
import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { StatusMessage } from "#src/status.js";

export interface Credentials {
  token: string;
}

export type GlobusAuthToken = {
  tokenType: string;
  accessToken: string;
  url: string;
};

function openPopupCenter(url: string) {
  const newWindow = window.open(
    url,
  );

  if (newWindow) {
    newWindow.focus();
  }
  return newWindow;
}

const client_id = '9305520c-8b3b-47fb-9346-e38a7eeb0b26';

async function waitForLogin(serverUrl: string): Promise<GlobusAuthToken> {
  const status = new StatusMessage(/*delay=*/ false, /*modal=*/ true);

  const code_challenge = await pkceChallenge();

  const res: Promise<GlobusAuthToken> = new Promise((f) => {
    function writeLoginStatus(message: string, buttonMessage: string) {

      const login_button = document.createElement("button");
      const submit_button = document.createElement("button");
      const ep_text = document.createElement("textarea");
      const token_text = document.createElement("textarea");

      login_button.textContent = buttonMessage;
      submit_button.textContent = "Submit token";

      status.element.textContent = message;
      status.element.appendChild(document.createElement("br"));
      status.element.textContent = "Endpoint ID: ";
      status.element.appendChild(ep_text);
      status.element.appendChild(document.createElement("br"));
      
      status.element.appendChild(document.createElement("br"));
      status.element.appendChild(login_button);
      status.element.appendChild(submit_button);
      status.element.appendChild(token_text);
  
      login_button.addEventListener("click", async () => {
        console.log('Login button clicked')
        writeLoginStatus(
          `Waiting for login`,
          "Retry",
        );

        let ep_id = ep_text.value
        if (ep_id === '') {
          ep_id = "05d2c76a-e867-4f67-aa57-76edeb0beda0";
          }
          //https://auth.globus.org/scopes/${ep_id}/data_access+
        const collection_scope = `https://auth.globus.org/scopes/${ep_id}/https`

        openPopupCenter(
          `https://auth.globus.org/v2/oauth2/authorize?scope=${collection_scope}&code_challenge=${code_challenge.code_challenge}&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fauth.globus.org%2Fv2%2Fweb%2Fauth-code&response_type=code&client_id=${client_id}`,
        );
      });
      
      submit_button.addEventListener("click", async () => {
        console.log('Submit clicked')
            const accessCode = token_text.value
            

            const response = await fetch(`https://auth.globus.org/v2/oauth2/token?grant_type=authorization_code&code=${accessCode}&redirect_uri=https%3A%2F%2Fauth.globus.org%2Fv2%2Fweb%2Fauth-code&code_verifier=${code_challenge.code_verifier}&client_id=${client_id}`, {
              method: 'POST',
              });
            
            const asJSON = await response.json();
            const accessToken = asJSON.access_token;
            const token: GlobusAuthToken = {
              tokenType: "Bearer",
              accessToken,
              url: serverUrl,
            };
            f(token);
      });
    }
    writeLoginStatus(`Globus login required. Please click the login button and paste the resulting token below.`, "Login");
  });

  try {
    return await res;
  } finally {
    status.dispose();
  }
}

const LOCAL_STORAGE_AUTH_KEY = "auth_token_v2";

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

  constructor(public serverUrl: string) {
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
      saveAuthTokenToLocalStorage(this.serverUrl, token);
    }

    return token;
  });
}

export class GlobusAuthAppCredentialsProvider extends CredentialsProvider<OAuth2Credentials> {
  private credentials: CredentialsWithGeneration<GlobusAuthToken> | undefined =
  undefined;
  
  constructor(
    private serverUrl: string,
    private credentialsManager: CredentialsManager,
  ) {
    super();
  }
  get = makeCredentialsGetter(async () => {
    console.log('GlobusAuthAppCredentialsProvider', this.serverUrl);

    const provider = this.credentialsManager.getCredentialsProvider(
      "globusauth",
      this.serverUrl,
    ) as GlobusAuthCredentialsProvider;

    this.credentials = await provider.get(this.credentials);
    console.log('GlobusAuthAppCredentialsProvider', this.credentials);
    return this.credentials.credentials;

  });
}
