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

import {CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';


export type MiddleAuthToken = {
  tokenType: string;
  accessToken: string;
  url: string,
  apps: string[],
}

function openPopupCenter(url: string, width: number, height: number) {
  const top = window.outerHeight - window.innerHeight + window.innerHeight / 2 - height / 2;
  const left = window.innerWidth / 2 - width / 2;
  return window.open(
    url, undefined, `toolbar=no, menubar=no, width=${width}, height=${height}, top=${top}, left=${left}`
  );
}

async function updateAppUrls(token: MiddleAuthToken) {
  const appListUrl = `${token.url}/api/v1/app`;

  const url = new URL(appListUrl);
  url.searchParams.set('middle_auth_token', token.accessToken);
  const res = await fetch(url.href);
  if (res.status === 200) {
    const apps = (await res.json()).map((x: any) => x.url);
    token.apps = apps;
  } else {
    throw new Error(`status ${res.status}`);
  }
}

function isVerifiedUrl(authToken: MiddleAuthToken, url: string) {
  for (const verifiedUrl of authToken.apps) {
    if (url.startsWith(verifiedUrl)) {
      return true;
    }
  }

  return false;
}

async function waitForLogin(serverUrl: string): Promise<MiddleAuthToken> {
  const status = new StatusMessage(/*delay=*/ false);

  const res: Promise<MiddleAuthToken> = new Promise((f, r) => {
    function writeLoginStatus(message: string, buttonMessage: string) {
      status.element.textContent = message + ' ';
      const button = document.createElement('button');
      button.textContent = buttonMessage;
      status.element.appendChild(button);
      
      button.addEventListener('click', () => {
        writeLoginStatus(`Waiting for login to middle auth server ${serverUrl}...`, 'Retry');

        const auth_popup = openPopupCenter(
          `${serverUrl}/api/v1/authorize?redirect=${encodeURI(new URL('auth_redirect.html', window.location.href).href)}`, 400, 650);
    
        const closeAuthPopup = () => {
          auth_popup?.close();
        }
    
        window.addEventListener('beforeunload', closeAuthPopup);
        const checkClosed = setInterval(() => {
          if (auth_popup?.closed) {
            clearInterval(checkClosed);
            r(new Error('Auth popup closed'));
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
    
            const token: MiddleAuthToken = {tokenType: 'Bearer', accessToken, url: serverUrl, apps: []};
            await updateAppUrls(token);
            saveAuthTokenToLocalStorage(serverUrl, token);
            f(token);
          }
        };
    
        window.addEventListener('message', tokenListener);
      });
    }

    writeLoginStatus(`middle auth server ${serverUrl} login required.`, 'Login');
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

export class UnverifiedApp extends Error {
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }
}

export class MiddleAuthCredentialsProvider extends CredentialsProvider<MiddleAuthToken> {
  alreadyTriedLocalStorage: Boolean = false;

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
    }

    if (isVerifiedUrl(token, this.serverUrl)) {
      return token;
    } else {
      throw new UnverifiedApp(this.serverUrl);
    }
  });
}
