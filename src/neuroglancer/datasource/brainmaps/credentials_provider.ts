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
 * This implements a CredentialsProvider based on neuroglancer/util/google_auth2.
 */

import {CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {CANCELED, CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {authenticateGoogleOAuth2, OAuth2Token} from 'neuroglancer/util/google_oauth2';

declare var BRAINMAPS_CLIENT_ID: string;
const BRAINMAPS_SCOPE = 'https://www.googleapis.com/auth/brainmaps';

export class BrainmapsCredentialsProvider extends CredentialsProvider<OAuth2Token> {
  get = makeCredentialsGetter(cancellationToken => {
    const status = new StatusMessage(/*delay=*/true);
    let cancellationSource: CancellationTokenSource|undefined;
    return new Promise<OAuth2Token>((resolve, reject) => {
      const dispose = () => {
        cancellationSource = undefined;
        status.dispose();
      };
      cancellationToken.add(() => {
        if (cancellationSource !== undefined) {
          cancellationSource.cancel();
          cancellationSource = undefined;
          status.dispose();
          reject(CANCELED);
        }
      });
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
                  if (cancellationSource !== undefined) {
                    dispose();
                    resolve(token);
                  }
                },
                reason => {
                  if (cancellationSource !== undefined) {
                    cancellationSource = undefined;
                    if (immediate) {
                      writeLoginStatus();
                    } else {
                      writeLoginStatus(`Brain Maps authorization failed: ${reason}.`, 'Retry');
                    }
                  }
                });
      }
      login(/*immediate=*/true);
    });
  });
}
