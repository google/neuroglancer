/**
 * @license
 * Copyright 2017 Google Inc.
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

import {getToken, implementation, Token} from 'neuroglancer/datasource/boss/api_implementation';
import {CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {StatusMessage} from 'neuroglancer/status';
// import {authenticateKeycloakOIDC} from 'neuroglancer/util/keycloak_oidc';
import {registerRPC, RPC} from 'neuroglancer/worker_rpc';

const authServer = 'https://auth.boss.neurodata.io/auth';

import * as Keycloak from 'keycloak-js';

export class KeycloakService {
  static auth: any = {};

  static initialized: boolean = false; 

  static init(): Promise<any> {
    const keycloakAuth = Keycloak({
      url: authServer,
      realm: 'BOSS',
      clientId: 'endpoint'
    });

    KeycloakService.auth.loggedIn = false; 

    return new Promise((resolve, reject) => {
      keycloakAuth.init({ 
          onLoad: 'login-required',
           responseMode: 'query' 
        })
      .success(() => {
        KeycloakService.auth.loggedIn = true;
        KeycloakService.auth.authz = keycloakAuth; 
        resolve();
      })
      .error(() => {
        reject();
      });
    });
  }
}

implementation.getNewTokenPromise = function() {
  const status = new StatusMessage(/*delay=*/false);
  let cancellationSource: CancellationTokenSource|undefined;

  return new Promise(resolve => {
    function writeLoginStatus(msg = 'Boss authorization required.', linkMessage = 'Request authorization.') {
        if (status)
            status.setText(msg + '  ');
            let button = document.createElement('button');
            button.textContent = linkMessage; 
            status.element.appendChild(button);
            button.addEventListener('click', () => {
                login();
            });
            status.setVisible(true);
        }

    function login() {
        writeLoginStatus('Waiting for Boss authorization...', 'Retry');
        if (KeycloakService.auth.authz && KeycloakService.auth.authz.token) {
                KeycloakService.auth.authz.updateToken(5)
                .success(() => {
                    cancellationSource = undefined;
                    status.dispose();
                    resolve(<Token>KeycloakService.auth.authz.token);
                })
                .error(() => {
                    cancellationSource = undefined;
                    writeLoginStatus(`Boss authorization failed.`, 'Retry');
                });
            } else {
                writeLoginStatus(`Boss requires authorization.`, 'Initializing...');
                KeycloakService.init()
                .then(() => { login(); });
            }
    }
    login();
  }); 
}

registerRPC('boss.requestToken', function(x) {
    let rpc: RPC = this;
    getToken(x['invalidToken']).then(function(authResult: any) {
        rpc.invoke('boss.receiveToken', {'authResult': authResult});
    });
});