import type { LifeCycleEventsMap, SetupApi } from "msw";
import { http, passthrough } from "msw";
import { setupWorker, type SetupWorkerApi } from "msw/browser";
import { afterEach } from "vitest";
import type { Fixture } from "#tests/fixtures/fixture.js";
import { fixture } from "#tests/fixtures/fixture.js";

export function mswFixture(): Fixture<SetupApi<LifeCycleEventsMap>> {
  const mswServer = fixture(async (stack) => {
    const server = setupWorker(
      http.get("/*", () => passthrough()),
    ) as SetupWorkerApi;
    stack.defer(() => server.stop());
    await server.start();
    return server;
  });

  afterEach(async () => (await mswServer()).resetHandlers());

  return mswServer;
}
