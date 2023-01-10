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
import {CancellationToken, throwIfCanceled, uncancelableToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk, HttpError, pickDelay, ResponseTransform} from 'neuroglancer/util/http_request';

const maxCredentialsAttempts = 3;

export async function fetchWithCredentials<Credentials, T>(
    credentialsProvider: CredentialsProvider<Credentials>,
    input: RequestInfo|((credentials: Credentials) => RequestInfo), init: RequestInit,
    transformResponse: ResponseTransform<T>,
    applyCredentials: (credentials: Credentials, requestInit: RequestInit) => RequestInit,
    errorHandler: (httpError: HttpError, credentials: Credentials) => 'refresh',
    cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  let credentials: CredentialsWithGeneration<Credentials>|undefined;
  credentialsLoop: for (let credentialsAttempt = 0;;) {
    throwIfCanceled(cancellationToken);
    if (credentialsAttempt > 1) {
      // Don't delay on the first attempt, and also don't delay on the second attempt, since if the
      // credentials have expired and there is no problem on the server there is no reason to delay
      // requesting new credentials.
      await new Promise(resolve => setTimeout(resolve, pickDelay(credentialsAttempt - 2)));
    }
    credentials = await credentialsProvider.get(credentials, cancellationToken);
    try {
      return await cancellableFetchOk(
          typeof input === 'function' ? input(credentials.credentials) : input,
          applyCredentials(credentials.credentials, init), transformResponse, cancellationToken);
    } catch (error) {
      if (error instanceof HttpError) {
        if (errorHandler(error, credentials.credentials) === 'refresh') {
          if (++credentialsAttempt === maxCredentialsAttempts) throw error;
          continue credentialsLoop;
        }
      }
      throw error;
    }
  }
}
