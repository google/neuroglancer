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

import type { BrowserContext, Route } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { withCatmaidProject } from "./catmaid_project.js";
import { CatmaidTransport } from "./catmaid_transport.js";

const config = {
  baseUrl: "http://127.0.0.1:8000",
  projectId: 19,
  apiToken: "test-secret",
};

async function harness() {
  let handler!: (route: Route) => Promise<void>;
  const close = vi.fn(async () => {});
  const context = {
    route: vi.fn(async (_matcher, callback) => {
      handler = callback;
    }),
    pages: () => [{ close }],
    unroute: vi.fn(async () => {}),
  };
  const transport = new CatmaidTransport(
    context as unknown as BrowserContext,
    config,
  );
  await transport.install();
  function request(endpoint: string, method = "POST", project = 19) {
    const response = {
      status: () => 200,
      json: async () => ({ treenode_id: 777 }),
      headers: () => ({ "content-type": "application/json" }),
    };
    const route = {
      request: () => ({
        url: () =>
          `${config.baseUrl}/${project ? `${project}/` : ""}${endpoint}`,
        method: () => method,
        postData: () => "parent_id=91",
        allHeaders: async () => ({
          origin: "http://localhost:8080",
          authorization: "old-token",
          cookie: "old-session",
        }),
      }),
      fetch: vi.fn(async (_options) => response),
      fulfill: vi.fn(async (_options) => {}),
      abort: vi.fn(async () => {}),
    };
    const done = handler(route as unknown as Route);
    return { route, response, done };
  }
  return { transport, request, close };
}

describe("real CATMAID timing transport", () => {
  it("holds one matching method/project/endpoint before forwarding", async () => {
    const { transport, request } = await harness();
    const gate = transport.hold("treenode/create");
    await request("treenode/create", "GET").done;
    await request("treenode/create", "POST", 20).done;
    await request("skeleton/split").done;
    expect(gate.used).toBe(false);
    const first = request("treenode/create");
    await gate.reached;
    expect(first.route.fetch).not.toHaveBeenCalled();
    gate.release();
    await first.done;
    const next = request("treenode/create");
    await next.done;
    expect(next.route.fetch).toHaveBeenCalledTimes(1);
    expect(first.route.fulfill.mock.calls[0][0].response).toBe(first.response);
    await transport.close();
  });

  it("holds the actual response after CATMAID finishes, then delivers that response unchanged", async () => {
    const { transport, request } = await harness();
    const gate = transport.hold("skeleton/split", "afterResponse");
    const call = request("skeleton/split");
    const record = await gate.reached;
    expect(call.route.fetch).toHaveBeenCalledTimes(1);
    expect(record.response).toEqual({ treenode_id: 777 });
    expect(call.route.fulfill).not.toHaveBeenCalled();
    gate.release();
    await call.done;
    expect(call.route.fulfill.mock.calls[0][0].response).toBe(call.response);
    expect(record.acknowledged).toBeGreaterThan(record.forwarded!);
    await transport.close();
  });

  it("forwards the real authentication bootstrap and supplies token/CORS headers", async () => {
    const { transport, request } = await harness();
    const call = request("accounts/login", "GET", 0);
    await call.done;
    expect(call.route.fetch.mock.calls[0][0].headers).toEqual({
      origin: "http://localhost:8080",
      authorization: "Token test-secret",
    });
    expect(call.route.fulfill.mock.calls[0][0]).toEqual({
      response: call.response,
      headers: expect.objectContaining({
        "access-control-allow-origin": "http://localhost:8080",
      }),
    });
    expect(transport.mutations).toEqual([]);
    await transport.close();
  });

  it("teardown cancels an unsent request without forwarding it", async () => {
    const { transport, request, close } = await harness();
    const gate = transport.hold("treenode/create");
    const call = request("treenode/create");
    await gate.reached;
    await transport.close();
    await call.done;
    expect(call.route.fetch).not.toHaveBeenCalled();
    expect(call.route.abort).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("teardown waits for an already forwarded request before closing the browser", async () => {
    const { transport, request, close } = await harness();
    const gate = transport.hold("treenode/create");
    const call = request("treenode/create");
    await gate.reached;
    const finished = Promise.withResolvers<typeof call.response>();
    call.route.fetch.mockImplementationOnce(() => finished.promise);
    gate.release();
    await vi.waitFor(() => expect(call.route.fetch).toHaveBeenCalled());
    const closing = transport.close();
    expect(close).not.toHaveBeenCalled();
    finished.resolve(call.response);
    await closing;
    await call.done;
    expect(close).toHaveBeenCalledTimes(1);
    expect(call.route.fulfill).not.toHaveBeenCalled();
  });
});

describe("owned project lifetime", () => {
  it.each([
    "normal",
    "fixture failure",
    "test failure",
    "browser cleanup failure",
  ])("removes the project after %s", async (phase) => {
    const close = vi.fn(async () => {});
    const createProject = vi.fn(async () => ({ config, close }));
    const result = withCatmaidProject(
      { createProject },
      phase,
      async (actual) => {
        expect(actual).toBe(config);
        if (phase !== "normal") throw new Error(phase);
        return "finished";
      },
    );
    if (phase === "normal") await expect(result).resolves.toBe("finished");
    else await expect(result).rejects.toThrow(phase);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
