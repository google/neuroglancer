/**
 * @license
 * Copyright 2019 Google Inc.
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

import {CredentialsProvider, CredentialsWithGeneration} from 'neuroglancer/credentials_provider';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk, HttpError, ResponseTransform} from 'neuroglancer/util/http_request';

export async function fetchWithCredentials<Credentials, T>(
    credentialsProvider: CredentialsProvider<Credentials>, input: RequestInfo, init: RequestInit,
    transformResponse: ResponseTransform<T>,
    applyCredentials: (credentials: Credentials, requestInit: RequestInit) => RequestInit,
    errorHandler: (httpError: HttpError) => 'refresh' | 'retry',
    cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  let credentials: CredentialsWithGeneration<Credentials>|undefined;
  credentialsLoop: while (true) {
    credentials = await credentialsProvider.get(credentials, cancellationToken);
    requestLoop: while (true) {
      try {
        return await cancellableFetchOk(
            input, applyCredentials(credentials.credentials, init), transformResponse,
            cancellationToken);
      } catch (error) {
        if (error instanceof HttpError) {
          if (errorHandler(error) === 'refresh') continue credentialsLoop;
          continue requestLoop;
        }
        throw error;
      }
    }
  }
}
