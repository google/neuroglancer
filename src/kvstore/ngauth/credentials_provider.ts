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

import { fetchOkWithCredentials } from "#src/credentials_provider/http_request.js";
import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import {
  getCredentialsWithStatus,
  monitorAuthPopupWindow,
} from "#src/credentials_provider/interactive_credentials_provider.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { raceWithAbort } from "#src/util/abort.js";
import { fetchOk, HttpError } from "#src/util/http_request.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

function makeOriginError(serverUrl: string): Error {
  return new Error(
    `ngauth server ${serverUrl} ` +
      `does not allow requests from Neuroglancer instance ${self.origin}`,
  );
}

export interface Credentials {
  token: string;
}

async function waitForLogin(
  serverUrl: string,
  signal: AbortSignal,
): Promise<Credentials> {
  const abortController = new AbortController();
  signal = AbortSignal.any([abortController.signal, signal]);
  try {
    const newWindow = window.open(
      `${serverUrl}/login?origin=${encodeURIComponent(self.origin)}`,
    );
    if (newWindow === null) {
      throw new Error("Failed to create authentication popup window");
    }
    monitorAuthPopupWindow(newWindow, abortController);
    return await raceWithAbort(
      waitForAuthResponseMessage(serverUrl, newWindow, abortController.signal),
      signal,
    );
  } finally {
    abortController.abort();
  }
}

function waitForAuthResponseMessage(
  serverUrl: string,
  source: Window,
  signal: AbortSignal,
): Promise<Credentials> {
  return new Promise((resolve, reject) => {
    window.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (event.source !== source) return;
        const eventOrigin =
          event.origin || (<MessageEvent>(<any>event).originalEvent).origin;
        if (eventOrigin !== serverUrl) {
          return;
        }
        const { data } = event;
        if (event.data === "badorigin") {
          reject(makeOriginError(serverUrl));
          return;
        }
        try {
          verifyObject(data);
          const token = verifyObjectProperty(data, "token", verifyString);
          resolve({ token });
        } catch (e) {
          reject(
            new Error(
              `Received unexpected authentication response: ${e.message}`,
            ),
          );
          console.error(
            "ngauth: Received unexpected message from ${serverUrl}",
            event,
          );
        }
      },
      { signal: signal },
    );
  });
}

export class NgauthCredentialsProvider extends CredentialsProvider<Credentials> {
  constructor(public serverUrl: string) {
    super();
  }
  get = makeCredentialsGetter(async (options) => {
    using _span = new ProgressSpan(options.progressListener, {
      message: `Requesting ngauth login token from ${this.serverUrl}`,
    });
    try {
      const response = await fetchOk(`${this.serverUrl}/token`, {
        method: "POST",
        credentials: "include",
        signal: options.signal,
      });
      return { token: await response.text() };
    } catch (e) {
      if (e instanceof HttpError) {
        switch (e.status) {
          case 401:
            return await getCredentialsWithStatus(
              {
                description: `ngauth server ${this.serverUrl}`,
                requestDescription: "login",
                get: (signal) => waitForLogin(this.serverUrl, signal),
              },
              options.signal,
            );
          case 403:
            throw makeOriginError(this.serverUrl);
        }
      }
      throw e;
    }
  });
}

export class NgauthGcsCredentialsProvider extends CredentialsProvider<OAuth2Credentials> {
  constructor(
    public ngauthCredentialsProvider: CredentialsProvider<Credentials>,
    public serverUrl: string,
    public bucket: string,
  ) {
    super();
  }
  get = makeCredentialsGetter(async (options) => {
    using _span = new ProgressSpan(options.progressListener, {
      message: `Requesting access token for gs://${this.bucket} from ${this.serverUrl}`,
    });
    const response = await fetchOkWithCredentials(
      this.ngauthCredentialsProvider,
      `${this.serverUrl}/gcs_token`,
      { method: "POST", signal: options.signal },
      (credentials, init) => {
        return {
          ...init,
          body: JSON.stringify({
            token: credentials.token,
            bucket: this.bucket,
          }),
        };
      },
      (error) => {
        const { status } = error;
        if (status === 401) {
          return "refresh";
        }
        throw error;
      },
    );
    return { tokenType: "Bearer", accessToken: (await response.json()).token };
  });
}
