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
import type { CatmaidIntegrationConfig } from "./catmaid_integration_fixture.js";

export type GatePhase = "beforeRequest" | "afterResponse";
export interface TransportRecord {
  method: string;
  endpoint: string;
  body: Record<string, string>;
  mutation: boolean;
  forwarded?: number;
  acknowledged?: number;
  status?: number;
  response?: any;
  failed?: boolean;
}

export class OneShotGate {
  private arrival = Promise.withResolvers<TransportRecord>();
  private continuation = Promise.withResolvers<boolean>();
  readonly reached = this.arrival.promise;
  readonly released = this.continuation.promise;
  used = false;
  constructor(
    readonly endpoint: string,
    readonly phase: GatePhase,
    readonly method: string,
  ) {}
  async pause(record: TransportRecord) {
    this.used = true;
    this.arrival.resolve(record);
    return this.continuation.promise;
  }
  release() {
    this.continuation.resolve(true);
  }
  cancel() {
    this.used = true;
    this.continuation.resolve(false);
  }
}

export function isCatmaidMutation(method: string, endpoint: string): boolean {
  return (
    method === "POST" &&
    /^(?:node\/update|treenode\/(?:create|insert|delete)|treenode\/\d+\/radius|treenodes\/\d+\/confidence|label\/treenode\/\d+\/(?:update|remove)|skeleton\/(?:split|join|reroot))$/.test(
      endpoint,
    )
  );
}

/** Changes timing only: CATMAID performs all reads and writes. */
export class CatmaidTransport {
  readonly records: TransportRecord[] = [];
  readonly gates: OneShotGate[] = [];
  private active = new Set<Promise<void>>();
  private closing = false;
  private sequence = 0;
  private unacknowledged = 0;
  maxUnacknowledgedMutations = 0;
  constructor(
    private context: BrowserContext,
    private config: CatmaidIntegrationConfig,
  ) {}
  get mutations() {
    return this.records.filter((record) => record.mutation);
  }
  hold(endpoint: string, phase: GatePhase = "beforeRequest", method = "POST") {
    const gate = new OneShotGate(endpoint, phase, method);
    this.gates.push(gate);
    return gate;
  }
  private matches = (url: URL) =>
    url.origin === new URL(this.config.baseUrl).origin;
  private handler = (route: Route) => {
    const task = this.forward(route);
    this.active.add(task);
    return task.finally(() => this.active.delete(task));
  };
  async install() {
    await this.context.route(this.matches, this.handler);
  }
  private async pause(record: TransportRecord, phase: GatePhase) {
    const gate = this.gates.find(
      (candidate) =>
        !candidate.used &&
        candidate.phase === phase &&
        candidate.endpoint === record.endpoint &&
        candidate.method === record.method,
    );
    return gate === undefined ? !this.closing : gate.pause(record);
  }
  private async forward(route: Route) {
    if (this.closing) {
      await route.abort();
      return;
    }
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const cors = {
      "access-control-allow-origin": headers.origin ?? "*",
      "access-control-allow-headers": "Authorization, Content-Type, Accept",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const endpoint = url.pathname
      .replace(new RegExp(`^/${this.config.projectId}/`), "")
      .replace(/^\//, "");
    const method = request.method();
    const record: TransportRecord = {
      method,
      endpoint,
      mutation: isCatmaidMutation(method, endpoint),
      body: Object.fromEntries(new URLSearchParams(request.postData() ?? "")),
    };
    this.records.push(record);
    let counted = false;
    try {
      if (!(await this.pause(record, "beforeRequest")) || this.closing) {
        await route.abort();
        return;
      }
      delete headers.cookie;
      delete headers.authorization;
      delete headers["x-authorization"];
      record.forwarded = ++this.sequence;
      if (record.mutation) {
        counted = true;
        this.maxUnacknowledgedMutations = Math.max(
          this.maxUnacknowledgedMutations,
          ++this.unacknowledged,
        );
      }
      const response = await route.fetch({
        headers: { ...headers, authorization: `Token ${this.config.apiToken}` },
        maxRedirects: 0,
        maxRetries: 0,
        timeout: 30_000,
      });
      record.status = response.status();
      if (record.mutation) record.response = await response.json();
      if (!(await this.pause(record, "afterResponse")) || this.closing) {
        await route.abort();
        return;
      }
      await route.fulfill({
        response,
        headers: { ...response.headers(), ...cors },
      });
      record.acknowledged = ++this.sequence;
    } catch {
      // Transport exceptions may include credentials. Record only their occurrence.
      record.failed = true;
      await route.abort().catch(() => {});
    } finally {
      if (counted) --this.unacknowledged;
    }
  }
  async close() {
    this.closing = true;
    for (const gate of this.gates) gate.cancel();
    await Promise.allSettled(this.active);
    for (const page of this.context.pages()) await page.close();
    await this.context.unroute(this.matches, this.handler);
  }
}
