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
  CredentialsProvider,
  type CredentialsWithGeneration,
} from "#src/credentials_provider/index.js";
import {
  CatmaidClient,
  type CatmaidToken,
} from "#src/datasource/catmaid/api.js";

class SequenceCredentialsProvider extends CredentialsProvider<CatmaidToken> {
  calls: Array<CredentialsWithGeneration<CatmaidToken> | undefined> = [];

  constructor(private credentials: CatmaidToken[]) {
    super();
  }

  get: CredentialsProvider<CatmaidToken>["get"] = async (
    invalidCredentials,
  ) => {
    this.calls.push(invalidCredentials);
    const index = Math.min(this.calls.length - 1, this.credentials.length - 1);
    return {
      generation: this.calls.length,
      credentials: this.credentials[index],
    };
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status === 200 ? "OK" : "Forbidden",
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CatmaidClient authenticated requests", () => {
  it("retries anonymous 403 responses with refreshed credentials", async () => {
    const provider = new SequenceCredentialsProvider([
      { token: "anonymous-token", kind: "anonymous" },
      { token: "personal-token", kind: "personal" },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse([17]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CatmaidClient("https://catmaid.example", 1, provider);

    await expect(client.listSkeletons()).resolves.toEqual([17]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toMatchObject({
      credentials: { kind: "anonymous" },
    });
    expect(
      (fetchMock.mock.calls[0][1].headers as Headers).get("Authorization"),
    ).toBe("Token anonymous-token");
    expect(
      (fetchMock.mock.calls[1][1].headers as Headers).get("Authorization"),
    ).toBe("Token personal-token");
  });

  it("does not retry personal-token 403 responses", async () => {
    const provider = new SequenceCredentialsProvider([
      { token: "personal-token", kind: "personal" },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CatmaidClient("https://catmaid.example", 1, provider);

    await expect(client.listSkeletons()).rejects.toThrow("HTTP error 403");
    expect(provider.calls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replaces personal credentials after a 401 response", async () => {
    const provider = new SequenceCredentialsProvider([
      { token: "expired-token", kind: "personal" },
      { token: "replacement-token", kind: "personal" },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "invalid" }, 401))
      .mockResolvedValueOnce(jsonResponse([23]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CatmaidClient("https://catmaid.example", 1, provider);

    await expect(client.listSkeletons()).resolves.toEqual([23]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toMatchObject({
      credentials: { token: "expired-token", kind: "personal" },
    });
  });

  it("preserves caller and form headers while adding authorization", async () => {
    const provider = new SequenceCredentialsProvider([
      { token: "personal-token", kind: "personal" },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CatmaidClient("https://catmaid.example", 1, provider);

    await (client as any).fetchProjectEndpoint("test", {
      method: "POST",
      body: new URLSearchParams({ value: "1" }),
      headers: { "X-Test": "present" },
    });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Token personal-token");
    expect(headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headers.get("X-Test")).toBe("present");
  });
});
