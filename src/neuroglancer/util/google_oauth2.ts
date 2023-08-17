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

import {CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {CANCELED, CancellationToken, CancellationTokenSource, uncancelableToken} from 'neuroglancer/util/cancellation';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import {getRandomHexString} from 'neuroglancer/util/random';

export const EMAIL_SCOPE = 'email';
export const OPENID_SCOPE = 'openid';

export const AUTH_SERVER = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * OAuth2 Token
 */
export interface OAuth2Token {
  accessToken: string;
  expiresIn: string;
  tokenType: string;
  scope: string;
  email: string|undefined;
}

function extractEmailFromIdToken(idToken: string): string {
  const idTokenParts = idToken.split('.');
  try {
    if (idTokenParts.length !== 3) throw new Error(`Invalid JWT format`);
    const decoded = atob(idTokenParts[1]);
    const parsed = JSON.parse(decoded);
    verifyObject(parsed);
    return verifyObjectProperty(parsed, 'email', verifyString);
  } catch (e) {
    throw new Error(`Failed to decode id token: ${e.message}`);
  }
}

async function waitForAuthResponseMessage(
    source: Window, state: string, cancellationToken: CancellationToken): Promise<OAuth2Token> {
  const context = new RefCounted();
  try {
    return await new Promise((resolve, reject) => {
      context.registerDisposer(cancellationToken.add(() => reject(CANCELED)));
      context.registerEventListener(window, 'message', (event: MessageEvent) => {
        if (event.origin !== location.origin) {
          return;
        }

        if (event.source !== source) return;

        try {
          const obj = verifyObject(event.data);
          const receivedState = verifyObjectProperty(obj, 'state', verifyString);
          if (receivedState !== state) {
            throw new Error('invalid state');
          }
          const idToken = verifyObjectProperty(obj, 'id_token', verifyString);
          const token: OAuth2Token = {
            accessToken: verifyObjectProperty(obj, 'access_token', verifyString),
            tokenType: verifyObjectProperty(obj, 'token_type', verifyString),
            expiresIn: verifyObjectProperty(obj, 'expires_in', verifyString),
            scope: verifyObjectProperty(obj, 'scope', verifyString),
            email: extractEmailFromIdToken(idToken),
          };
          resolve(token);
        } catch (parseError) {
          reject(new Error(`Received unexpected authentication response: ${parseError.message}`));
          console.error('Response received: ', event.data);
        }
      });
    });
  } finally {
    context.dispose();
  }
}

function makeAuthRequestUrl(options: {
  clientId: string,
  scopes: string[],
  nonce?: string,
  approvalPrompt?: 'force'|'auto',
  state?: string,
  loginHint?: string,
  authUser?: number,
  immediate?: boolean
}) {
  let url = `${AUTH_SERVER}?client_id=${encodeURIComponent(options.clientId)}`;
  const redirectUri = new URL('google_oauth2_redirect.html', window.location.href).href;
  url += `&redirect_uri=${redirectUri}`;
  let responseType = 'token';
  const {scopes} = options;
  if (scopes.includes('email') && scopes.includes('openid')) {
    responseType = 'token%20id_token';
  }
  url += `&response_type=${responseType}`;
  url += `&include_granted_scopes=true`;
  url += `&scope=${encodeURIComponent(scopes.join(' '))}`;
  if (options.state) {
    url += `&state=${options.state}`;
  }
  if (options.loginHint) {
    url += `&login_hint=${encodeURIComponent(options.loginHint)}`;
  }
  if (options.immediate) {
    url += `&immediate=true`;
  }
  if (options.nonce !== undefined) {
    url += `&nonce=${options.nonce}`;
  }
  if (options.authUser !== undefined) {
    url += `&authuser=${options.authUser}`;
  }
  return url;
}

/**
 * Obtain a Google OAuth2 authentication token.
 * @return A Promise that resolves to an authentication token.
 */
export async function authenticateGoogleOAuth2(
    options: {
      clientId: string,
      scopes: string[],
      approvalPrompt?: 'force'|'auto',
      loginHint?: string,
      immediate?: boolean,
      authUser?: number,
    },
    cancellationToken = uncancelableToken) {
  const state = getRandomHexString();
  const nonce = getRandomHexString();
  const url = makeAuthRequestUrl({
    state,
    nonce,
    clientId: options.clientId,
    scopes: options.scopes,
    approvalPrompt: options.approvalPrompt,
    loginHint: options.loginHint,
    immediate: options.immediate,
    authUser: options.authUser,
  });
  let source: Window;
  let cleanup: (() => void)|undefined;
  const extraPromises: Array<Promise<OAuth2Token>> = [];
  if (options.immediate) {
    // For immediate mode auth, we can wait until the relay is ready, since we aren't opening a new
    // window.
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.display = 'none';
    extraPromises.push(new Promise((_resolve, reject) => {
      iframe.addEventListener('load', () => {
        console.log('iframe loaded', iframe.contentDocument);
        if (iframe.contentDocument == null) {
          // Error received
          reject(new Error('Immediate authentication failed'));
        }
      });
    }));
    document.body.appendChild(iframe);
    source = iframe.contentWindow!;
    cleanup = () => {
      removeFromParent(iframe);
    };
  } else {
    const newWindow = open(url);
    source = newWindow!;
    if (newWindow !== null) {
      cleanup = () => {
        try {
          newWindow.close();
        } catch {
        }
      };
    }
  }

  try {
    return await Promise.race(
        [...extraPromises, waitForAuthResponseMessage(source, state, cancellationToken)]);
  } finally {
    cleanup?.();
  }
}

export class GoogleOAuth2CredentialsProvider extends CredentialsProvider<OAuth2Token> {
  constructor(public options: {clientId: string, scopes: string[], description: string}) {
    super();
  }

  get = makeCredentialsGetter(cancellationToken => {
    const {options} = this;
    const status = new StatusMessage(/*delay=*/ true);
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
          msg = `${options.description} authorization required.`,
          linkMessage = 'Request authorization.') {
        status.setText(msg + '  ');
        let button = document.createElement('button');
        button.textContent = linkMessage;
        status.element.appendChild(button);
        button.addEventListener('click', () => {
          login(/*immediate=*/ false);
        });
        status.setVisible(true);
      }
      function login(immediate: boolean) {
        if (cancellationSource !== undefined) {
          cancellationSource.cancel();
        }
        cancellationSource = new CancellationTokenSource();
        writeLoginStatus(`Waiting for ${options.description} authorization...`, 'Retry');
        authenticateGoogleOAuth2(
            {
              clientId: options.clientId,
              scopes: options.scopes,
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
                      writeLoginStatus(
                          `${options.description} authorization failed: ${reason}.`, 'Retry');
                    }
                  }
                });
      }
      login(/*immediate=*/ true);
    });
  });
}
