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

import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {HttpError} from 'neuroglancer/util/http_request';

export const AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID = 'Authentication.get_shared_token';
export const AUTHENTICATION_REAUTHENTICATE_RPC_ID = 'Authentication.reauthenticate';

export function parseWWWAuthHeader(headerVal: string) {
  const tuples =
      <[string, string][]>headerVal.split('Bearer ')[1].split(', ').map((x) => x.split('='));
  const wwwAuthMap = new Map<String, string>();

  for (let [key, val] of tuples) {
    wwwAuthMap.set(key, val.replace(/"/g, ''));
  }

  return wwwAuthMap;
}

export type SharedAuthToken = SharedWatchableValue<string|null>;

type ReauthFunction = (auth_url: string, used_token?: string|SharedAuthToken) => Promise<string>;

export class AuthenticationError extends Error {
  realm: string;

  constructor(realm: string) {
    super();
    this.realm = realm;
  }
}

async function authFetchOk(
    input: RequestInfo, init?: RequestInit, handleError = true): Promise<Response> {
  try {
    const res = await fetch(input, init);

    if (res.status === 400 || res.status === 401) {
      const wwwAuth = res.headers.get('WWW-Authenticate');
      if (wwwAuth) {
        if (wwwAuth.startsWith('Bearer ')) {
          const wwwAuthMap = parseWWWAuthHeader(wwwAuth);

          if (!wwwAuthMap.get('error') || wwwAuthMap.get('error') === 'invalid_token') {
            // missing or expired
            throw new AuthenticationError(<string>wwwAuthMap.get('realm'));
          }
          throw new Error(`status ${res.status} auth error - ${
              wwwAuthMap.get('error')} + " Reason: ${wwwAuthMap.get('error_description')}`);
        }
      }
    }

    if (!res.ok && handleError) {
      throw HttpError.fromResponse(res);
    }

    return res;
  } catch (error) {
    // A fetch() promise will reject with a TypeError when a network error is encountered or CORS is
    // misconfigured on the server-side
    if (error instanceof TypeError) {
      throw new HttpError('', 0, '');
    }
    throw error;
  }
}

export async function authFetchWithSharedValue(
    reauthenticate: ReauthFunction, authTokenShared: SharedAuthToken, input: RequestInfo,
    init: RequestInit, cancellationToken: CancellationToken = uncancelableToken,
    handleError = true): Promise<Response> {
  const aborts: (() => void)[] = [];
  function addCancellationToken(options: any) {
    options = JSON.parse(JSON.stringify(init));

    // handle aborting
    const abortController = new AbortController();
    options.signal = abortController.signal;
    const abort = () => {
      abortController.abort();
    };
    cancellationToken.add(abort);
    aborts.push(abort);
    return options;
  }

  function setAuthQuery(input: RequestInfo) {
    if (input instanceof Request) {
      // do nothing TODO: is this right?
    } else {
      const authToken = authTokenShared!.value;

      if (authToken) {
        const url = new URL(input);
        url.searchParams.set('middle_auth_token', authToken);
        return url.href;
      }
    }

    return input;
  }

  try {
    return await authFetchOk(setAuthQuery(input), addCancellationToken(init), handleError);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      await reauthenticate(error.realm, authTokenShared);  // try once after authenticating
      return await authFetchOk(setAuthQuery(input), addCancellationToken(init), handleError);
    } else {
      throw error;
    }
  } finally {
    for (let abort of aborts) {
      cancellationToken.remove(abort);
    }
  }
}
