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

import { pack } from "msgpackr";
import { describe, expect, it, vi } from "vitest";

import {
  CatmaidClient,
  getDefaultCatmaidChunkSize,
} from "#src/datasource/catmaid/api.js";
import { HttpError } from "#src/util/http_request.js";

type FetchMock = ReturnType<typeof vi.fn>;

function getFetchCall(fetchMock: FetchMock, callIndex = 0) {
  const call = fetchMock.mock.calls[callIndex];
  if (call === undefined) {
    throw new Error(`Expected fetch call ${callIndex + 1} to exist.`);
  }
  return call;
}

function getFetchPath(fetchMock: FetchMock, callIndex = 0) {
  return getFetchCall(fetchMock, callIndex)[0];
}

function getFetchBody(fetchMock: FetchMock, callIndex = 0) {
  const [, requestInit] = getFetchCall(fetchMock, callIndex);
  if (requestInit === undefined || typeof requestInit !== "object") {
    throw new Error(
      `Expected fetch call ${callIndex + 1} to include request options.`,
    );
  }
  const body = (requestInit as { body?: unknown }).body;
  if (!(body instanceof URLSearchParams)) {
    throw new Error(
      `Expected fetch call ${callIndex + 1} to include a URLSearchParams body.`,
    );
  }
  return body;
}

function getFetchInit(fetchMock: FetchMock, callIndex = 0) {
  const [, requestInit] = getFetchCall(fetchMock, callIndex);
  if (requestInit === undefined || typeof requestInit !== "object") {
    throw new Error(
      `Expected fetch call ${callIndex + 1} to include request options.`,
    );
  }
  return requestInit as RequestInit & { priority?: unknown };
}

