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

import { fetchWithCredentials } from "#src/credentials_provider/http_request.js";
import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { StatusMessage } from "#src/status.js";
import { HttpError, responseJson } from "#src/util/http_request.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";

function makeOriginError(serverUrl: string): Error {
  return new Error(
    `ngauth server ${serverUrl} ` +
      `does not allow requests from Neuroglancer instance ${self.origin}`,
  );
}

export interface Credentials {
  token: string;
}

async function waitForLogin(serverUrl: string): Promise<Credentials> {
  const status = new StatusMessage(/*delay=*/ false);
  function writeLoginStatus(message: string, buttonMessage: string) {
    status.element.textContent = message + " ";
    const button = document.createElement("button");
    button.textContent = buttonMessage;
    status.element.appendChild(button);
    button.addEventListener("click", () => {
      window.open(
        `${serverUrl}/login?origin=${encodeURIComponent(self.origin)}`,
      );
      writeLoginStatus(
        `Waiting for login to ngauth server ${serverUrl}...`,
        "Retry",
      );
    });
  }
  const messagePromise = new Promise<string>((resolve, reject) => {
    function messageHandler(event: MessageEvent) {
      const eventOrigin =
        event.origin || (<MessageEvent>(<any>event).originalEvent).origin;
      if (eventOrigin !== serverUrl) {
        return;
      }
      const removeListener = () => {
        window.removeEventListener("message", messageHandler, false);
      };
      const { data } = event;
      if (event.data === "badorigin") {
        removeListener();
        reject(makeOriginError(serverUrl));
      }
      try {
        verifyObject(data);
        const token = verifyObjectProperty(data, "token", verifyString);
        removeListener();
        resolve(token);
      } catch (e) {
        console.log(
          "ngauth: Received unexpected message from ${serverUrl}",
          event,
        );
      }
    }
    window.addEventListener("message", messageHandler, false);
  });
  writeLoginStatus(`ngauth server ${serverUrl} login required.`, "Login");
  try {
    return { token: await messagePromise };
  } finally {
    status.dispose();
  }
}

export class NgauthCredentialsProvider extends CredentialsProvider<Credentials> {
  constructor(public serverUrl: string) {
    super();
  }
  get = makeCredentialsGetter(async () => {
    const response = await fetch(`${this.serverUrl}/token`, {
      method: "POST",
      credentials: "include",
    });
    switch (response.status) {
      case 200:
        return { token: await response.text() };
      case 401:
        return await waitForLogin(this.serverUrl);
      case 403:
        throw makeOriginError(this.serverUrl);
      default:
        throw HttpError.fromResponse(response);
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
  get = makeCredentialsGetter(async () => {
    const response = await fetchWithCredentials(
      this.ngauthCredentialsProvider,
      `${this.serverUrl}/gcs_token`,
      { method: "POST" },
      responseJson,
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
    return { tokenType: "Bearer", accessToken: response.token };
  });
}
