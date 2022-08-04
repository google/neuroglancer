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

import {CredentialsProvider,  makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {CANCELED, CancellationTokenSource, uncancelableToken} from 'neuroglancer/util/cancellation';
import {removeFromParent} from 'neuroglancer/util/dom';
import {parseArray, verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import {getRandomHexString} from 'neuroglancer/util/random';
import {Signal} from 'neuroglancer/util/signal';

export const EMAIL_SCOPE = 'email';
export const OPENID_SCOPE = 'openid';

export const AUTH_SERVER = 'https://accounts.google.com/o/oauth2/auth';

const AUTH_ORIGIN = 'https://accounts.google.com';

export function embedRelayFrame(proxyName: string, rpcToken: string) {
  let iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.id = proxyName;
  iframe.name = proxyName;
  const origin = location.origin;
  iframe.src = `https://accounts.google.com/o/oauth2/postmessageRelay?` +
      `parent=${encodeURIComponent(origin)}#rpctoken=${rpcToken}`;
  document.body.appendChild(iframe);
}

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

class PendingRequest {
  finished = new Signal<(token?: OAuth2Token, error?: any) => void>();
}

function extractEmailFromIdToken(idToken: string): string {
  const idTokenParts = idToken.split(".");
  try {
    if (idTokenParts.length !== 3) throw new Error(`Invalid JWT format`);
    const decoded = atob(idTokenParts[1]);
    const parsed = JSON.parse(decoded);
    verifyObject(parsed);
    return verifyObjectProperty(parsed, "email", verifyString);
  } catch (e) {
    throw new Error(`Failed to decode id token: ${e.message}`);
  }
}

class AuthHandler {
  proxyName = `postmessageRelay${getRandomHexString()}`;
  rpcToken = `${getRandomHexString()}`;
  relayReadyService = `oauth2relayReady:${this.rpcToken}`;
  oauth2CallbackService = `oauth2callback:${this.rpcToken}`;
  relayReadyPromise: Promise<void>;
  pendingRequests = new Map<string, PendingRequest>();

  constructor() {
    embedRelayFrame(this.proxyName, this.rpcToken);

    this.relayReadyPromise = new Promise<void>((relayReadyPromiseResolve) => {
      addEventListener('message', (event: MessageEvent) => {
        if (event.origin !== AUTH_ORIGIN) {
          return;
        }
        try {
          let data = verifyObject(JSON.parse(event.data));
          let service = verifyString(data['s']);
          if (service === this.relayReadyService) {
            relayReadyPromiseResolve();
          }

          if (service === this.oauth2CallbackService) {
            let args = parseArray(data['a'], x => x);
            let arg = verifyString(args[0]);
            let origin = location.origin;
            if (!arg.startsWith(origin + '#') && !arg.startsWith(origin + '?')) {
              throw new Error(
                  `oauth2callback: URL ${JSON.stringify(arg)} ` +
                  `does not match current origin ${origin}.`);
            }
            let hashPart = arg.substring(origin.length + 1);
            let parts = hashPart.split('&');
            let params = new Map<string, string>();
            for (let part of parts) {
              let match = part.match('^([a-z_]+)=(.*)$');
              if (match === null) {
                throw new Error(
                    `oauth2callback: URL part ${JSON.stringify(match)} ` +
                    `does not match expected pattern.`);
              }
              params.set(match[1], match[2]);
            }
            let state = params.get('state');
            if (state === undefined) {
              throw new Error(`oauth2callback: State argument is missing.`);
            }
            let request = this.pendingRequests.get(state);
            if (request === undefined) {
              // Request may have been cancelled.
              return;
            }
            let error = params.get('error');
            if (error !== undefined) {
              let errorSubtype = params.get('error_subtype');
              let fullMessage = error;
              if (errorSubtype !== undefined) {
                fullMessage += ': ' + errorSubtype;
              }
              request.finished.dispatch(
                  undefined, new Error(`Error obtaining Google OAuth2 token: ${fullMessage}`));
              return;
            }
            let accessToken = params.get('access_token');
            let tokenType = params.get('token_type');
            let expiresIn = params.get('expires_in');
            let idToken = params.get('id_token');
            let email = idToken === undefined ? undefined : extractEmailFromIdToken(idToken);
            let scope = params.get('scope');
            if (accessToken === undefined || tokenType === undefined || expiresIn === undefined ||
                scope === undefined) {
              throw new Error(`oauth2callback: URL lacks expected parameters.`);
            }
            request.finished.dispatch({
              accessToken: accessToken,
              tokenType: tokenType,
              expiresIn: expiresIn,
              scope,
              email,
            });
            return;
          }
        } catch (parseError) {
          throw new Error(
              `Invalid message received from ${AUTH_ORIGIN}: ${JSON.stringify(event.data)}: ` +
              `${parseError.message}.`);
        }
      });
    });
  }

  addPendingRequest(state: string) {
    let request = new PendingRequest();
    this.pendingRequests.set(state, request);
    request.finished.add(() => {
      this.pendingRequests.delete(state);
    });
    return request;
  }

  makeAuthRequestUrl(options: {
    clientId: string,
    scopes: string[],
    approvalPrompt?: 'force'|'auto',
    state?: string,
    origin?: string,
    loginHint?: string,
    authUser?: number,
    immediate?: boolean
  }) {
    let url = `${AUTH_SERVER}?client_id=${encodeURIComponent(options.clientId)}`;
    url += `&redirect_uri=postmessage`;
    let responseType = 'token';
    const {scopes} = options;
    if (scopes.includes("email") && scopes.includes("openid")) {
      responseType = 'token%20id_token';
    }
    url += `&response_type=${responseType}`;
    let {origin = location.origin} = options;
    url += `&origin=${encodeURIComponent(origin)}`;
    url += `&proxy=${this.proxyName}`;
    url += `&include_granted_scopes=true`;
    url += `&scope=${encodeURIComponent(scopes.join(' '))}`;
    if (options.state) {
      url += `&state=${options.state}`;
    }
    if (options.approvalPrompt) {
      url += `&approval_prompt=${encodeURIComponent(options.approvalPrompt)}`;
    }
    if (options.loginHint) {
      url += `&login_hint=${encodeURIComponent(options.loginHint)}`;
    }
    if (options.immediate) {
      url += `&immediate=true`;
    }
    if (options.authUser !== undefined) {
      url += `&authuser=${options.authUser}`;
    }
    return url;
  }
}


let authHandlerInstance: AuthHandler;

function authHandler() {
  if (authHandlerInstance === undefined) {
    authHandlerInstance = new AuthHandler();
  }
  return authHandlerInstance;
}

/**
 * Obtain a Google OAuth2 authentication token.
 * @return A Promise that resolves to an authentication token.
 */
export function authenticateGoogleOAuth2(
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
  const handler = authHandler();
  const url = handler.makeAuthRequestUrl({
    state,
    clientId: options.clientId,
    scopes: options.scopes,
    approvalPrompt: options.approvalPrompt,
    loginHint: options.loginHint,
    immediate: options.immediate,
    authUser: options.authUser,
  });
  const request = handler.addPendingRequest(state);
  const promise = new Promise<OAuth2Token>((resolve, reject) => {
    request.finished.add((token, error) => {
      if (token !== undefined) {
        resolve(token);
      } else {
        reject(error);
      }
    });
  });
  request.finished.add(cancellationToken.add(() => {
    request.finished.dispatch(undefined, CANCELED);
  }));
  if (options.immediate) {
    // For immediate mode auth, we can wait until the relay is ready, since we aren't opening a new
    // window.
    handler.relayReadyPromise.then(() => {
      if (cancellationToken.isCanceled) {
        return;
      }
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      request.finished.add(() => {
        removeFromParent(iframe);
      });
    });
  } else {
    if (!cancellationToken.isCanceled) {
      const newWindow = open(url);
      if (newWindow !== null) {
        request.finished.add(() => {
          newWindow.close();
        });
      }
    }
  }
  return promise;
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