describe("CatmaidClient", () => {
  it("does not cache transient metadata discovery failures as null", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (client as any).listStacks = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary stack lookup failure"))
      .mockResolvedValueOnce([{ id: 7, title: "stack" }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {
        spatial: [{ chunk_size: [15, 15, 15], limit: 1 }],
      },
    });

    await expect(client.getSpatialIndexMetadata()).resolves.toBeNull();
    await expect(client.getSpatialIndexMetadata()).resolves.toEqual({
      bounds: {
        lowerBounds: Float64Array.of(5, 6, 7),
        upperBounds: Float64Array.of(25, 66, 127),
      },
      readonly: true,
      spatial: [
        {
          chunkSize: [15, 15, 15],
          limit: 1,
        },
      ],
    });

    expect((client as any).listStacks).toHaveBeenCalledTimes(2);
    expect((client as any).getStackInfo).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("reports a stack as editable when its metadata says it is not read-only", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {
        read_only: false,
        spatial: [{ chunk_size: [15, 15, 15], limit: 1 }],
      },
    });

    await expect(client.getSpatialIndexMetadata()).resolves.toMatchObject({
      readonly: false,
    });
  });

  it.each([
    ["missing", {}],
    ["empty", { spatial: [] }],
  ])(
    "falls back to one default level when the stack lists no spatial levels (%s)",
    async (_case, metadata) => {
      const client = new CatmaidClient("https://example.invalid", 1);
      (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
      (client as any).getStackInfo = vi.fn().mockResolvedValue({
        dimension: { x: 10, y: 20, z: 30 },
        resolution: { x: 2, y: 3, z: 4 },
        translation: { x: 5, y: 6, z: 7 },
        metadata,
      });

      await expect(client.getSpatialIndexMetadata()).resolves.toEqual({
        bounds: {
          lowerBounds: Float64Array.of(5, 6, 7),
          upperBounds: Float64Array.of(25, 66, 127),
        },
        readonly: true,
        spatial: [
          {
            chunkSize: [15, 15, 15],
            limit: 0,
          },
        ],
      });
    },
  );

  it("reads the spatial index levels and cache provider from stack metadata", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {
        cache_provider: "cached_msgpack_grid",
        read_only: true,
        spatial: [
          {
            chunk_size: [11168145, 11168145, 11168145],
            limit: 500,
          },
          {
            chunk_size: [6632497, 6632497, 6632497],
            limit: 500,
          },
          {
            chunk_size: [3939000, 3939000, 3939000],
            limit: 7000,
          },
          {
            chunk_size: [2339000, 2339000, 2339000],
            limit: 27500,
          },
          {
            chunk_size: [1500000, 1500000, 1500000],
            limit: 70000,
          },
        ],
      },
    });

    await expect(client.getSpatialIndexMetadata()).resolves.toEqual({
      bounds: {
        lowerBounds: Float64Array.of(5, 6, 7),
        upperBounds: Float64Array.of(25, 66, 127),
      },
      readonly: true,
      spatial: [
        {
          chunkSize: [11168145, 11168145, 11168145],
          limit: 500,
        },
        {
          chunkSize: [6632497, 6632497, 6632497],
          limit: 500,
        },
        {
          chunkSize: [3939000, 3939000, 3939000],
          limit: 7000,
        },
        {
          chunkSize: [2339000, 2339000, 2339000],
          limit: 27500,
        },
        {
          chunkSize: [1500000, 1500000, 1500000],
          limit: 70000,
        },
      ],
    });
    await expect(client.getCacheProvider()).resolves.toBe(
      "cached_msgpack_grid",
    );
  });

  it("lists anisotropic levels from coarsest to finest whatever order the stack metadata gives", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {
        spatial: [
          { chunk_size: [2000, 2000, 40], limit: 0 },
          { chunk_size: [4000, 4000, 40], limit: 500 },
        ],
      },
    });

    const metadata = await client.getSpatialIndexMetadata();

    expect(metadata?.spatial).toEqual([
      { chunkSize: [4000, 4000, 40], limit: 500 },
      { chunkSize: [2000, 2000, 40], limit: 0 },
    ]);
  });

  it("accepts a zero node limit on the finest level", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {
        spatial: [
          { chunk_size: [30, 30, 30], limit: 10 },
          { chunk_size: [15, 15, 15], limit: 0 },
        ],
      },
    });

    await expect(client.getSpatialIndexMetadata()).resolves.toMatchObject({
      spatial: [{ limit: 10 }, { limit: 0 }],
    });
  });

  it("loads a skeleton's nodes, descriptions and true ends in one request", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue([
      [
        [
          22107946,
          null,
          2,
          23697030.0,
          15055839.0,
          16651262.0,
          2000.0,
          5,
          "2026-03-29T10:15:00Z",
        ],
        [
          22107955,
          22107954,
          2,
          23705874.0,
          15093672.0,
          16682375.0,
          2000.0,
          5,
          "2026-03-29T10:16:00Z",
        ],
        [
          22107959,
          22107958,
          2,
          23704520.0,
          15085237.0,
          16708998.0,
          2000.0,
          5,
          "2026-03-29T10:17:00Z",
        ],
      ],
      [],
      {
        "afonso reviewed it": [22107946],
        "test 123 4": [
          [22107955, "2026-03-29 10:16:00.000000+00:00"],
          [22107955, "2026-03-29 10:15:30.000000+00:00"],
        ],
        "stale description": [[22107955, "2026-03-29 10:15:45.000000+00:00"]],
        ends: [[22107959, "2026-03-29 10:17:00.000000+00:00"]],
      },
      [],
      [],
    ]);
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.getSkeleton(2n)).resolves.toEqual([
      {
        nodeId: 22107946n,
        parentNodeId: undefined,
        position: new Float32Array([23697030, 15055839, 16651262]),
        segmentId: 2n,
        description: "afonso reviewed it",
        attributes: { radius: [2000], confidence: [100] },
      },
      {
        nodeId: 22107955n,
        parentNodeId: 22107954n,
        position: new Float32Array([23705874, 15093672, 16682375]),
        segmentId: 2n,
        description: "test 123 4",
        attributes: { radius: [2000], confidence: [100] },
      },
      {
        nodeId: 22107959n,
        parentNodeId: 22107958n,
        position: new Float32Array([23704520, 15085237, 16708998]),
        segmentId: 2n,
        description: undefined,
        attributes: { radius: [2000], confidence: [100], true_end: [1] },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getFetchPath(fetchMock)).toBe(
      "skeletons/2/compact-detail?with_tags=true",
    );
  });

  it("treats every compact-detail 404 payload as an absent skeleton", async () => {
    for (const body of [
      "",
      JSON.stringify({ error: "Unknown skeleton" }),
      JSON.stringify({ detail: "Skeleton was removed" }),
    ]) {
      const client = new CatmaidClient("https://example.invalid", 1);
      const response = new Response(body, {
        status: 404,
        statusText: "Not Found",
      });
      (client as any).fetchProjectEndpoint = vi
        .fn()
        .mockRejectedValue(HttpError.fromResponse(response));

      await expect(client.getSkeleton(17n)).resolves.toEqual([]);
    }
  });

  it("parses raw comma labels from compact-detail as descriptions", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue([
      [
        [
          22107946,
          null,
          2,
          23697030.0,
          15055839.0,
          16651262.0,
          2000.0,
          5,
          "2026-03-29T10:15:00Z",
        ],
      ],
      [],
      {
        "left, branch": [[22107946, "2026-03-29 10:15:00.000000+00:00"]],
      },
      [],
      [],
    ]);
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.getSkeleton(2n)).resolves.toEqual([
      {
        nodeId: 22107946n,
        parentNodeId: undefined,
        position: new Float32Array([23697030, 15055839, 16651262]),
        segmentId: 2n,
        description: "left, branch",
        attributes: { radius: [2000], confidence: [100] },
      },
    ]);
  });

  it("loads a skeleton and warns when one tag names an invalid node", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).fetchProjectEndpoint = vi.fn().mockResolvedValue([
      [[22107946, null, 2, 1, 2, 3, 2000, 5, "2026-03-29T10:15:00Z"]],
      [],
      {
        reviewed: [
          [22107946, "2026-03-29 10:15:00.000000+00:00"],
          [2 ** 53 + 2, "2026-03-29 10:16:00.000000+00:00"],
        ],
      },
      [],
      [],
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(client.getSkeleton(2n)).resolves.toMatchObject([
        { nodeId: 22107946n, description: "reviewed" },
      ]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("decodes compact-detail sentinel labels without treating them as true ends", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue([
      [
        [
          22107946,
          null,
          2,
          23697030.0,
          15055839.0,
          16651262.0,
          2000.0,
          5,
          "2026-03-29T10:15:00Z",
        ],
        [
          22107955,
          22107946,
          2,
          23705874.0,
          15093672.0,
          16682375.0,
          2000.0,
          5,
          "2026-03-29T10:16:00Z",
        ],
      ],
      [],
      {
        "plain stale description": [
          [22107946, "2026-03-29 10:14:00.000000+00:00"],
        ],
        "plain duplicate": [[22107955, "2026-03-29 10:16:00.000000+00:00"]],
        "neuroglancer-description:v1:left%2C%20branch": [
          [22107946, "2026-03-29 10:15:00.000000+00:00"],
          [22107955, "2026-03-29 10:16:00.000000+00:00"],
        ],
        ends: [[22107955, "2026-03-29 10:16:00.000000+00:00"]],
      },
      [],
      [],
    ]);
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.getSkeleton(2n)).resolves.toEqual([
      {
        nodeId: 22107946n,
        parentNodeId: undefined,
        position: new Float32Array([23697030, 15055839, 16651262]),
        segmentId: 2n,
        description: "left, branch",
        attributes: { radius: [2000], confidence: [100] },
      },
      {
        nodeId: 22107955n,
        parentNodeId: 22107946n,
        position: new Float32Array([23705874, 15093672, 16682375]),
        segmentId: 2n,
        description: "left, branch",
        attributes: { radius: [2000], confidence: [100], true_end: [1] },
      },
    ]);
  });

  it("loads skeleton rows that have no edition time column", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue([
        [[22107946, null, 2, 23697030.0, 15055839.0, 16651262.0, 2000.0, 5]],
        [],
        {},
        [],
        [],
      ]);
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.getSkeleton(2n)).resolves.toEqual([
      {
        nodeId: 22107946n,
        parentNodeId: undefined,
        position: new Float32Array([23697030, 15055839, 16651262]),
        segmentId: 2n,
        description: undefined,
        attributes: { radius: [2000], confidence: [100] },
      },
    ]);
  });

  const editRows: readonly {
    name: string;
    call: (client: CatmaidClient) => Promise<unknown>;
    response: object;
    result?: object;
    path: string;
    fields: Record<string, string | null>;
  }[] = [
    {
      name: "merge",
      call: (client) => client.mergeSkeletons(101n, 202n),
      response: {
        result_skeleton_id: 17,
        deleted_skeleton_id: 21,
        stable_annotation_swap: true,
      },
      result: {
        resultSegmentId: 17n,
        deletedSegmentId: 21n,
        directionAdjusted: true,
      },
      path: "skeleton/join",
      fields: { from_id: "101", to_id: "202" },
    },
    {
      name: "add node",
      call: (client) => client.addNode(1, 2, 3, 7n),
      response: { treenode_id: 88, skeleton_id: 13 },
      result: { nodeId: 88n, segmentId: 13n },
      path: "treenode/create",
      fields: { parent_id: "7", skeleton_id: null },
    },
    {
      name: "insert node",
      call: (client) => client.insertNode(1, 2, 3, 7n, [11n, 12n]),
      response: { treenode_id: 89, skeleton_id: 13 },
      result: { nodeId: 89n, segmentId: 13n },
      path: "treenode/insert",
      fields: {
        parent_id: "7",
        child_id: "11",
        "takeover_child_ids[0]": "12",
        skeleton_id: null,
      },
    },
    {
      name: "reroot",
      call: (client) => client.rerootSkeleton(202n),
      response: { newroot: 202, skeleton_id: 17 },
      path: "skeleton/reroot",
      fields: { treenode_id: "202" },
    },
    {
      name: "split",
      call: (client) => client.splitSkeleton(202n),
      response: { existing_skeleton_id: 17, new_skeleton_id: 21 },
      result: { existingSegmentId: 17n, newSegmentId: 21n },
      path: "skeleton/split",
      fields: { treenode_id: "202", downstream_annotation_map: "{}" },
    },
    {
      name: "move",
      call: (client) => client.moveNode(42n, 10, 11, 12),
      response: { updated: 1 },
      path: "node/update",
      fields: {},
    },
    {
      name: "delete",
      call: (client) => client.deleteNode(11n),
      response: { success: "Removed treenode successfully." },
      path: "treenode/delete",
      fields: { treenode_id: "11" },
    },
    {
      name: "radius",
      call: (client) => client.updateRadius(11n, 25),
      response: {},
      path: "treenode/11/radius",
      fields: { radius: "25" },
    },
    {
      name: "confidence",
      call: (client) => client.updateConfidence(11n, 75),
      response: {},
      path: "treenodes/11/confidence",
      fields: {},
    },
  ];

  it.each(editRows.map((row) => [row.name, row] as const))(
    "sends the %s request with CATMAID's edition check turned off",
    async (_name, { call, response, path, fields }) => {
      const client = new CatmaidClient("https://example.invalid", 1);
      const fetchMock = vi.fn().mockResolvedValue(response);
      (client as any).fetchProjectEndpoint = fetchMock;

      await call(client);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getFetchPath(fetchMock)).toBe(path);
      const requestBody = getFetchBody(fetchMock);
      for (const [field, value] of Object.entries(fields)) {
        expect(requestBody.get(field)).toBe(value);
      }
      expect(requestBody.get("nocheck")).toBeNull();
      expect(requestBody.get("state")).toBe(JSON.stringify({ nocheck: true }));
    },
  );

  it.each(
    editRows
      .filter((row) => row.result !== undefined)
      .map((row) => [row.name, row] as const),
  )(
    "reads CATMAID's reply to the %s request",
    async (_name, { call, response, result }) => {
      const client = new CatmaidClient("https://example.invalid", 1);
      (client as any).fetchProjectEndpoint = vi
        .fn()
        .mockResolvedValue(response);

      await expect(call(client)).resolves.toEqual(result);
    },
  );

  it("lists the nodes in a region at low fetch priority", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue([
      [
        [101, null, 1, 2, 3, 5, 2000, 11, "2026-03-29T11:50:00Z", 2],
        [102, 101, 4, 5, 6, 5, 2000, 17, "2026-03-29T11:51:00Z", 2],
      ],
      [],
      {},
      false,
      [],
      [],
    ]);
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.fetchNodes({
        lowerBounds: Float64Array.of(0, 0, 0),
        upperBounds: Float64Array.of(10, 10, 10),
      }),
    ).resolves.toEqual([
      {
        nodeId: 101n,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 11n,
      },
      {
        nodeId: 102n,
        parentNodeId: 101n,
        position: new Float32Array([4, 5, 6]),
        segmentId: 17n,
      },
    ]);

    expect(getFetchPath(fetchMock)).toMatch(/^node\/list\?/);
    expect(
      new URLSearchParams(getFetchPath(fetchMock).split("?")[1]).get("lod"),
    ).toBe("0");
    expect(getFetchInit(fetchMock).priority).toBe("low");
  });

  it("requests node/list at the level of detail the source asks for", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue([[], [], {}, false, [], []]);
    (client as any).fetchProjectEndpoint = fetchMock;

    await client.fetchNodes(
      {
        lowerBounds: Float64Array.of(0, 0, 0),
        upperBounds: Float64Array.of(10, 10, 10),
      },
      0.5,
    );

    expect(
      new URLSearchParams(getFetchPath(fetchMock).split("?")[1]).get("lod"),
    ).toBe("0.5");
  });

  it("rejects CATMAID node-list bounds with fewer than three coordinates", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn();
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.fetchNodes({
        lowerBounds: Float64Array.of(0, 0),
        upperBounds: Float64Array.of(10, 10),
      }),
    ).rejects.toThrow(/requires at least 3 coordinates/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "move",
    "delete",
    "reroot",
    "true-end",
    "radius",
    "confidence",
  ] as const)(
    "accepts a %s acknowledgement without edition metadata",
    async (operation) => {
      const client = new CatmaidClient("https://example.invalid", 1);
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ success: true, newroot: 11 });
      (client as any).fetchProjectEndpoint = fetchMock;
      const mutations = {
        move: () => client.moveNode(11n, 1, 2, 3),
        delete: () => client.deleteNode(11n),
        reroot: () => client.rerootSkeleton(11n),
        "true-end": () => client.toggleTrueEnd(11n, true),
        radius: () => client.updateRadius(11n, 25),
        confidence: () => client.updateConfidence(11n, 75),
      };

      await expect(mutations[operation]()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects reroot when CATMAID reports a different new root", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      newroot: 203,
      skeleton_id: 17,
      edition_time: "2026-03-29T12:08:00Z",
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.rerootSkeleton(202n)).rejects.toThrow(
      "CATMAID skeleton/reroot did not return the requested new root.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updates a description without CATMAID's edition check state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ edition_time: "2026-03-29T13:00:00Z" });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.updateDescription(11n, "updated description"),
    ).resolves.toEqual({
      description: "updated description",
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("state")).toBeNull();
    expect(requestBody.get("tags")).toBe("updated description");
    expect(requestBody.get("delete_existing")).toBe("true");
  });

  it("encodes comma descriptions as one comma-free CATMAID label", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ edition_time: "2026-03-29T13:01:00Z" });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.updateDescription(11n, " left, branch \n LEFT, BRANCH \n ends "),
    ).resolves.toEqual({
      description: "left, branch",
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("tags")).toBe(
      "neuroglancer-description:v1:left%2C%20branch",
    );
    expect(requestBody.get("tags")).not.toContain(",");
    expect(requestBody.get("delete_existing")).toBe("true");
  });

  it("encodes sentinel-prefixed descriptions even without commas", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ edition_time: "2026-03-29T13:02:00Z" });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.updateDescription(11n, "neuroglancer-description:v1:left"),
    ).resolves.toEqual({
      description: "neuroglancer-description:v1:left",
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("tags")).toBe(
      "neuroglancer-description:v1:neuroglancer-description%3Av1%3Aleft",
    );
  });

  it("preserves true-end labels while replacing description labels", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ edition_time: "2026-03-29T13:05:00Z" });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.updateDescription(11n, "updated description\nends", {
        isTrueEnd: true,
      }),
    ).resolves.toEqual({
      description: "updated description",
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("tags")).toBe("updated description,ends");
    expect(requestBody.get("delete_existing")).toBe("true");
  });

  it("preserves true-end labels while replacing comma descriptions", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ edition_time: "2026-03-29T13:06:00Z" });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.updateDescription(11n, "left, branch\nends", {
        isTrueEnd: true,
      }),
    ).resolves.toEqual({
      description: "left, branch",
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("tags")).toBe(
      "neuroglancer-description:v1:left%2C%20branch,ends",
    );
    expect(requestBody.get("delete_existing")).toBe("true");
  });

  it("toggles a true end without CATMAID's edition check state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ edition_time: "2026-03-29T13:10:00Z" })
      .mockResolvedValueOnce({ edition_time: "2026-03-29T13:11:00Z" });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.toggleTrueEnd(11n, true)).resolves.toBeUndefined();
    await expect(client.toggleTrueEnd(11n, false)).resolves.toBeUndefined();

    const addTagRequestBody = getFetchBody(fetchMock, 0);
    const removeTagRequestBody = getFetchBody(fetchMock, 1);
    expect(addTagRequestBody.get("state")).toBeNull();
    expect(removeTagRequestBody.get("state")).toBeNull();
    expect(addTagRequestBody.get("tags")).toBe("ends");
    expect(addTagRequestBody.get("delete_existing")).toBe("false");
    expect(removeTagRequestBody.get("tag")).toBe("ends");
  });

  it("maps generic confidence percentages to CATMAID confidence levels", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      updated_partners: { "11": { edition_time: "2026-03-29T13:20:00Z" } },
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.updateConfidence(11n, 75)).resolves.toBeUndefined();

    expect(getFetchPath(fetchMock)).toBe("treenodes/11/confidence");
    expect(getFetchBody(fetchMock).get("new_confidence")).toBe("4");
    expect(getFetchBody(fetchMock).get("state")).toBe(
      JSON.stringify({ nocheck: true }),
    );
  });

  it("asks the user to refresh when CATMAID says the skeleton is out of date", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "StateMatchingError",
          error:
            "The provided state differs from the database state: {'edition_time': '2026-03-29T13:12:00Z'}",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    await expect(client.moveNode(11n, 1, 2, 3)).rejects.toThrow(
      "CATMAID rejected the edit because the inspected skeleton is out of date. Refresh the skeleton and try again.",
    );

    fetchMock.mockRestore();
  });

  // Provider rejections must reach the existing edit feedback without replacing
  // HTTP metadata used by other callers or consuming the original response body.
  it("surfaces deletion rejection instructions while preserving HTTP metadata", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const message =
      "This skeleton is associated with a task and cannot be deleted. Link the task to a different skeleton first.";
    const payload = {
      error: message,
      meta: { code: "task_skeleton_final_node" },
    };
    const response = new Response(JSON.stringify(payload), {
      status: 409,
      statusText: "Conflict",
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(response, "url", {
      value: "https://example.invalid/1/treenode/delete",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(client.deleteNode(7n)).rejects.toMatchObject({
      name: "HttpError",
      status: 409,
      response,
      message: `Fetching "https://example.invalid/1/treenode/delete" resulted in HTTP error 409: Conflict. ${message}`,
    });
    await expect(response.json()).resolves.toEqual(payload);

    fetchMock.mockRestore();
  });

  it("surfaces a non-empty detail only when the provider error field is absent", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "  This edit is not permitted.  ",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(client.deleteNode(7n)).rejects.toMatchObject({
      name: "HttpError",
      status: 403,
      message:
        'Fetching "" resulted in HTTP error 403. This edit is not permitted.',
    });

    fetchMock.mockRestore();
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-string fields", JSON.stringify({ error: 1, detail: {} })],
    ["empty fields", JSON.stringify({ error: " ", detail: "" })],
    ["non-object payload", JSON.stringify(["Invalid edit"])],
    [
      "blank error with traceback",
      JSON.stringify({
        error: " ",
        detail: "Traceback (most recent call last): private server paths",
      }),
    ],
    [
      "null error with traceback",
      JSON.stringify({
        error: null,
        detail: "Traceback (most recent call last): private server paths",
      }),
    ],
  ])("retains the HTTP fallback for %s", async (_name, body) => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(client.deleteNode(7n)).rejects.toMatchObject({
      name: "HttpError",
      status: 409,
      message: 'Fetching "" resulted in HTTP error 409.',
    });

    fetchMock.mockRestore();
  });

  it("keeps a CATMAID 400 that is not a stale-skeleton error as an HTTP error", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "ValueError",
          error: "No valid state provided, missing edition time",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );

    await expect(client.moveNode(11n, 1, 2, 3)).rejects.toMatchObject({
      name: "HttpError",
      status: 400,
    });

    fetchMock.mockRestore();
  });

  it.each([
    ["readable error", "Treenode 7 doesn't exist", "Treenode 7 doesn't exist"],
    ["blank error", "  ", "CATMAID resource not found."],
    ["null error", null, "CATMAID resource not found."],
  ])(
    "uses a safe message for a middleware 404 with %s",
    async (_kind, error, message) => {
      const client = new CatmaidClient("https://example.invalid", 1);
      const payload = {
        error,
        detail:
          "Traceback (most recent call last): private server paths; Treenode 7 doesn't exist",
        type: "Http404",
      };
      const response = new Response(JSON.stringify(payload), { status: 404 });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(response);
      try {
        await expect(client.deleteNode(7n)).rejects.toMatchObject({
          name: "CatmaidNotFoundError",
          message,
        });
        expect(response.bodyUsed).toBe(false);
        await expect(response.json()).resolves.toEqual(payload);
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it("shows the detail of a detail-only 404 when an edit fails", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const message = "Skeleton 456 doesn't exist";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ detail: message }), { status: 404 }),
      );
    try {
      await expect(client.deleteNode(7n)).rejects.toMatchObject({
        name: "CatmaidNotFoundError",
        message,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  // Transport failures must retain useful diagnostics and never display raw proxy pages.
  it.each(["read", "edit"] as const)(
    "retains HTTP diagnostics for a %s rejected by an HTML proxy page",
    async (operation) => {
      const client = new CatmaidClient("https://example.invalid", 1);
      const response = new Response(
        "<html><body>502 Bad Gateway</body></html>",
        {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/html" },
        },
      );
      Object.defineProperty(response, "url", {
        value: "https://example.invalid/1/endpoint",
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(response);
      try {
        const result =
          operation === "read"
            ? client.getSkeleton(456n)
            : client.deleteNode(7n);
        await expect(result).rejects.toMatchObject({
          name: "HttpError",
          status: 502,
          response,
          message:
            'Fetching "https://example.invalid/1/endpoint" resulted in HTTP error 502: Bad Gateway.',
        });
        expect(response.bodyUsed).toBe(false);
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it("keeps URL and status when appending a structured read failure", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const response = new Response(JSON.stringify({ error: "Read denied" }), {
      status: 403,
    });
    Object.defineProperty(response, "url", {
      value: "https://example.invalid/1/skeletons/456/compact-detail",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      await expect(client.getSkeleton(456n)).rejects.toMatchObject({
        name: "HttpError",
        status: 403,
        message:
          'Fetching "https://example.invalid/1/skeletons/456/compact-detail" resulted in HTTP error 403. Read denied',
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not append a traceback to a state-validation error when error is blank", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "StateMatchingError",
          error: "",
          detail: "Traceback (most recent call last): private server paths",
        }),
        { status: 400 },
      ),
    );
    try {
      await expect(client.deleteNode(7n)).rejects.toMatchObject({
        name: "CatmaidStateValidationError",
        message:
          "CATMAID rejected the edit because the inspected skeleton is out of date. Refresh the skeleton and try again.",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reads skeleton and node IDs above 2^53 exactly from a node list", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const row = [
      2n ** 53n + 1n,
      2n ** 53n + 3n,
      1.5,
      2.5,
      3.5,
      0,
      5,
      2n ** 63n + 5n,
    ];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new Uint8Array(pack([[row], [], {}, false]))),
      );
    try {
      await expect(
        client.fetchNodes({
          lowerBounds: Float64Array.of(0, 0, 0),
          upperBounds: Float64Array.of(10, 10, 10),
        }),
      ).resolves.toEqual([
        {
          nodeId: 2n ** 53n + 1n,
          parentNodeId: 2n ** 53n + 3n,
          position: new Float32Array([1.5, 2.5, 3.5]),
          segmentId: 2n ** 63n + 5n,
        },
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects a created node ID above 2^53 instead of rounding it", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).fetchProjectEndpoint = vi.fn().mockResolvedValue({
      treenode_id: 2 ** 53 + 2,
      skeleton_id: 13,
    });

    await expect(client.addNode(1, 2, 3)).rejects.toThrow(
      /too large to read exactly/,
    );
  });
});

describe("getDefaultCatmaidChunkSize", () => {
  it("keeps the chunk size isotropic for elongated bounds", () => {
    expect(
      getDefaultCatmaidChunkSize({
        lowerBounds: Float64Array.of(0, 0, 0),
        upperBounds: Float64Array.of(1000, 10, 10),
      }),
    ).toEqual([16, 16, 16]);
  });

  it("returns the minimum chunk size for tiny bounds", () => {
    expect(
      getDefaultCatmaidChunkSize({
        lowerBounds: Float64Array.of(0, 0, 0),
        upperBounds: Float64Array.of(2, 2, 2),
      }),
    ).toEqual([1, 1, 1]);
  });
});
