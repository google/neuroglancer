/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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

import {AnonymousFirstCredentialsProvider, CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {CANCELED, CancellationTokenSource, uncancelableToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk} from 'neuroglancer/util/http_request';
import {DVIDToken, responseText} from 'neuroglancer/datasource/dvid/api';

async function getAuthToken(authServer: string, cancellationToken = uncancelableToken): Promise<DVIDToken> {
  const token = await cancellableFetchOk(
    authServer, {'method': 'GET', credentials: 'include'}, responseText, cancellationToken);
  return {token};
}

class BaseDVIDCredentialsProvider extends CredentialsProvider<DVIDToken> {
  constructor(public authServer: string|undefined) {
    super();
  }

  get = makeCredentialsGetter(cancellationToken => {
    if (!this.authServer) return Promise.resolve({token: ''});
    const status = new StatusMessage(/*delay=*/true);
    let cancellationSource: CancellationTokenSource|undefined;
    return new Promise<DVIDToken>((resolve, reject) => {
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
      function writeAuthStatus(
          authServer: string,
          msg = 'DVID authorization required.',
          linkMessage = 'Request authorization.') {
        status.setText(msg + ' ');
        let button = document.createElement('button');
        button.textContent = linkMessage;
        status.element.appendChild(button);
        button.addEventListener('click', () => {
          // In the current DVID setup, https://flyemlogin.<domain> is expected for the login server
          let match = authServer.match(/^[^\/]+\/\/[^\/\.]+\.([^\/]+)/);
          if (match) {
            const loginServer = `https://flyemlogin.${match[1]}/login`;
            window.alert(`Please log into ${loginServer} and then refresh the neurogalncer page to try again.\nIf you are unable to log into ${loginServer}, please check your authorization server ${authServer} to make sure it is correct.`);
          } else {
            window.alert(`Please check your authorization server ${authServer} to make sure it is correct.`);
          }
        });
        status.setVisible(true);
      }

      function requestAuth(authServer: string) {
        if (cancellationSource !== undefined) {
          cancellationSource.cancel();
        }
        cancellationSource = new CancellationTokenSource();
        writeAuthStatus(authServer, 'Waiting for DVID authorization...', 'Retry');
        getAuthToken(authServer, cancellationSource)
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
                    writeAuthStatus(authServer, `DVID authorization failed: ${reason}.`, 'Retry');
                  }
                });
      }
      requestAuth(this.authServer!);
    });
  });
}

export class DVIDCredentialsProvider extends AnonymousFirstCredentialsProvider<DVIDToken> {
  constructor(_dvidServer: string, authServer: string|undefined) {
    super(new BaseDVIDCredentialsProvider(authServer), {});
  }
}
