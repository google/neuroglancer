import type { LifeCycleEventsMap, SetupApi } from "msw";
import { setupServer } from "msw/node";
import { afterEach } from "vitest";
import type { Fixture } from "#tests/fixtures/fixture.js";
import { fixture } from "#tests/fixtures/fixture.js";

export function mswFixture(): Fixture<SetupApi<LifeCycleEventsMap>> {
  const mswServer = fixture(async (stack) => {
    const server = setupServer();
    stack.defer(() => server.close());
    server.listen();
    return server;
  });

  afterEach(async () => (await mswServer()).resetHandlers());

  return mswServer;
}
