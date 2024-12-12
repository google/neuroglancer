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

const GLOBUS_AUTH_HOST = "https://auth.globus.org";
const REDIRECT_URI = new URL("./globus_oauth2_redirect.html", import.meta.url)
  .href;

function getRequiredScopes(endpoint: string) {
  return `https://auth.globus.org/scopes/${endpoint}/https`;
}

function getGlobusAuthorizeURL({
  endpoint,
  clientId,
  code_challenge,
  state,
}: {
  endpoint: string;
  clientId: string;
  code_challenge: string;
  state: string;
}) {
  const url = new URL("/v2/oauth2/authorize", GLOBUS_AUTH_HOST);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", code_challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", getRequiredScopes(endpoint));
  return url.toString();
}

function getGlobusTokenURL({
  clientId,
  code,
  code_verifier,
}: {
  code: string;
  clientId: string;
  code_verifier: string;
}) {
  const url = new URL("/v2/oauth2/token", GLOBUS_AUTH_HOST);
  url.searchParams.set("grant_type", "authorization_code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_verifier", code_verifier);
  url.searchParams.set("code", code);
  return url.toString();
}

type GlobusLocalStorage = {
  authorizations?: {
    [resourceServer: string]: OAuth2Credentials;
  };
  /**
   * Globus Connect Server domain mappings.
   * Currently, there is no way to progrmatically determine the UUID of a GCS
   * endpoint from their domain name, so a user will need to provide a UUID
   * when attempting to access a file from a GCS endpoint.
   */
  domainMappings?: {
    [domain: string]: string;
  };
};

function getStorage() {
  return JSON.parse(
    localStorage.getItem("globus") || "{}",
  ) as GlobusLocalStorage;
}

async function waitForAuth(
  clientId: string,
  gcsHttpsHost: string,
): Promise<OAuth2Credentials> {
  const status = new StatusMessage(/*delay=*/ false, /*modal=*/ true);

  const res: Promise<OAuth2Credentials> = new Promise((resolve) => {
    const frag = document.createDocumentFragment();

    const title = document.createElement("h1");
    title.textContent = "Authenticate with Globus";
    title.style.fontSize = "1.5em";

    frag.appendChild(title);

    let identifier = getStorage().domainMappings?.[gcsHttpsHost];

    const link = document.createElement("button");
    link.textContent = "Log in to Globus";
    link.disabled = true;

    if (!identifier) {
      const label = document.createElement("label");
      label.textContent = "Globus Collection UUID";
      label.style.display = "block";
      label.style.margin = ".5em 0";
      frag.appendChild(label);
      const endpoint = document.createElement("input");
      endpoint.style.width = "100%";
      endpoint.style.margin = ".5em 0";
      endpoint.type = "text";
      endpoint.placeholder = "a17d7fac-ce06-4ede-8318-ad8dc98edd69";
      endpoint.addEventListener("input", async (e) => {
        identifier = (e.target as HTMLInputElement).value;
        link.disabled = !identifier;
      });
      frag.appendChild(endpoint);
    } else {
      link.disabled = false;
    }

    link.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!identifier) {
        status.setText("You must provide a Globus Collection UUID.");
        return;
      }
      const verifier = generateCodeVerifier();
      const state = getRandomHexString();
      const challenge = await generateCodeChallenge(verifier);
      const url = getGlobusAuthorizeURL({
        clientId,
        endpoint: identifier,
        code_challenge: challenge,
        state,
      });

      const source = window.open(url, "_blank");
      if (!source) {
        status.setText("Failed to open login window.");
        return;
      }
      let rawToken:
        | {
            access_token: string;
            token_type: string;
            resource_server: string;
          }
        | undefined;
      const token = await waitForPKCEResponseMessage({
        source,
        state,
        cancellationToken: uncancelableToken,
        tokenExchangeCallback: async (code) => {
          const response = await fetch(
            getGlobusTokenURL({ clientId, code, code_verifier: verifier }),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
            },
          );
          if (!response.ok) {
            throw new Error("Failed to exchange code for token");
          }
          rawToken = await response.json();
          if (!rawToken?.access_token || !rawToken?.token_type) {
            throw new Error("Invalid token response");
          }
          return {
            accessToken: rawToken.access_token,
            tokenType: rawToken.token_type,
          };
        },
      });

      if (!rawToken) {
        status.setText("Failed to obtain token.");
        return;
      }

      /**
       * We were able to obtain a token, store it in local storage along with
       * the domain mapping since we know it is correct.
       */
      const storage = getStorage();
      storage.authorizations = {
        ...storage.authorizations,
        [rawToken.resource_server]: token,
      };
      storage.domainMappings = {
        ...storage.domainMappings,
        [gcsHttpsHost]: rawToken.resource_server,
      };

      localStorage.setItem("globus", JSON.stringify(storage));
      resolve(token);
    });
    frag.appendChild(link);
    status.element.appendChild(frag);
  });

  try {
    return await res;
  } finally {
    status.dispose();
  }
}

export class GlobusCredentialsProvider extends CredentialsProvider<OAuth2Credentials> {
  constructor(
    public clientId: string,
    public gcsHttpsHost: string,
  ) {
    super();
  }
  get = makeCredentialsGetter(async () => {
    const resourceServer = getStorage().domainMappings?.[this.gcsHttpsHost];
    const token = resourceServer
      ? getStorage().authorizations?.[resourceServer]
      : undefined;
    if (!token) {
      return await waitForAuth(this.clientId, this.gcsHttpsHost);
    }
    const response = await fetch(`${this.gcsHttpsHost}`, {
      method: "HEAD",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Authorization: `${token?.tokenType} ${token?.accessToken}`,
      },
    });
    switch (response.status) {
      case 200:
        return token;
      case 401:
        return await waitForAuth(this.clientId, this.gcsHttpsHost);
      default:
        throw HttpError.fromResponse(response);
    }
  });
}
