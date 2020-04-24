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

import {AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID, AUTHENTICATION_REAUTHENTICATE_RPC_ID, authFetchWithSharedValue} from 'neuroglancer/authentication/base.ts';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value.ts';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {ResponseTransform} from 'neuroglancer/util/http_request';
import {rpc} from 'neuroglancer/worker_rpc_context.ts';

const authTokenSharedValuePromise: Promise<SharedWatchableValue<string|null>> = new Promise((f) => {
  rpc.promiseInvoke<number>(AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID, {}).then((rpcId) => {
    f(rpc.get(rpcId));
  });
});

let waitingForToken: Promise<string>|null = null;

// makes a request to the main thread to reauthenticate with the given auth url
// auth token is passed back through the auth token shared value
async function reauthenticate(
    auth_url: string, authTokenSharedValue: SharedWatchableValue<string|null>): Promise<string> {
  if (waitingForToken) {
    return waitingForToken;
  }

  // promise fulfills when the shared value changes
  waitingForToken = new Promise((f) => {
    const onSharedValueChange = () => {
      f(<string>authTokenSharedValue.value);
      authTokenSharedValue.changed.remove(onSharedValueChange);
    };

    authTokenSharedValue.changed.add(onSharedValueChange);
  });

  // delete the waiting promise since we don't want to access old tokens
  waitingForToken.then(() => {
    waitingForToken = null;
  });

  // TODO: change back to promise, we need to handle the promise rejecting even though we get the
  // value from the shared value
  rpc.invoke(
      AUTHENTICATION_REAUTHENTICATE_RPC_ID,
      {auth_url: auth_url, used_token: authTokenSharedValue.value});

  return waitingForToken;
}

export async function authFetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
export async function authFetch<T>(
    input: RequestInfo, init: RequestInit, transformResponse: ResponseTransform<T>,
    cancellationToken: CancellationToken): Promise<T>;
export async function authFetch<T>(
    input: RequestInfo, init: RequestInit = {}, transformResponse?: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken): Promise<T|Response> {
  const authTokenShared = await authTokenSharedValuePromise;
  const response = await authFetchWithSharedValue(
      reauthenticate, authTokenShared!, input, init, cancellationToken);

  if (transformResponse) {
    return transformResponse(response);
  } else {
    return response;
  }
}
