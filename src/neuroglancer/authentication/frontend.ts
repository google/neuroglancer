/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import {AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID, AUTHENTICATION_REAUTHENTICATE_RPC_ID, authFetchWithSharedValue, SharedAuthToken} from 'neuroglancer/authentication/base.ts';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value.ts';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {ResponseTransform} from 'neuroglancer/util/http_request';
import {registerPromiseRPC, registerRPC, RPC} from 'neuroglancer/worker_rpc';

// generate a token with the neuroglancer-auth service using google oauth2
async function authorize(auth_url: string) {
  const auth_popup = window.open(
      `${auth_url}?redirect=${encodeURI(window.location.origin + '/auth_redirect.html')}`);

  if (!auth_popup) {
    alert('Allow popups on this page to authenticate');
    throw new Error('Allow popups on this page to authenticate');
  }

  return new Promise<string>((f, r) => {
    const checkClosed = setInterval(() => {
      if (auth_popup.closed) {
        // in successful case, this will still fire but fulfill will have already been called
        clearInterval(checkClosed);
        r(new Error('Auth popup closed'));
      }
    }, 1000);

    const tokenListener = (ev: MessageEvent) => {
      if (ev.source === auth_popup) {
        auth_popup.close();
        window.removeEventListener('message', tokenListener);
        f(ev.data.token);
      }
    };

    window.addEventListener('message', tokenListener);
  });
}

let currentReauthentication: Promise<string>|null = null;

// returns the token required to authenticate with "neuroglancer-auth" requiring services
// client currently only supports a single token in use at a time
async function reauthenticate(
    auth_url: string, used_token?: string|SharedAuthToken): Promise<string> {
  if (currentReauthentication) {
    return currentReauthentication;
  }

  // this should never happen but this allows the interface to be the same between front and backend
  if (used_token && (typeof used_token !== 'string')) {
    used_token = used_token.value || undefined;
  }
  used_token = <string>used_token;

  const storedToken = localStorage.getItem('auth_token');
  const storedAuthURL = localStorage.getItem('auth_url');

  // if the stored token is not what was tried, and auth url matches, try the stored token
  if (storedToken && storedAuthURL && storedAuthURL === auth_url && storedToken !== used_token) {
    authTokenShared!.value = storedToken;
    return storedToken;
  } else {
    currentReauthentication = authorize(auth_url);
    const token = await currentReauthentication;
    currentReauthentication = null;
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_url', auth_url);
    authTokenShared!.value = token;
    return token;
  }
}

export let authTokenShared: SharedAuthToken|undefined;

export function initAuthTokenSharedValue(rpc: RPC) {
  authTokenShared = SharedWatchableValue.make(rpc, localStorage.getItem('auth_token'));
  return authTokenShared;
}

// allow backend thread to access the shared token rpc id so that it can initialize the shared value
registerPromiseRPC<number>(AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID, function() {
  return new Promise((f) => {
    f({value: authTokenShared!.rpcId!});
  });
});

// allow backend to trigger reauthentication when shared value token is invalid
registerRPC(AUTHENTICATION_REAUTHENTICATE_RPC_ID, function({auth_url, used_token}) {
  return reauthenticate(auth_url, used_token).then((token) => {
    return {value: token};
  });
});

export async function authFetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
export async function authFetch<T>(
    input: RequestInfo, init: RequestInit, transformResponse: ResponseTransform<T>,
    cancellationToken: CancellationToken): Promise<T>;
export async function authFetch<T>(
    input: RequestInfo, init: RequestInit = {}, transformResponse?: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken): Promise<T|Response> {
  const response = await authFetchWithSharedValue(
      reauthenticate, authTokenShared!, input, init, cancellationToken);

  if (transformResponse) {
    return transformResponse(response);
  } else {
    return response;
  }
}
