/**
 * @license
 * Copyright 2020 Google Inc.
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

import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {fetchWithCredentials} from 'neuroglancer/credentials_provider/http_request';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk, ResponseTransform} from 'neuroglancer/util/http_request';


/**
 * OAuth2 token
 */
export interface OAuth2Credentials {
  tokenType: string;
  accessToken: string;
}

export function fetchWithOAuth2Credentials<T>(
    credentialsProvider: CredentialsProvider<OAuth2Credentials>|undefined, input: RequestInfo,
    init: RequestInit, transformResponse: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  if (credentialsProvider === undefined) {
    return cancellableFetchOk(input, init, transformResponse, cancellationToken);
  }
  return fetchWithCredentials(
      credentialsProvider, input, init, transformResponse,
      (credentials, init) => {
        if (!credentials.accessToken) return init;
        const headers = new Headers(init.headers);
        headers.set('Authorization', `${credentials.tokenType} ${credentials.accessToken}`);
        return {...init, headers};
      },
      (error, credentials) => {
        const {status} = error;
        if (status === 401) {
          // 401: Authorization needed.  OAuth2 token may have expired.
          return 'refresh';
        } else if (status === 504 || status === 503) {
          // 503: Service unavailable.  Retry.
          // 504: Gateway timeout.  Can occur if the server takes too long to reply.  Retry.
          return 'retry';
        } else if (status === 403 && !credentials.accessToken) {
          // Anonymous access denied.  Request credentials.
          return 'refresh';
        }
        throw error;
      },
      cancellationToken);
}
