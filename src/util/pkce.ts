import { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { type CancellationToken, CANCELED } from "#src/util/cancellation.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  type OAuth2Token,
  extractEmailFromIdToken,
} from "#src/util/google_oauth2.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";

/**
 * Utilities related to Proof Key for Code Exchange (PKCE).
 * @see https://oauth.net/2/pkce/
 */

/**
 * Character set for generating random alpha-numeric strings.
 */
const CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/**
 * Character set allowed to be used in the PKCE `code_verifier`
 * @see https://www.rfc-editor.org/rfc/rfc7636#section-4.1
 */
const PKCE_SAFE_CHARSET = `${CHARSET}-._~`;

/**
 * Create a Code Verifier for PKCE
 * @see https://www.rfc-editor.org/rfc/rfc7636#section-4.1
 */
export function generateCodeVerifier(size = 43) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)))
    .map((v) => PKCE_SAFE_CHARSET[v % PKCE_SAFE_CHARSET.length])
    .join("");
}

/**
 * Base64 URL encode a string.
 * @see https://www.oauth.com/oauth2-servers/pkce/authorization-request/
 */
const encode = (value: string) =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(input: string) {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return String.fromCharCode(...new Uint8Array(hashBuffer));
}

/**
 * Create a Code Challenge from a provided Code Verifier (assumes S256 `code_challenge_method`).
 * @see https://www.rfc-editor.org/rfc/rfc7636#section-4.2
 */
export async function generateCodeChallenge(verifier: string) {
  const hashed = await sha256(verifier);
  return encode(hashed);
}

/**
 * Similar to `#src/util/google_oauth2.ts` `waitForAuthResponseMessage`, but incorporates PKCE.
 */
export async function waitForPKCEResponseMessage({
  source,
  client_id,
  verifier,
  state,
  redirect_uri,
  cancellationToken,
}: {
  source: Window;
  client_id: string;
  verifier: string;
  state: string;
  redirect_uri: string;
  cancellationToken: CancellationToken;
}): Promise<OAuth2Credentials> {
  const context = new RefCounted();
  try {
    return await new Promise((resolve, reject) => {
      context.registerDisposer(cancellationToken.add(() => reject(CANCELED)));
      console.log("Waiting for message");
      context.registerEventListener(
        window,
        "message",
        (event: MessageEvent) => {
          console.log(event);

          if (event.origin !== location.origin) {
            return;
          }

          if (event.source !== source) return;

          try {
            const obj = verifyObject(event.data);
            const receivedState = verifyObjectProperty(
              obj,
              "state",
              verifyString,
            );
            if (receivedState !== state) {
              throw new Error("invalid state");
            }

            const receivedCode = verifyObjectProperty(
              obj,
              "code",
              verifyString,
            );

            if (receivedCode === undefined) {
              throw new Error("missing code");
            }

            const payload = {
              code: receivedCode,
              client_id,
              code_verifier: verifier,
              grant_type: "authorization_code",
              redirect_uri,
            };

            fetch("https://auth.globus.org/v2/oauth2/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams(payload).toString(),
            }).then((response) => {
              if (!response.ok) {
                throw new Error("Failed to exchange code for token");
              }

              response.json().then((json) => {
                console.log(json);
                resolve({
                  accessToken: json.access_token,
                  tokenType: json.token_type,
                  // expiresIn: json.expires_in,
                  // scope: json.scope,
                  // email: extractEmailFromIdToken(json.id_token),
                });
              });
            });

            // const response = await(
            //   await oauth2.token.exchange({
            //     payload,
            //   }),
            // ).json();

            // console.log(response);

            // const idToken = verifyObjectProperty(obj, "id_token", verifyString);
            // const token: OAuth2Token = {
            //   accessToken: verifyObjectProperty(
            //     obj,
            //     "access_token",
            //     verifyString,
            //   ),
            //   tokenType: verifyObjectProperty(obj, "token_type", verifyString),
            //   expiresIn: verifyObjectProperty(obj, "expires_in", verifyString),
            //   scope: verifyObjectProperty(obj, "scope", verifyString),
            //   email: extractEmailFromIdToken(idToken),
            // };
            // resolve(token);
          } catch (parseError) {
            reject(
              new Error(
                `Received unexpected authentication response: ${parseError.message}`,
              ),
            );
            console.error("Response received: ", event.data);
          }
        },
      );
    });
  } finally {
    context.dispose();
  }
}
