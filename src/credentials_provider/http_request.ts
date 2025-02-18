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

import type {
  CredentialsProvider,
  CredentialsWithGeneration,
} from "#src/credentials_provider/index.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk, HttpError, pickDelay } from "#src/util/http_request.js";
import type { ProgressListener } from "#src/util/progress_listener.js";

const maxCredentialsAttempts = 3;

export async function fetchOkWithCredentials<Credentials>(
  credentialsProvider: CredentialsProvider<Credentials>,
  input: RequestInfo | ((credentials: Credentials) => RequestInfo),
  init: RequestInit & { progressListener?: ProgressListener },
  applyCredentials: (
    credentials: Credentials,
    requestInit: RequestInit & { progressListener?: ProgressListener },
  ) => RequestInit & { progressListener?: ProgressListener },
  errorHandler: (httpError: HttpError, credentials: Credentials) => "refresh",
): Promise<Response> {
  let credentials: CredentialsWithGeneration<Credentials> | undefined;
  for (let credentialsAttempt = 0; ; ) {
    init.signal?.throwIfAborted();
    if (credentialsAttempt > 1) {
      // Don't delay on the first attempt, and also don't delay on the second attempt, since if the
      // credentials have expired and there is no problem on the server there is no reason to delay
      // requesting new credentials.
      await new Promise((resolve) =>
        setTimeout(resolve, pickDelay(credentialsAttempt - 2)),
      );
    }
    credentials = await credentialsProvider.get(credentials, {
      signal: init.signal ?? undefined,
      progressListener: init.progressListener,
    });
    try {
      return await fetchOk(
        typeof input === "function" ? input(credentials.credentials) : input,
        applyCredentials(credentials.credentials, init),
      );
    } catch (error) {
      if (error instanceof HttpError) {
        if (errorHandler(error, credentials.credentials) === "refresh") {
          if (++credentialsAttempt === maxCredentialsAttempts) throw error;
          continue;
        }
      }
      throw error;
    }
  }
}

export function fetchOkWithCredentialsAdapter<Credentials>(
  credentialsProvider: CredentialsProvider<Credentials>,
  applyCredentials: (
    credentials: Credentials,
    requestInit: RequestInit & { progressListener?: ProgressListener },
  ) => RequestInit & { progressListener?: ProgressListener },
  errorHandler: (httpError: HttpError, credentials: Credentials) => "refresh",
): FetchOk {
  return (input, init = {}) =>
    fetchOkWithCredentials(
      credentialsProvider,
      input,
      init,
      applyCredentials,
      errorHandler,
    );
}
