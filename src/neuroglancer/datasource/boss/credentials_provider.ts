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
 * This implements a CredentialsProvider based on Keycloak.
 */

 import {CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
 import {StatusMessage} from 'neuroglancer/status';
 import {CANCELED, CancellationTokenSource} from 'neuroglancer/util/cancellation';

 import * as Keycloak from 'keycloak-js';

export type BossToken = string;

export class KeycloakService {
    static auth: any = {};
  
    static initialized: boolean = false; 
  
    static init(authServer: string): Promise<any> {
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

 export class BossCredentialsProvider extends CredentialsProvider<BossToken> {
    
    constructor(public authServer: string) {
        super();
    }

    get = makeCredentialsGetter(cancellationToken => {
         const status = new StatusMessage(/*delay=*/true);
         let cancellationSource: CancellationTokenSource|undefined;
         return new Promise<BossToken>((resolve, reject) => {
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
             function writeLoginStatus(msg = 'Boss authorization required.', linkMessage = 'Request authorization.') {
                 if (status) 
                    status.setText(msg + ' ');
                    let button = document.createElement('button');
                    button.textContent = linkMessage;
                    status.element.appendChild(button);
                    button.addEventListener('click', () => {
                        login();
                    });
                    status.setVisible(true);
             }
             let authServer = this.authServer;
             function login() {
                 if (cancellationSource !== undefined) {
                     cancellationSource.cancel();
                 }
                 cancellationSource = new CancellationTokenSource();
                 writeLoginStatus('Waiting for Boss authorization...', 'Retry');
                 if (KeycloakService.auth.authz && KeycloakService.auth.authz.token) {
                    KeycloakService.auth.authz.updateToken(5)
                    .success(() => {
                        if (cancellationSource !== undefined) {
                            dispose();
                            resolve(<BossToken>(KeycloakService.auth.authz.token));
                        }
                    })
                    .error(() => {
                        if (cancellationSource !== undefined) {
                            cancellationSource = undefined;
                            writeLoginStatus('Boss authorization failed.', 'Retry');
                        }
                    });
                 } else {
                    writeLoginStatus('Boss requires authorization.', 'Initializing...');
                    KeycloakService.init(authServer)
                    .then(() => {login(); });
                 }
             }
             login();
         });
     });
 }