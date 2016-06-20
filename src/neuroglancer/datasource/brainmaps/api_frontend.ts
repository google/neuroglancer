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
 * This implements the authentication API based on neuroglancer/util/google_auth2.
 */

import {Token, getToken, implementation} from 'neuroglancer/datasource/brainmaps/api_implementation';
import {StatusMessage} from 'neuroglancer/status';
import {authenticateGoogleOAuth2} from 'neuroglancer/util/google_oauth2';
import {callFinally, cancelPromise} from 'neuroglancer/util/promise';
import {RPC, registerRPC} from 'neuroglancer/worker_rpc';

declare var BRAINMAPS_CLIENT_ID: string;
const BRAINMAPS_SCOPE = 'https://www.googleapis.com/auth/brainmaps';

let nextGenerationId = 0;

implementation.getNewTokenPromise = function() {
  let status = new StatusMessage(/*delay=*/true);
  let authPromise: Promise<Token>|undefined|null;
  let tokenPromise = new Promise(function(resolve) {
    function writeLoginStatus(
        msg = 'Brain Maps authorization required.', linkMessage = 'Request authorization.') {
      status.setText(msg + '  ');
      let button = document.createElement('button');
      button.textContent = linkMessage;
      status.element.appendChild(button);
      button.addEventListener('click', () => { login(/*immediate=*/false); });
      status.setVisible(true);
    }
    function login(immediate: boolean) {
      if (authPromise !== undefined) {
        cancelPromise(authPromise);
      }
      writeLoginStatus('Waiting for Brain Maps authorization...', 'Retry');
      authPromise = authenticateGoogleOAuth2({
        clientId: BRAINMAPS_CLIENT_ID,
        scopes: [BRAINMAPS_SCOPE],
        immediate: immediate,
        authUser: 0,
      });
      authPromise.then(
          token => {
            token['generationId'] = nextGenerationId++;
            resolve(token);
          },
          reason => {
            if (immediate) {
              writeLoginStatus();
            } else {
              writeLoginStatus(`Brain Maps authorization failed: ${reason}.`, 'Retry');
            }
          });
      callFinally(authPromise, () => { authPromise = undefined; });
    }
    login(/*immediate=*/true);
  });
  callFinally(tokenPromise, () => { status.dispose(); });
  return tokenPromise;
};

registerRPC('brainmaps.requestToken', function(x) {
  let rpc: RPC = this;
  getToken(x['invalidToken']).then(function(authResult: any) {
    rpc.invoke('brainmaps.receiveToken', {'authResult': authResult});
  });
});
