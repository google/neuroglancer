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

import {getToken, implementation, Token} from 'neuroglancer/datasource/brainmaps/api_implementation';
import {StatusMessage} from 'neuroglancer/status';
import {CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {authenticateGoogleOAuth2} from 'neuroglancer/util/google_oauth2';
import {registerRPC, RPC} from 'neuroglancer/worker_rpc';

declare var BRAINMAPS_CLIENT_ID: string;
const BRAINMAPS_SCOPE = 'https://www.googleapis.com/auth/brainmaps';

let nextGenerationId = 0;

implementation.getNewTokenPromise = function() {
  const status = new StatusMessage(/*delay=*/true);
  let cancellationSource: CancellationTokenSource|undefined;
  return new Promise(resolve => {
    function writeLoginStatus(
        msg = 'Brain Maps authorization required.', linkMessage = 'Request authorization.') {
      status.setText(msg + '  ');
      let button = document.createElement('button');
      button.textContent = linkMessage;
      status.element.appendChild(button);
      button.addEventListener('click', () => {
        login(/*immediate=*/false);
      });
      status.setVisible(true);
    }
    function login(immediate: boolean) {
      if (cancellationSource !== undefined) {
        cancellationSource.cancel();
      }
      cancellationSource = new CancellationTokenSource();
      writeLoginStatus('Waiting for Brain Maps authorization...', 'Retry');
      authenticateGoogleOAuth2(
          {
            clientId: BRAINMAPS_CLIENT_ID,
            scopes: [BRAINMAPS_SCOPE],
            immediate: immediate,
            authUser: 0,
          },
          cancellationSource)
          .then(
              token => {
                cancellationSource = undefined;
                (<any>token)['generationId'] = nextGenerationId++;
                status.dispose();
                resolve(token);
              },
              reason => {
                cancellationSource = undefined;
                if (immediate) {
                  writeLoginStatus();
                } else {
                  writeLoginStatus(`Brain Maps authorization failed: ${reason}.`, 'Retry');
                }
              });
    }
    login(/*immediate=*/true);
  });
};

registerRPC('brainmaps.requestToken', function(x) {
  let rpc: RPC = this;
  getToken(x['invalidToken']).then(function(authResult: any) {
    rpc.invoke('brainmaps.receiveToken', {'authResult': authResult});
  });
});
