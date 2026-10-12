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

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** CATMAID units: coordinates/radius in nm, confidence from 1 through 5. */
export interface TestNode {
  id: number;
  parentId: number | null;
  skeletonId: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  confidence: number;
  labels: string[];
}

export interface MutationRecord {
  sequence: number;
  path: string;
  body: Record<string, string>;
  startedAt: number;
  completedAt?: number;
  response: unknown;
  status: number;
}

export interface HeldMutation {
  /** Resolves after the request commits, before its response is released. */
  received: Promise<MutationRecord>;
  release(): void;
}

export function makeCatmaidTestNodes(): TestNode[] {
  return [10, 20].flatMap((skeletonId, chain) =>
    [1, 2, 3].map((index) => ({
      id: (chain + 1) * 100 + index,
      parentId: index === 1 ? null : (chain + 1) * 100 + index - 1,
      skeletonId,
      x: index * 1000,
      y: 1000 + chain * 2000,
      z: 1000,
      radius: 40,
      confidence: 5,
      labels: [],
    })),
  );
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function numberParameter(body: URLSearchParams, name: string): number {
  const text = body.get(name);
  const value = Number(text);
  if (text === null || text.trim() === "" || !Number.isFinite(value)) {
    throw new RequestError(`Missing or invalid parameter: ${name}`);
  }
  return value;
}

/**
 * A deliberately small HTTP implementation of the CATMAID endpoints used by the
 * editing adapter. It owns a persisted parent graph, independently of all
 * production preview/reducer code. It does not simulate CATMAID permissions,
 * annotation-based merge swaps, or revision conflicts.
 *
 * Holding a response delays acknowledgement, not the commit. Tests can inspect
 * local previews while a real fetch is pending without timing-based sleeps.
 */
export async function startCatmaidMockServer() {
  let nodes = new Map<number, TestNode>();
  let nextNodeId = 1001;
  let nextSkeletonId = 30;
  let revision = 0;
  let inFlightMutations = 0;
  let maxInFlightMutations = 0;
  const mutations: MutationRecord[] = [];
  const unknownRequests: string[] = [];
  const holds: Array<{
    path?: string;
    received: (record: MutationRecord) => void;
    released: Promise<void>;
    release: () => void;
    claimed: boolean;
  }> = [];

  function reset(initialNodes = makeCatmaidTestNodes()) {
    if (inFlightMutations !== 0) {
      throw new Error(
        "Drain held mutation responses before resetting fixtures.",
      );
    }
    for (const hold of holds) hold.release();
    holds.length = 0;
    nodes = new Map(
      initialNodes.map((node) => [node.id, structuredClone(node)]),
    );
    nextNodeId = Math.max(1000, ...nodes.keys()) + 1;
    nextSkeletonId = Math.max(29, ...initialNodes.map((n) => n.skeletonId)) + 1;
    revision = 0;
    mutations.length = 0;
    unknownRequests.length = 0;
    maxInFlightMutations = 0;
    assertGraph();
  }

  function snapshot(): TestNode[] {
    return structuredClone([...nodes.values()].sort((a, b) => a.id - b.id));
  }

  function node(id: number): TestNode {
    const result = nodes.get(id);
    if (result === undefined) throw new RequestError(`Unknown node ${id}`, 404);
    return result;
  }

  function skeleton(id: number): TestNode[] {
    return [...nodes.values()].filter((n) => n.skeletonId === id);
  }

  function children(id: number): TestNode[] {
    return [...nodes.values()].filter((n) => n.parentId === id);
  }

  function descendants(id: number): TestNode[] {
    return [
      node(id),
      ...children(id).flatMap((child) => descendants(child.id)),
    ];
  }

  function assertGraph() {
    for (const skeletonId of new Set(
      [...nodes.values()].map((n) => n.skeletonId),
    )) {
      const members = skeleton(skeletonId);
      const roots = members.filter((n) => n.parentId === null);
      if (roots.length !== 1)
        throw new Error(`Skeleton ${skeletonId} has ${roots.length} roots`);
      for (const member of members) {
        const seen = new Set<number>();
        let current = member;
        while (current.parentId !== null) {
          if (seen.has(current.id))
            throw new Error("Cycle in test backend parent graph");
          seen.add(current.id);
          current = node(current.parentId);
          if (current.skeletonId !== skeletonId)
            throw new Error("Cross-skeleton parent link");
        }
      }
    }
  }

  // Reverse only the path to the old root. Branches retain their parent links.
  function reroot(id: number) {
    const path: TestNode[] = [];
    let current: TestNode | undefined = node(id);
    while (current !== undefined) {
      path.push(current);
      current = current.parentId === null ? undefined : node(current.parentId);
    }
    const confidences = path.map((n) => n.confidence);
    for (let i = 0; i < path.length; ++i) {
      path[i].parentId = i === 0 ? null : path[i - 1].id;
      // Confidence belongs to an edge in CATMAID; the root is confidence 5.
      path[i].confidence = i === 0 ? 5 : confidences[i - 1];
    }
  }

  function editionTime() {
    return new Date(Date.UTC(2026, 0, 1) + revision * 1000).toISOString();
  }

  function mutate(path: string, body: URLSearchParams): unknown {
    ++revision;
    const edition = editionTime();
    if (path === "node/update") {
      const oldRows: unknown[][] = [];
      for (let i = 0; body.has(`t[${i}][0]`); ++i) {
        const target = node(numberParameter(body, `t[${i}][0]`));
        oldRows.push([target.id, edition, target.x, target.y, target.z]);
        target.x = numberParameter(body, `t[${i}][1]`);
        target.y = numberParameter(body, `t[${i}][2]`);
        target.z = numberParameter(body, `t[${i}][3]`);
      }
      if (oldRows.length === 0)
        throw new RequestError("No treenode updates supplied");
      return { updated: oldRows.length, old_treenodes: oldRows };
    }
    if (path === "treenode/create" || path === "treenode/insert") {
      const parentId = numberParameter(body, "parent_id");
      const parent = parentId < 0 ? undefined : node(parentId);
      const takenChildren: TestNode[] = [];
      if (path === "treenode/insert") {
        if (parent === undefined)
          throw new RequestError("Insert requires a parent");
        takenChildren.push(node(numberParameter(body, "child_id")));
        for (const [key, value] of body) {
          if (/^takeover_child_ids\[\d+\]$/.test(key))
            takenChildren.push(node(Number(value)));
        }
        if (takenChildren.some((n) => n.parentId !== parentId)) {
          throw new RequestError(
            "Insert children must belong to the supplied parent",
          );
        }
      }
      const created: TestNode = {
        id: nextNodeId++,
        parentId: parent?.id ?? null,
        skeletonId: parent?.skeletonId ?? nextSkeletonId++,
        x: numberParameter(body, "x"),
        y: numberParameter(body, "y"),
        z: numberParameter(body, "z"),
        radius: 0,
        confidence: 0,
        labels: [],
      };
      nodes.set(created.id, created);
      for (const child of takenChildren) child.parentId = created.id;
      return {
        treenode_id: created.id,
        skeleton_id: created.skeletonId,
        edition_time: edition,
        parent_edition_time: parent ? edition : undefined,
        child_edition_times: takenChildren.map((n) => [n.id, edition]),
      };
    }
    if (path === "treenode/delete") {
      const target = node(numberParameter(body, "treenode_id"));
      const reattached = children(target.id);
      if (target.parentId === null && reattached.length > 1) {
        throw new RequestError("Cannot delete a root with more than one child");
      }
      for (const child of reattached) child.parentId = target.parentId;
      nodes.delete(target.id);
      return {
        success: true,
        children: reattached.map((n) => [n.id, edition]),
      };
    }
    if (path === "skeleton/reroot") {
      const id = numberParameter(body, "treenode_id");
      reroot(id);
      return { newroot: id };
    }
    if (path === "skeleton/split") {
      const target = node(numberParameter(body, "treenode_id"));
      if (target.parentId === null)
        throw new RequestError("Cannot split at a root");
      const existingId = target.skeletonId;
      const detached = descendants(target.id);
      const newId = nextSkeletonId++;
      for (const member of detached) member.skeletonId = newId;
      target.parentId = null;
      return { existing_skeleton_id: existingId, new_skeleton_id: newId };
    }
    if (path === "skeleton/join") {
      const from = node(numberParameter(body, "from_id"));
      const to = node(numberParameter(body, "to_id"));
      if (from.skeletonId === to.skeletonId)
        throw new RequestError("Cannot join a skeleton to itself");
      const deletedId = to.skeletonId;
      const joined = skeleton(deletedId);
      if (to.parentId !== null) reroot(to.id);
      to.parentId = from.id;
      for (const member of joined) member.skeletonId = from.skeletonId;
      return {
        result_skeleton_id: from.skeletonId,
        deleted_skeleton_id: deletedId,
        stable_annotation_swap: false,
      };
    }
    const radiusMatch = path.match(/^treenode\/(\d+)\/radius$/);
    if (radiusMatch !== null) {
      const target = node(Number(radiusMatch[1]));
      target.radius = numberParameter(body, "radius");
      return { updated_nodes: { [target.id]: { edition_time: edition } } };
    }
    const confidenceMatch = path.match(/^treenodes\/(\d+)\/confidence$/);
    if (confidenceMatch !== null) {
      const target = node(Number(confidenceMatch[1]));
      target.confidence = numberParameter(body, "new_confidence");
      return { updated_nodes: { [target.id]: { edition_time: edition } } };
    }
    const labelMatch = path.match(/^label\/treenode\/(\d+)\/(update|remove)$/);
    if (labelMatch !== null) {
      const target = node(Number(labelMatch[1]));
      if (labelMatch[2] === "remove") {
        target.labels = target.labels.filter(
          (label) => label !== body.get("tag"),
        );
      } else {
        const incoming = (body.get("tags") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        target.labels = [
          ...new Set([
            ...(body.get("delete_existing") === "true" ? [] : target.labels),
            ...incoming,
          ]),
        ];
      }
      return { success: true, edition_time: edition };
    }
    unknownRequests.push(`POST /1/${path}`);
    throw new RequestError(`Unhandled mutation: ${path}`, 404);
  }

  function send(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Authorization, Authorization",
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/^\/1\//, "").replace(/\/$/, "");
    if (request.method === "POST" && url.pathname.startsWith("/1/")) {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const body = new URLSearchParams(raw);
      const record: MutationRecord = {
        sequence: mutations.length + 1,
        path,
        body: Object.fromEntries(body),
        startedAt: performance.now(),
        response: undefined,
        status: 200,
      };
      mutations.push(record);
      ++inFlightMutations;
      maxInFlightMutations = Math.max(maxInFlightMutations, inFlightMutations);
      // Preserve transaction-like semantics if a malformed test request fails.
      const before = snapshot();
      try {
        record.response = mutate(path, body);
        assertGraph();
      } catch (error) {
        nodes = new Map(before.map((n) => [n.id, n]));
        record.status = error instanceof RequestError ? error.status : 500;
        record.response = { error: String(error) };
      }
      const hold = holds.find(
        (h) => !h.claimed && (h.path === undefined || h.path === path),
      );
      if (hold !== undefined) {
        hold.claimed = true;
        hold.received(record);
        await hold.released;
      }
      record.completedAt = performance.now();
      --inFlightMutations;
      send(response, record.status, record.response);
      return;
    }
    if (request.method === "GET") {
      if (url.pathname === "/accounts/anonymous-api-token") {
        send(response, 200, { token: "local-test-token" });
        return;
      }
      if (path === "stacks") {
        send(response, 200, [{ id: 1 }]);
        return;
      }
      if (path === "stack/1/info") {
        send(response, 200, {
          dimension: { x: 10000, y: 10000, z: 10000 },
          resolution: { x: 1, y: 1, z: 1 },
          translation: { x: 0, y: 0, z: 0 },
          metadata: {
            read_only: false,
            spatial: [{ chunk_size: [10000, 10000, 10000], limit: 0 }],
          },
        });
        return;
      }
      if (path === "skeletons") {
        send(
          response,
          200,
          [...new Set([...nodes.values()].map((n) => n.skeletonId))].sort(
            (a, b) => a - b,
          ),
        );
        return;
      }
      const compactMatch = path.match(/^skeletons\/(\d+)\/compact-detail$/);
      if (compactMatch !== null) {
        const members = skeleton(Number(compactMatch[1]));
        if (members.length === 0) {
          send(response, 404, { error: "Skeleton not found" });
          return;
        }
        send(response, 200, [
          members.map((n) => [
            n.id,
            n.parentId,
            1,
            n.x,
            n.y,
            n.z,
            n.radius,
            n.confidence,
            editionTime(),
          ]),
          [],
          Object.fromEntries(members.map((n) => [n.id, n.labels])),
        ]);
        return;
      }
      if (path === "node/list") {
        const p = url.searchParams;
        const members = [...nodes.values()].filter(
          (n) =>
            n.x >= Number(p.get("left")) &&
            n.x <= Number(p.get("right")) &&
            n.y >= Number(p.get("top")) &&
            n.y <= Number(p.get("bottom")) &&
            n.z >= Number(p.get("z1")) &&
            n.z <= Number(p.get("z2")),
        );
        send(response, 200, [
          members.map((n) => [
            n.id,
            n.parentId,
            n.x,
            n.y,
            n.z,
            n.confidence,
            n.radius,
            n.skeletonId,
            editionTime(),
            1,
          ]),
          [],
          {},
          false,
          [],
          [],
        ]);
        return;
      }
    }
    const description = `${request.method} ${url.pathname}`;
    unknownRequests.push(description);
    send(response, 404, {
      error: `Unhandled test backend request: ${description}`,
    });
  }

  reset();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      unknownRequests.push(`Handler error: ${String(error)}`);
      if (!response.headersSent) send(response, 500, { error: String(error) });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    sourceUrl: `catmaid://${url}/1`,
    reset,
    snapshot,
    mutations,
    unknownRequests,
    get maxInFlightMutations() {
      return maxInFlightMutations;
    },
    get inFlightMutations() {
      return inFlightMutations;
    },
    holdNextMutation(path?: string): HeldMutation {
      path = path?.replace(/^\/?1\//, "").replace(/^\//, "");
      let received!: (record: MutationRecord) => void;
      let release!: () => void;
      const result = new Promise<MutationRecord>((resolve) => {
        received = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ path, received, released, release, claimed: false });
      return { received: result, release };
    },
    async close() {
      for (const hold of holds) hold.release();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

export type CatmaidMockServer = Awaited<
  ReturnType<typeof startCatmaidMockServer>
>;
