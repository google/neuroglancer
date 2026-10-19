/**
 * @license
 * Copyright 2026 Google Inc.
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

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalizeCatmaidServerUrl,
  CatmaidCredentialsProvider,
  type CatmaidTokenStorage,
  getCatmaidTokenStorageKey,
} from "#src/datasource/catmaid/credentials_provider.js";
import { statusMessages } from "#src/status.js";

class MemoryTokenStorage implements CatmaidTokenStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function mockAnonymousToken(token = "anonymous-token") {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ token }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function submitPersonalToken(token: string) {
  await vi.waitFor(() => {
    expect(
      document.querySelector('input[aria-label="CATMAID API token"]'),
    ).not.toBeNull();
  });
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="CATMAID API token"]',
  )!;
  input.value = token;
  input.form!.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const status of statusMessages) {
    status.dispose();
  }
});

describe("CatmaidCredentialsProvider", () => {
  it("canonicalizes server URLs and storage keys", () => {
    expect(canonicalizeCatmaidServerUrl("https://catmaid.example///")).toBe(
      "https://catmaid.example",
    );
    expect(getCatmaidTokenStorageKey("https://catmaid.example/")).toContain(
      "https://catmaid.example",
    );
  });

  it("uses anonymous credentials first when no personal token is stored", async () => {
    const fetchMock = mockAnonymousToken();
    const provider = new CatmaidCredentialsProvider(
      "https://catmaid.example/",
      new MemoryTokenStorage(),
    );

    await expect(provider.get()).resolves.toMatchObject({
      credentials: { token: "anonymous-token", kind: "anonymous" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://catmaid.example/accounts/anonymous-api-token",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("prompts after anonymous rejection and persists the personal token", async () => {
    const fetchMock = mockAnonymousToken();
    const storage = new MemoryTokenStorage();
    const provider = new CatmaidCredentialsProvider(
      "https://catmaid.example",
      storage,
    );
    const anonymous = await provider.get();

    const personalPromise = provider.get(anonymous);
    await submitPersonalToken(" personal-token ");

    await expect(personalPromise).resolves.toMatchObject({
      credentials: { token: "personal-token", kind: "personal" },
    });
    expect(
      storage.getItem(getCatmaidTokenStorageKey("https://catmaid.example")),
    ).toBe("personal-token");

    const reloadedProvider = new CatmaidCredentialsProvider(
      "https://catmaid.example/",
      storage,
    );
    await expect(reloadedProvider.get()).resolves.toMatchObject({
      credentials: { token: "personal-token", kind: "personal" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears a rejected personal token and validates its replacement", async () => {
    const storage = new MemoryTokenStorage();
    storage.setItem(
      getCatmaidTokenStorageKey("https://catmaid.example"),
      "rejected-token",
    );
    const provider = new CatmaidCredentialsProvider(
      "https://catmaid.example",
      storage,
    );
    const rejected = await provider.get();

    const replacementPromise = provider.get(rejected);
    await submitPersonalToken("   ");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "non-empty",
    );
    await submitPersonalToken("replacement-token");

    await expect(replacementPromise).resolves.toMatchObject({
      credentials: { token: "replacement-token", kind: "personal" },
    });
    expect(
      storage.getItem(getCatmaidTokenStorageKey("https://catmaid.example")),
    ).toBe("replacement-token");
  });

  it("aborts and removes an outstanding token prompt", async () => {
    mockAnonymousToken();
    const provider = new CatmaidCredentialsProvider(
      "https://catmaid.example",
      new MemoryTokenStorage(),
    );
    const anonymous = await provider.get();
    const abortController = new AbortController();
    const reason = new Error("cancelled");

    const personalPromise = provider.get(anonymous, {
      signal: abortController.signal,
    });
    await vi.waitFor(() => {
      expect(
        document.querySelector('input[aria-label="CATMAID API token"]'),
      ).not.toBeNull();
    });
    abortController.abort(reason);

    await expect(personalPromise).rejects.toBe(reason);
    expect(
      document.querySelector('input[aria-label="CATMAID API token"]'),
    ).toBeNull();
  });
});
