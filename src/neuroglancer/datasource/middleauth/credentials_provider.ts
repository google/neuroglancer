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

import {CredentialsManager, CredentialsProvider, CredentialsWithGeneration, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {verifyObject, verifyObjectProperty, verifyString, verifyStringArray} from 'neuroglancer/util/json';


export type MiddleAuthToken = {
  tokenType: string;
  accessToken: string;
  url: string,
  appUrls: string[],
}

function openPopupCenter(url: string, width: number, height: number) {
  const top = window.outerHeight - window.innerHeight + window.innerHeight / 2 - height / 2;
  const left = window.innerWidth / 2 - width / 2;
  return window.open(
    url, undefined, `toolbar=no, menubar=no, width=${width}, height=${height}, top=${top}, left=${left}`
  );
}

async function waitForLogin(serverUrl: string): Promise<MiddleAuthToken> {
  const status = new StatusMessage(/*delay=*/ false);

  const res: Promise<MiddleAuthToken> = new Promise((f) => {
    function writeLoginStatus(message: string, buttonMessage: string) {
      status.element.textContent = message + ' ';
      const button = document.createElement('button');
      button.textContent = buttonMessage;
      status.element.appendChild(button);
      
      button.addEventListener('click', () => {
        writeLoginStatus(`Waiting for login to middleauth server ${serverUrl}...`, 'Retry');

        const auth_popup = openPopupCenter(`${serverUrl}/api/v1/authorize`, 400, 650);
    
        const closeAuthPopup = () => {
          auth_popup?.close();
        }
    
        window.addEventListener('beforeunload', closeAuthPopup);
        const checkClosed = setInterval(() => {
          if (auth_popup?.closed) {
            clearInterval(checkClosed);
            writeLoginStatus(`Login window closed for middleauth server ${serverUrl}.`, 'Retry');
          }
        }, 1000);
    
        const tokenListener = async (ev: MessageEvent) => {
          if (ev.source === auth_popup) {
            clearInterval(checkClosed);
            window.removeEventListener('message', tokenListener);
            window.removeEventListener('beforeunload', closeAuthPopup);
            closeAuthPopup();
            
            verifyObject(ev.data);
            const accessToken = verifyObjectProperty(ev.data, 'token', verifyString);
            const appUrls = verifyObjectProperty(ev.data, 'app_urls', verifyStringArray);
    
            const token: MiddleAuthToken = {tokenType: 'Bearer', accessToken, url: serverUrl, appUrls};
            f(token);
          }
        };
    
        window.addEventListener('message', tokenListener);
      });
    }

    writeLoginStatus(`middleauth server ${serverUrl} login required.`, 'Login');
  });

  try {
    return await res;
  } finally {
    status.dispose();
  }
}

const LOCAL_STORAGE_AUTH_KEY = 'auth_token_v2';

function getAuthTokenFromLocalStorage(authURL: string) {
  const token = localStorage.getItem(`${LOCAL_STORAGE_AUTH_KEY}_${authURL}`);
  if (token) {
    return <MiddleAuthToken>JSON.parse(token);
  } else {
    return null;
  }
}

function saveAuthTokenToLocalStorage(authURL: string, value: MiddleAuthToken) {
  localStorage.setItem(`${LOCAL_STORAGE_AUTH_KEY}_${authURL}`, JSON.stringify(value));
}

export class MiddleAuthCredentialsProvider extends CredentialsProvider<MiddleAuthToken> {
  alreadyTriedLocalStorage: Boolean = false;

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
  private credentials: CredentialsWithGeneration<MiddleAuthToken>|undefined = undefined;

  constructor(private serverUrl: string, private credentialsManager: CredentialsManager) {
    super();
  }

  get = makeCredentialsGetter(async () => {
    const authInfo = await fetch(`${this.serverUrl}/auth_info`).then((res) => res.json());
    const provider = this.credentialsManager.getCredentialsProvider('middleauth', authInfo.login_url) as MiddleAuthCredentialsProvider;

    this.credentials = await provider.get(this.credentials);

    if (this.credentials.credentials.appUrls.includes(this.serverUrl)) {
      return this.credentials.credentials;
    } else {
      const status = new StatusMessage(/*delay=*/ false);
      status.setText(`middleauth: unverified app ${this.serverUrl}`);
      throw new UnverifiedApp(this.serverUrl);
    }
  });
}
