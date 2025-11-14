/**
 * @license
 * Copyright 2025 Google Inc.
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
import { fetchOk } from "#src/util/http_request.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

interface SsaConfiguration {
  // OIDC issuer for the SSA deployment.
  issuer: string;
}

interface OidcConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
}

function parseSsaConfiguration(json: unknown): SsaConfiguration {
  const obj = verifyObject(json);
  const issuer = verifyObjectProperty(obj, "issuer", verifyString);
  return { issuer };
}

async function discoverSsaConfiguration(
  workerOrigin: string,
): Promise<SsaConfiguration> {
  const response = await fetchOk(
    `${workerOrigin}/.well-known/ssa-configuration`,
  );
  const config = parseSsaConfiguration(await response.json());
  return config;
}

async function discoverOpenIdConfiguration(
  issuer: string,
): Promise<OidcConfiguration> {
  const response = await fetchOk(`${issuer}/.well-known/openid-configuration`);
  const json = verifyObject(await response.json());
  const authorization_endpoint = verifyObjectProperty(
    json,
    "authorization_endpoint",
    verifyString,
  );
  const token_endpoint = verifyObjectProperty(
    json,
    "token_endpoint",
    verifyString,
  );
  return { authorization_endpoint, token_endpoint };
}

interface OidcCodeMessage {
  type: "oidc_code";
  code: string;
  state: string;
}

async function waitForOidcCodeMessage(
  expectedOrigin: string,
  source: Window,
  signal: AbortSignal,
): Promise<OidcCodeMessage> {
  return new Promise((resolve, reject) => {
    window.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (event.source !== source) return;
        if (event.origin !== expectedOrigin) return;
        try {
          const data = verifyObject(event.data);
          const type = verifyObjectProperty(data, "type", verifyString);
          if (type !== "oidc_code") return;
          const code = verifyObjectProperty(data, "code", verifyString);
          const state = verifyObjectProperty(data, "state", verifyString);
          resolve({ type: "oidc_code", code, state });
        } catch (e) {
          reject(
            new Error(
              `Received unexpected OIDC authorization response: ${(e as Error).message}`,
            ),
          );
        }
      },
      { signal },
    );
  });
}

function openPopupCentered(url: string, width: number, height: number) {
  const top =
    window.outerHeight -
    window.innerHeight +
    window.innerHeight / 2 -
    height / 2;
  const left = window.innerWidth / 2 - width / 2;
  const popup = window.open(
    url,
    undefined,
    `toolbar=no, menubar=no, width=${width}, height=${height}, top=${top}, left=${left}`,
  );
  if (popup === null) {
    throw new Error("Failed to create authentication popup window");
  }
  return popup;
}

function base64UrlEncode(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(digest);
}

function generateRandomAscii(length: number): string {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const random = new Uint8Array(length);
  crypto.getRandomValues(random);
  let s = "";
  for (let i = 0; i < length; ++i) {
    s += charset[random[i] % charset.length];
  }
  return s;
}

async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = generateRandomAscii(128);
  const challenge = base64UrlEncode(
    await sha256Bytes(new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

interface StoredSsaToken {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number;
  email?: string;
}

function getLocalStorageKeyForWorker(workerOrigin: string): string {
  return `ssa_oidc_token_${workerOrigin}`;
}

function loadStoredSsaToken(workerOrigin: string): StoredSsaToken | null {
  const key = getLocalStorageKeyForWorker(workerOrigin);
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const parsed = JSON.parse(raw);
  const obj = verifyObject(parsed);
  const accessToken = verifyObjectProperty(obj, "accessToken", verifyString);
  const refreshToken = verifyObjectProperty(obj, "refreshToken", verifyString);
  const tokenType = verifyObjectProperty(obj, "tokenType", verifyString);
  const expiresAt = Number(
    verifyObjectProperty(obj, "expiresAt", (v) => {
      if (typeof v !== "number") throw new Error("expiresAt must be a number");
      return v;
    }),
  );
  const email = verifyOptionalObjectProperty(obj, "email", verifyString);
  return { accessToken, refreshToken, tokenType, expiresAt, email };
}

function saveStoredSsaToken(workerOrigin: string, value: StoredSsaToken): void {
  const key = getLocalStorageKeyForWorker(workerOrigin);
  localStorage.setItem(key, JSON.stringify(value));
}

function clearStoredSsaToken(workerOrigin: string): void {
  const key = getLocalStorageKeyForWorker(workerOrigin);
  localStorage.removeItem(key);
}

export class SsaCredentialsProvider extends CredentialsProvider<OAuth2Credentials> {
  constructor(public readonly workerOrigin: string) {
    super();
    try {
      // Throws if invalid URL.
      const parsed = new URL(workerOrigin);
      if (parsed.origin !== workerOrigin) {
        throw new Error("workerOrigin must be an origin like https://host");
      }
    } catch (e) {
      throw new Error(`Invalid worker origin ${JSON.stringify(workerOrigin)}`, {
        cause: e,
      });
    }
  }

  private async performInteractiveLogin(
    options: ProgressOptions,
  ): Promise<StoredSsaToken> {
    using _span = new ProgressSpan(options.progressListener, {
      message: `Requesting SSA login via ${this.workerOrigin}`,
    });

    const { issuer } = await discoverSsaConfiguration(this.workerOrigin);
    const { authorization_endpoint, token_endpoint } =
      await discoverOpenIdConfiguration(issuer);

    const clientId = "neuroglancer";
    const redirectUri = `${location.origin}/`;
    const scope = "openid profile email";
    const state = generateRandomAscii(32);
    const { verifier: codeVerifier, challenge: codeChallenge } =
      await createPkcePair();

    const authParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    const popupUrl = `${authorization_endpoint}?${authParams.toString()}`;

    await getCredentialsWithStatus<OAuth2Credentials>(
      {
        description: `SSA at ${this.workerOrigin}`,
        requestDescription: "login",
        get: async (innerSignal) => {
          const abortController = new AbortController();
          const combined = AbortSignal.any([
            abortController.signal,
            innerSignal,
            options.signal,
          ]);
          try {
            const popup = openPopupCentered(popupUrl, 450, 700);
            monitorAuthPopupWindow(popup, abortController);
            const appOrigin = new URL(redirectUri).origin;
            const { code, state: returnedState } = await raceWithAbort(
              waitForOidcCodeMessage(appOrigin, popup, abortController.signal),
              combined,
            );
            if (returnedState !== state) {
              throw new Error("OIDC state mismatch detected");
            }
            const tokenResp = await fetchOk(token_endpoint, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                client_id: clientId,
                code_verifier: codeVerifier,
              }),
              signal: combined,
            });
            const tokenJson = verifyObject(await tokenResp.json());
            const access_token = verifyObjectProperty(
              tokenJson,
              "access_token",
              verifyString,
            );
            const token_type = verifyObjectProperty(
              tokenJson,
              "token_type",
              verifyString,
            );
            const refresh_token = verifyObjectProperty(
              tokenJson,
              "refresh_token",
              verifyString,
            );
            const expires_in = Number(
              verifyObjectProperty(tokenJson, "expires_in", (v) => {
                if (typeof v !== "number")
                  throw new Error("expires_in must be a number");
                return v;
              }),
            );
            const email = verifyOptionalObjectProperty(
              tokenJson,
              "email",
              verifyString,
            );
            const stored: StoredSsaToken = {
              accessToken: access_token,
              refreshToken: refresh_token,
              tokenType: token_type,
              expiresAt: Date.now() + expires_in * 1000,
              email,
            };
            saveStoredSsaToken(this.workerOrigin, stored);
            return { tokenType: token_type, accessToken: access_token, email };
          } finally {
            abortController.abort();
          }
        },
      },
      options.signal,
    );

    // The above getCredentialsWithStatus returns OAuth2Credentials. We already saved full token.
    const stored = loadStoredSsaToken(this.workerOrigin);
    if (stored === null) {
      throw new Error(
        "Failed to persist SSA token to localStorage after interactive login",
      );
    }
    return stored;
  }

  private async refreshTokenSilently(
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<StoredSsaToken> {
    const { issuer } = await discoverSsaConfiguration(this.workerOrigin);
    const { token_endpoint } = await discoverOpenIdConfiguration(issuer);
    const clientId = "neuroglancer";

    const resp = await fetchOk(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      signal,
    });
    const json = verifyObject(await resp.json());
    const access_token = verifyObjectProperty(
      json,
      "access_token",
      verifyString,
    );
    const token_type = verifyObjectProperty(json, "token_type", verifyString);
    const new_refresh =
      verifyOptionalObjectProperty(json, "refresh_token", verifyString) ??
      refreshToken;
    const expires_in = Number(
      verifyObjectProperty(json, "expires_in", (v) => {
        if (typeof v !== "number")
          throw new Error("expires_in must be a number");
        return v;
      }),
    );
    const email = verifyOptionalObjectProperty(json, "email", verifyString);
    const stored: StoredSsaToken = {
      accessToken: access_token,
      refreshToken: new_refresh,
      tokenType: token_type,
      expiresAt: Date.now() + expires_in * 1000,
      email,
    };
    saveStoredSsaToken(this.workerOrigin, stored);
    return stored;
  }

  get = makeCredentialsGetter(async (options) => {
    // 1) Try localStorage
    const existing = loadStoredSsaToken(this.workerOrigin);
    if (existing !== null) {
      if (Date.now() < existing.expiresAt) {
        return {
          tokenType: existing.tokenType,
          accessToken: existing.accessToken,
          email: existing.email,
        };
      }
      // Try silent refresh
      try {
        const refreshed = await this.refreshTokenSilently(
          existing.refreshToken,
          options.signal,
        );
        return {
          tokenType: refreshed.tokenType,
          accessToken: refreshed.accessToken,
          email: refreshed.email,
        };
      } catch {
        clearStoredSsaToken(this.workerOrigin);
        // Fall through to interactive login
      }
    }

    // 4) Interactive login
    const stored = await this.performInteractiveLogin(options);
    return {
      tokenType: stored.tokenType,
      accessToken: stored.accessToken,
      email: stored.email,
    };
  });
}
