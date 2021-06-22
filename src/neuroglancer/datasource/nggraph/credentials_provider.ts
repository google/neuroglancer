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
import {HttpError} from 'neuroglancer/util/http_request';

function makeOriginError(serverUrl: string): Error {
  return new Error(`Nggraph server ${
      serverUrl} does not allow requests from Neuroglancer instance ${self.origin}`);
}

export interface Credentials {
  token: string;
}

async function waitForLogin(serverUrl: string): Promise<Credentials> {
  let status = new StatusMessage(/*delay=*/ false);
  function writeLoginStatus(message: string, buttonMessage: string) {
    status.element.textContent = message + ' ';
    const button = document.createElement('button');
    button.textContent = buttonMessage;
    status.element.appendChild(button);
    button.addEventListener('click', () => {
      window.open(`${serverUrl}/login?origin=${encodeURIComponent(self.origin)}`);
      writeLoginStatus(`Waiting for login to nggraph server ${serverUrl}...`, 'Retry');
    });
  }
  const messagePromise = new Promise<string>((resolve, reject) => {
    function messageHandler(event: MessageEvent) {
      const eventOrigin = event.origin || (<MessageEvent>(<any>event).originalEvent).origin;
      if (eventOrigin !== serverUrl) {
        return;
      }
      if (typeof event.data !== 'string') return;
      const removeListener = () => {
        window.removeEventListener('message', messageHandler, false);
      };
      if (event.data === 'badorigin') {
        removeListener();
        reject(makeOriginError(serverUrl));
      } else {
        removeListener();
        resolve(event.data);
      }
    }
    window.addEventListener('message', messageHandler, false);
  });
  writeLoginStatus(`Nggraph server ${serverUrl} login required.`, 'Login');
  try {
    return {token: await messagePromise};
  } finally {
    status.dispose();
  }
}

export class NggraphCredentialsProvider extends CredentialsProvider<Credentials> {
  constructor(public serverUrl: string) {
    super();
  }
  get = makeCredentialsGetter(async () => {
    let response = await fetch(`${this.serverUrl}/token`, {method: 'POST', credentials: 'include'});
    switch (response.status) {
      case 200:
        return {token: await response.text()};
      case 401:
        return await waitForLogin(this.serverUrl);
      case 403:
        throw makeOriginError(this.serverUrl);
      default:
        throw HttpError.fromResponse(response);
    }
  });
}
