/**
 * @license
 * Copyright 2024 Google Inc.
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

import { type LifeCycleEventsMap, type SetupApi } from "msw";

interface RequestLogEntry {
  request: {
    url: string;
    headers?: string[];
    body?: string;
  };
  response: {
    status: number;
    body?: string;
  };
}

export function mswRequestLog(
  msw: SetupApi<LifeCycleEventsMap>,
  options: {
    redact?: string[];
  } = {},
) {
  const redactPatterns = [
    "(?<=http://localhost:)[0-9]+",
    ...(options.redact ?? []),
  ];
  const redactRegexp = new RegExp(
    redactPatterns.map((s) => `(?:${s})`).join("|"),
    "g",
  );
  const redact = (s: string) => s.replaceAll(redactRegexp, "*");
  const getHeaders = (headers: Headers): { headers?: string[] } => {
    const list: string[] = [];
    for (const [name, value] of headers.entries()) {
      if (name === "accept" || name === "content-type") {
        continue;
      }
      list.push(redact(`${name}: ${value}`));
    }
    if (list.length === 0) return {};
    return { headers: list };
  };
  const getBody = async (r: Request | Response): Promise<{ body?: string }> => {
    const body = redact(await r.text());
    if (!body) return {};
    return { body };
  };
  const log: Promise<RequestLogEntry>[] = [];
  const outstandingRequests = new Map<
    string,
    { resolve: (value: RequestLogEntry) => void }
  >();
  const handler = async ({
    request,
    response,
    requestId,
  }: {
    request: Request;
    response: Response;
    requestId: string;
  }) => {
    const resolvers = outstandingRequests.get(requestId);
    if (resolvers === undefined) return;
    outstandingRequests.delete(requestId);
    request = request.clone();
    response = response.clone();
    const entry: RequestLogEntry = {
      request: {
        url: redact(request.url),
        ...getHeaders(request.headers),
        ...(await getBody(request)),
      },
      response: {
        status: response.status,
        ...(await getBody(response)),
      },
    };
    resolvers.resolve(entry);
  };
  const requestHandler = ({
    request,
    requestId,
  }: {
    request: Request;
    requestId: string;
  }) => {
    if (new URL(request.url).origin === window.origin) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<RequestLogEntry>();
    outstandingRequests.set(requestId, { resolve });
    log.push(promise);
  };
  // request:start event is always sequenced before the `fetch` resolves, but
  // `response:*` events sometimes don't. To avoid missing events, log entries
  // are added on `response:start` and resolved by the corresponding
  // `response:*` event.
  msw.events.on("request:start", requestHandler);
  msw.events.on("response:mocked", handler);
  msw.events.on("response:bypass", handler);
  return {
    [Symbol.dispose]: () => {
      msw.events.removeListener("request:start", requestHandler);
      msw.events.removeListener("response:mocked", handler);
      msw.events.removeListener("response:bypass", handler);
    },
    log,
    popAll: () => {
      const result = log.slice();
      log.length = 0;
      return Promise.all(result);
    },
  };
}
