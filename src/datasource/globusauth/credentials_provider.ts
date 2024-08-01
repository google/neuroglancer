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
import {  responseJson } from "#src/util/http_request.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
  verifyStringArray
} from "#src/util/json.js";

export interface Credentials {
  token: string;
}

export type GlobusAuthToken = {
  tokenType: string;
  accessToken: string;
  url: string;
  appUrls: string[];
};

function openPopupCenter(url: string) {
  return window.open(
    url,
  );
}


async function waitForLogin(serverUrl: string): Promise<GlobusAuthToken> {
  const status = new StatusMessage(/*delay=*/ false, /*modal=*/ true);

  const res: Promise<GlobusAuthToken> = new Promise((f) => {
    function writeLoginStatus(message: string, buttonMessage: string) {
      status.element.textContent = message + " ";
      const button = document.createElement("button");
      button.textContent = buttonMessage;
      status.element.appendChild(button);

      button.addEventListener("click", () => {
        console.log('button clicked')
        writeLoginStatus(
          `Waiting for login`,
          "Retry",
        );

        const auth_popup = openPopupCenter(
          `${serverUrl}`,
        );

        const closeAuthPopup = () => {
          auth_popup?.close();
        };

        window.addEventListener("beforeunload", closeAuthPopup);
        const checkClosed = setInterval(() => {
          if (auth_popup?.closed) {
            clearInterval(checkClosed);
            writeLoginStatus(
              `Login window closed for auth server.`,
              "Retry",
            );
          }
        }, 1000);

        const tokenListener = async (ev: MessageEvent) => {
          console.log('tokenListener')
          console.log(ev)
          if (ev.source === auth_popup) {
            clearInterval(checkClosed);
            window.removeEventListener("message", tokenListener);
            window.removeEventListener("beforeunload", closeAuthPopup);
            // closeAuthPopup();

            verifyObject(ev.data);
            const accessToken = verifyObjectProperty(
              ev.data,
              "token",
              verifyString,
            );
            const appUrls = verifyObjectProperty(
              ev.data,
              "app_urls",
              verifyStringArray,
            );

            const token: GlobusAuthToken = {
              tokenType: "Bearer",
              accessToken,
              url: serverUrl,
              appUrls,
            };
            f(token);
          }
        };

        window.addEventListener("message", tokenListener);
      });
    }

    writeLoginStatus(`Globus login required.`, "Login");
  });

  try {
    return await res;
  } finally {
    status.dispose();
  }
}

// async function waitForLogin(serverUrl: string): Promise<Credentials> {
//   const status = new StatusMessage(/*delay=*/ false);
//   function writeLoginStatus(message: string, buttonMessage: string) {
//     status.element.textContent = message + " ";
//     const button = document.createElement("button");
//     button.textContent = buttonMessage;
//     status.element.appendChild(button);
//     button.addEventListener("click", () => {
//       console.log('button clicked')
//       window.open(
//         `${serverUrl}`,
//       );
      
//       writeLoginStatus(
//         `Waiting for login to globusauth server.`,
//         "Retry",
//       );
//     });
//   }



//   const messagePromise = new Promise<string>((resolve, reject) => {
//     function messageHandler(event: MessageEvent) {
//       console.log('HA')
//       console.log(event)
//       const eventOrigin =
//         event.origin || (<MessageEvent>(<any>event).originalEvent).origin;
//       if (eventOrigin !== '*globus*') {
//         console.log('HE')
//         return;
//       }
//       const removeListener = () => {
//         window.removeEventListener("message", messageHandler, false);
//       };
//       const { data } = event;
//       if (event.data === "badorigin") {
//         removeListener();
//         reject(makeOriginError(serverUrl));
//       }
//       try {
//         verifyObject(data);
//         const token = verifyObjectProperty(data, "token", verifyString);
//         removeListener();
//         resolve(token);
//       } catch (e) {
//         console.log(
//           "globusauth: Received unexpected message from ${serverUrl}",
//           event,
//         );
//       }
//     }
//     window.addEventListener("message", messageHandler, false);
//   });
//   writeLoginStatus(`globusauth login required.`, "Login");
//   try {
//     return { token: await messagePromise };
//   } finally {
//     status.dispose();
//   }
// }

export class GlobusAuthCredentialsProvider extends CredentialsProvider<GlobusAuthToken> {
  constructor(public serverUrl: string) {
    super();
  }
  get = makeCredentialsGetter(async () => {
    let token = undefined;
    token = await waitForLogin(this.serverUrl);
    return token;
  });
}

// export class GlobusAuthCredentialsProvider extends CredentialsProvider<GlobusAuthToken> {
//   constructor(public serverUrl: string) {
//     super();
//   }
//   get = makeCredentialsGetter(async () => {
//     const response = await fetch(`${this.serverUrl}`);
//     console.log(response)
//     switch (response.status) {
//       case 200:
//         return { token: await response.text() };
//       case 401:
//         console.log('401')
//         return await waitForLogin(this.serverUrl);
//       case 403:
//         throw makeOriginError(this.serverUrl);
//       default:
//         throw HttpError.fromResponse(response);
//     }
//   });
// }



export class GlobusAuthAppCredentialsProvider extends CredentialsProvider<OAuth2Credentials> {
  constructor(
    public globusauthCredentialsProvider: CredentialsProvider<Credentials>,
    public serverUrl: string,
  ) {
    super();
  }
  get = makeCredentialsGetter(async () => {
    console.log('GlobusAuthAppCredentialsProvider')
    console.log(this.serverUrl)
    // return {tokenType: "Bearer", accessToken: "blah"};
    const response = await fetchWithCredentials(
      this.globusauthCredentialsProvider,
      `${this.serverUrl}`,
      { method: "POST" },
      responseJson,
      (credentials, init) => {
        return {
          ...init,
          body: JSON.stringify({
            token: credentials.token,
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
