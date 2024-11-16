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

// import { fetchWithCredentials } from "#src/credentials_provider/http_request.js";
import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { StatusMessage } from "#src/status.js";
import { uncancelableToken } from "#src/util/cancellation.js";
import { HttpError } from "#src/util/http_request.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  waitForPKCEResponseMessage,
} from "#src/util/pkce.js";
import { getRandomHexString } from "#src/util/random.js";

function makeOriginError(serverUrl: string): Error {
  return new Error(
    `ngauth server ${serverUrl} ` +
      `does not allow requests from Neuroglancer instance ${self.origin}`,
  );
}

const GLOBUS_AUTH_HOST = "https://auth.globus.org";
// const REDIRECT_URI = "https://auth.globus.org/v2/web/auth-code";

const REDIRECT_URI = new URL("./globus_oauth2_redirect.html", import.meta.url)
  .href;

const CLIENT_ID = "9305520c-8b3b-47fb-9346-e38a7eeb0b26";

function getRequiredScopes(endpoint: string) {
  return `https://auth.globus.org/scopes/${endpoint}/https`;
}

function getGlobusAuthorizeURL({
  endpoint,
  code_challenge,
  state,
}: {
  endpoint: string;
  code_challenge: string;
  state: string;
}) {
  const url = new URL("/v2/oauth2/authorize", GLOBUS_AUTH_HOST);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", code_challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", getRequiredScopes(endpoint));
  return url.toString();
}

function getGlobusTokenURL({
  code,
  code_verifier,
}: {
  code: string;
  code_verifier: string;
}) {
  const url = new URL("/v2/oauth2/token", GLOBUS_AUTH_HOST);
  url.searchParams.set("grant_type", "authorization_code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("code_verifier", code_verifier);
  url.searchParams.set("code", code);
  return url.toString();
}

// type GlobusLocalStorage = {
//   authorizations?: {
//     [resourceServer: string]: OAuth2Credentials;
//   }[];
//   domainMappings?: {
//     [domain: string]: string;
//   };
// };

// function getStorage() {
//   return JSON.parse(
//     localStorage.getItem("globus") || "{}",
//   ) as GlobusLocalStorage;
// }

export interface GlobusCredentials extends OAuth2Credentials {}

async function waitForAuth(): Promise<GlobusCredentials> {
  const status = new StatusMessage(/*delay=*/ false, /*modal=*/ true);

  const res: Promise<GlobusCredentials> = new Promise((resolve) => {
    const frag = document.createDocumentFragment();

    const title = document.createElement("h1");
    title.textContent = "Globus Login Required";

    const lead = document.createElement("p");
    lead.textContent = `You need to log in to Globus to access this resource.`;

    const verifier = generateCodeVerifier();
    const state = getRandomHexString();

    const link = document.createElement("a");
    link.textContent = "Log in to Globus";
    link.rel = "noopener noreferrer";
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const source = window.open(link.href, "_blank");
      if (!source) {
        status.setText("Failed to open login window.");
        return;
      }
      waitForPKCEResponseMessage({
        client_id: CLIENT_ID,
        source,
        state,
        verifier,
        redirect_uri: REDIRECT_URI,
        cancellationToken: uncancelableToken,
      }).then((res) => {
        console.log(res);
        resolve(res);
      });
    });

    const endpoint = document.createElement("input");
    endpoint.value = "a17d7fac-ce06-4ede-8318-ad8dc98edd69";
    endpoint.type = "text";
    endpoint.placeholder = "Enter endpoint";
    endpoint.addEventListener("input", async () => {
      const challenge = await generateCodeChallenge(verifier);
      link.href = getGlobusAuthorizeURL({
        endpoint: endpoint.value,
        code_challenge: challenge,
        state,
      });
    });

    // const button = document.createElement("button");
    // button.textContent = "Submit";
    // button.addEventListener("click", async () => {
    //   const response = await fetch(
    //     getGlobusTokenURL({
    //       code: code.value,
    //       code_verifier: verifier,
    //     }),
    //     {
    //       method: "POST",
    //     },
    //   );
    //   const responseJson = await response.json();
    //   resolve({
    //     accessToken: responseJson.access_token,
    //     tokenType: responseJson.token_type,
    //   });
    // });

    frag.appendChild(title);
    frag.appendChild(lead);
    frag.appendChild(endpoint);
    frag.appendChild(link);
    // frag.appendChild(button);

    status.element.appendChild(frag);
  });

  try {
    return await res;
  } finally {
    status.dispose();
  }
}

export class GlobusCredentialsProvider extends CredentialsProvider<GlobusCredentials> {
  constructor(public serverUrl: string) {
    super();
  }
  get = makeCredentialsGetter(async () => {
    const token = "";
    const response = await fetch(`${this.serverUrl}`, {
      method: "HEAD",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Authorization: `Bearer ${token}`,
      },
    });
    switch (response.status) {
      case 200:
        // Token worked for the HEAD request, so it should work for GET access.
        return { accessToken: token, tokenType: "Bearer" };
      case 401:
        return await waitForAuth();
      case 403:
        throw makeOriginError(this.serverUrl);
      default:
        throw HttpError.fromResponse(response);
    }
  });
}

// export class GlobusCredentialsProvider extends CredentialsProvider<OAuth2Credentials> {
//   constructor(
//     public ngauthCredentialsProvider: CredentialsProvider<Credentials>,
//     public serverUrl: string,
//     public bucket: string,
//   ) {
//     super();
//   }
//   get = makeCredentialsGetter(async () => {
//     const response = await fetchWithCredentials(
//       this.ngauthCredentialsProvider,
//       `${this.serverUrl}/gcs_token`,
//       { method: "POST" },
//       responseJson,
//       (credentials, init) => {
//         return {
//           ...init,
//           body: JSON.stringify({
//             token: credentials.token,
//             bucket: this.bucket,
//           }),
//         };
//       },
//       (error) => {
//         const { status } = error;
//         if (status === 401) {
//           return "refresh";
//         }
//         throw error;
//       },
//     );
//     return { tokenType: "Bearer", accessToken: response.token };
//   });
// }
