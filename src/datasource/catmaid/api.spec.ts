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

import { describe, expect, it, vi } from "vitest";

import {
  CatmaidClient,
  getCatmaidSpatialSkeletonGridCellBounds,
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

describe("CatmaidClient skeleton editing methods", () => {
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
      lowerBounds: [5, 6, 7],
      upperBounds: [25, 66, 127],
      readonly: true,
      spatial: [
        {
          chunkSize: [15, 15, 15],
          gridShape: [2, 4, 8],
          limit: 1,
        },
      ],
    });

    expect((client as any).listStacks).toHaveBeenCalledTimes(2);
    expect((client as any).getStackInfo).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("honors explicit writable CATMAID spatial skeleton metadata", async () => {
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

  it("uses default CATMAID spatial skeleton metadata when spatial levels are missing", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {},
    });

    await expect(client.getSpatialIndexMetadata()).resolves.toEqual({
      lowerBounds: [5, 6, 7],
      upperBounds: [25, 66, 127],
      readonly: true,
      spatial: [
        {
          chunkSize: [15, 15, 15],
          gridShape: [2, 4, 8],
          limit: 0,
        },
      ],
    });
  });

  it("uses default CATMAID spatial skeleton metadata when spatial levels are empty", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {
        spatial: [],
      },
    });

    await expect(client.getSpatialIndexMetadata()).resolves.toMatchObject({
      spatial: [
        {
          chunkSize: [15, 15, 15],
          gridShape: [2, 4, 8],
          limit: 0,
        },
      ],
    });
  });

  it("reads spatial skeleton spatial index levels from stack metadata", async () => {
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
      lowerBounds: [5, 6, 7],
      upperBounds: [25, 66, 127],
      readonly: true,
      spatial: [
        {
          chunkSize: [11168145, 11168145, 11168145],
          gridShape: [1, 1, 1],
          limit: 500,
        },
        {
          chunkSize: [6632497, 6632497, 6632497],
          gridShape: [1, 1, 1],
          limit: 500,
        },
        {
          chunkSize: [3939000, 3939000, 3939000],
          gridShape: [1, 1, 1],
          limit: 7000,
        },
        {
          chunkSize: [2339000, 2339000, 2339000],
          gridShape: [1, 1, 1],
          limit: 27500,
        },
        {
          chunkSize: [1500000, 1500000, 1500000],
          gridShape: [1, 1, 1],
          limit: 70000,
        },
      ],
    });
    await expect(client.getCacheProvider()).resolves.toBe(
      "cached_msgpack_grid",
    );
  });

  it("accepts zero CATMAID spatial skeleton metadata limits", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {
        spatial: [{ chunk_size: [15, 15, 15], limit: 0 }],
      },
    });

    await expect(client.getSpatialIndexMetadata()).resolves.toMatchObject({
      spatial: [
        {
          limit: 0,
        },
      ],
    });
  });

  it("accepts zero CATMAID spatial skeleton metadata limits only on the finest level", async () => {
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

  it("rejects zero CATMAID spatial skeleton metadata limits on non-finest levels", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    (client as any).listStacks = vi.fn().mockResolvedValue([{ id: 7 }]);
    (client as any).getStackInfo = vi.fn().mockResolvedValue({
      dimension: { x: 10, y: 20, z: 30 },
      resolution: { x: 2, y: 3, z: 4 },
      translation: { x: 5, y: 6, z: 7 },
      metadata: {
        spatial: [
          { chunk_size: [30, 30, 30], limit: 0 },
          { chunk_size: [15, 15, 15], limit: 10 },
        ],
      },
    });

    await expect(client.getSpatialIndexMetadata()).rejects.toThrow(
      "Spatial skeleton limit: 0 is only supported on the finest source level.",
    );
  });

  it("parses compact-detail rows with edition times and labels in one request", async () => {
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

    await expect(client.getSkeleton(2)).resolves.toEqual([
      {
        nodeId: 22107946,
        parentNodeId: undefined,
        position: new Float32Array([23697030, 15055839, 16651262]),
        segmentId: 2,
        radius: 2000,
        confidence: 100,
        description: "afonso reviewed it",
        isTrueEnd: false,
      },
      {
        nodeId: 22107955,
        parentNodeId: 22107954,
        position: new Float32Array([23705874, 15093672, 16682375]),
        segmentId: 2,
        radius: 2000,
        confidence: 100,
        description: "test 123 4",
        isTrueEnd: false,
      },
      {
        nodeId: 22107959,
        parentNodeId: 22107958,
        position: new Float32Array([23704520, 15085237, 16708998]),
        segmentId: 2,
        radius: 2000,
        confidence: 100,
        description: undefined,
        isTrueEnd: true,
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

      await expect(client.getSkeleton(17)).resolves.toEqual([]);
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

    await expect(client.getSkeleton(2)).resolves.toEqual([
      {
        nodeId: 22107946,
        parentNodeId: undefined,
        position: new Float32Array([23697030, 15055839, 16651262]),
        segmentId: 2,
        radius: 2000,
        confidence: 100,
        description: "left, branch",
        isTrueEnd: false,
      },
    ]);
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

    await expect(client.getSkeleton(2)).resolves.toEqual([
      {
        nodeId: 22107946,
        parentNodeId: undefined,
        position: new Float32Array([23697030, 15055839, 16651262]),
        segmentId: 2,
        radius: 2000,
        confidence: 100,
        description: "left, branch",
        isTrueEnd: false,
      },
      {
        nodeId: 22107955,
        parentNodeId: 22107946,
        position: new Float32Array([23705874, 15093672, 16682375]),
        segmentId: 2,
        radius: 2000,
        confidence: 100,
        description: "left, branch",
        isTrueEnd: true,
      },
    ]);
  });

  it("reads compact-detail rows without requesting edition timestamps", async () => {
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

    await expect(client.getSkeleton(2)).resolves.toEqual([
      {
        nodeId: 22107946,
        parentNodeId: undefined,
        position: new Float32Array([23697030, 15055839, 16651262]),
        segmentId: 2,
        radius: 2000,
        confidence: 100,
        description: undefined,
        isTrueEnd: false,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getFetchPath(fetchMock)).toBe(
      "skeletons/2/compact-detail?with_tags=true",
    );
  });

  it("always merges skeletons with nocheck state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      result_skeleton_id: 17,
      deleted_skeleton_id: 21,
      stable_annotation_swap: true,
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.mergeSkeletons(101, 202)).resolves.toEqual({
      resultSegmentId: 17,
      deletedSegmentId: 21,
      directionAdjusted: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = getFetchBody(fetchMock);
    expect(getFetchPath(fetchMock)).toBe("skeleton/join");
    expect(requestBody.get("from_id")).toBe("101");
    expect(requestBody.get("to_id")).toBe("202");
    expect(requestBody.get("nocheck")).toBeNull();
    expect(requestBody.get("state")).toBe(JSON.stringify({ nocheck: true }));
  });

  it("parses browse node/list rows without retaining edition metadata", async () => {
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
        lowerBounds: [0, 0, 0],
        upperBounds: [10, 10, 10],
      }),
    ).resolves.toEqual([
      {
        nodeId: 101,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 11,
      },
      {
        nodeId: 102,
        parentNodeId: 101,
        position: new Float32Array([4, 5, 6]),
        segmentId: 17,
      },
    ]);

    expect(getFetchPath(fetchMock)).toMatch(/^node\/list\?/);
    expect(
      new URLSearchParams(getFetchPath(fetchMock).split("?")[1]).get("lod"),
    ).toBe("0");
    expect(getFetchInit(fetchMock).priority).toBe("low");
  });

  it("passes the CATMAID source-associated lod to node/list", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue([[], [], {}, false, [], []]);
    (client as any).fetchProjectEndpoint = fetchMock;

    await client.fetchNodes(
      {
        lowerBounds: [0, 0, 0],
        upperBounds: [10, 10, 10],
      },
      0.5,
    );

    expect(
      new URLSearchParams(getFetchPath(fetchMock).split("?")[1]).get("lod"),
    ).toBe("0.5");
  });

  it("converts spatial skeleton grid cell indices to CATMAID bounds", () => {
    expect(
      getCatmaidSpatialSkeletonGridCellBounds([2, 3, 4], [10, 20, 30]),
    ).toEqual({
      lowerBounds: [20, 60, 120],
      upperBounds: [30, 80, 150],
    });
  });

  it("rejects CATMAID node-list bounds with fewer than three coordinates", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn();
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.fetchNodes({
        lowerBounds: [0, 0],
        upperBounds: [10, 10],
      }),
    ).rejects.toThrow(/requires at least 3 coordinates/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("always sends addNode requests with nocheck CATMAID state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      treenode_id: 88,
      skeleton_id: 13,
      edition_time: "2026-03-29T12:00:00Z",
      parent_edition_time: "2026-03-29T12:00:01Z",
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.addNode(1, 2, 3, 7)).resolves.toMatchObject({
      nodeId: 88,
      segmentId: 13,
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("skeleton_id")).toBeNull();
    expect(requestBody.get("nocheck")).toBeNull();
    expect(requestBody.get("state")).toBe(JSON.stringify({ nocheck: true }));
  });

  it("always inserts nodes with nocheck state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      treenode_id: 89,
      skeleton_id: 13,
      edition_time: "2026-03-29T12:01:00Z",
      parent_edition_time: "2026-03-29T12:01:01Z",
      child_edition_times: [
        [11, "2026-03-29T12:01:02Z"],
        [12, "2026-03-29T12:01:03Z"],
      ],
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.insertNode(1, 2, 3, 7, [11, 12]),
    ).resolves.toMatchObject({
      nodeId: 89,
      segmentId: 13,
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("skeleton_id")).toBeNull();
    expect(requestBody.get("nocheck")).toBeNull();
    expect(requestBody.get("state")).toBe(JSON.stringify({ nocheck: true }));
  });

  it("always reroots skeletons with nocheck state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      newroot: 202,
      skeleton_id: 17,
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.rerootSkeleton(202)).resolves.toBeUndefined();

    const requestBody = getFetchBody(fetchMock);
    expect(getFetchPath(fetchMock)).toBe("skeleton/reroot");
    expect(requestBody.get("treenode_id")).toBe("202");
    expect(requestBody.get("nocheck")).toBeNull();
    expect(requestBody.get("state")).toBe(JSON.stringify({ nocheck: true }));
  });

  it("always splits skeletons with nocheck state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      existing_skeleton_id: 17,
      new_skeleton_id: 21,
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.splitSkeleton(202)).resolves.toEqual({
      existingSegmentId: 17,
      newSegmentId: 21,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = getFetchBody(fetchMock);
    expect(getFetchPath(fetchMock)).toBe("skeleton/split");
    expect(requestBody.get("treenode_id")).toBe("202");
    expect(requestBody.get("downstream_annotation_map")).toBe("{}");
    expect(requestBody.get("nocheck")).toBeNull();
    expect(requestBody.get("state")).toBe(JSON.stringify({ nocheck: true }));
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
        move: () => client.moveNode(11, 1, 2, 3),
        delete: () => client.deleteNode(11),
        reroot: () => client.rerootSkeleton(11),
        "true-end": () => client.toggleTrueEnd(11, true),
        radius: () => client.updateRadius(11, 25),
        confidence: () => client.updateConfidence(11, 75),
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

    await expect(client.rerootSkeleton(202)).rejects.toThrow(
      "CATMAID skeleton/reroot did not return the requested new root.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("always moves nodes with nocheck state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      updated: 1,
      old_treenodes: [[42, "2026-03-29T12:10:00Z", 1, 2, 3]],
      old_connectors: [],
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await client.moveNode(42, 10, 11, 12);

    expect(getFetchBody(fetchMock).get("state")).toBe(
      JSON.stringify({ nocheck: true }),
    );
  });

  it("always deletes nodes with nocheck state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      success: "Removed treenode successfully.",
      children: [[12, "2026-03-29T12:20:00Z"]],
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await client.deleteNode(11);

    expect(getFetchBody(fetchMock).get("state")).toBe(
      JSON.stringify({ nocheck: true }),
    );
  });

  it("always updates node radii with nocheck state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      updated_nodes: {
        "11": { edition_time: "2026-03-29T12:25:00Z" },
      },
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await client.updateRadius(11, 25);

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("nocheck")).toBeNull();
    expect(requestBody.get("state")).toBe(JSON.stringify({ nocheck: true }));
  });

  it("updates descriptions without CATMAID node state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ edition_time: "2026-03-29T13:00:00Z" });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(
      client.updateDescription(11, "updated description"),
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
      client.updateDescription(11, " left, branch \n LEFT, BRANCH \n ends "),
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
      client.updateDescription(11, "neuroglancer-description:v1:left"),
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
      client.updateDescription(11, "updated description\nends", {
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
      client.updateDescription(11, "left, branch\nends", {
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

  it("toggles true-end labels without CATMAID node state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ edition_time: "2026-03-29T13:10:00Z" })
      .mockResolvedValueOnce({ edition_time: "2026-03-29T13:11:00Z" });
    (client as any).fetchProjectEndpoint = fetchMock;

    await expect(client.toggleTrueEnd(11, true)).resolves.toBeUndefined();
    await expect(client.toggleTrueEnd(11, false)).resolves.toBeUndefined();

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

    await expect(client.updateConfidence(11, 75)).resolves.toBeUndefined();

    expect(getFetchPath(fetchMock)).toBe("treenodes/11/confidence");
    expect(getFetchBody(fetchMock).get("new_confidence")).toBe("4");
    expect(getFetchBody(fetchMock).get("state")).toBe(
      JSON.stringify({ nocheck: true }),
    );
  });

  it("updates confidence with nocheck state when requested", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      updated_partners: { "11": { edition_time: "2026-03-29T13:20:00Z" } },
    });
    (client as any).fetchProjectEndpoint = fetchMock;

    await client.updateConfidence(11, 75);

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("new_confidence")).toBe("4");
    expect(requestBody.get("nocheck")).toBeNull();
    expect(requestBody.get("state")).toBe(JSON.stringify({ nocheck: true }));
  });

  it("maps CATMAID state validation failures to a refresh-specific error", async () => {
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

    await expect(client.moveNode(11, 1, 2, 3)).rejects.toThrow(
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

    await expect(client.deleteNode(7)).rejects.toMatchObject({
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

    await expect(client.deleteNode(7)).rejects.toMatchObject({
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

    await expect(client.deleteNode(7)).rejects.toMatchObject({
      name: "HttpError",
      status: 409,
      message: 'Fetching "" resulted in HTTP error 409.',
    });

    fetchMock.mockRestore();
  });

  it("preserves generic CATMAID 400 value errors", async () => {
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

    await expect(client.moveNode(11, 1, 2, 3)).rejects.toMatchObject({
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
        await expect(client.deleteNode(7)).rejects.toMatchObject({
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

  it("preserves readable detail-only 404 handling for reads and edits", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const message = "Skeleton 456 doesn't exist";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ detail: message }), { status: 404 }),
      );
    try {
      await expect(client.getSkeleton(456)).resolves.toEqual([]);
      await expect(client.deleteNode(7)).rejects.toMatchObject({
        name: "CatmaidNotFoundError",
        message,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    ["read", "consumed"],
    ["edit", "consumed"],
    ["read", "locked"],
    ["edit", "locked"],
  ] as const)(
    "keeps HTTP diagnostics for a %s with a %s response",
    async (operation, bodyState) => {
      const client = new CatmaidClient("https://example.invalid", 1);
      const response = new Response(JSON.stringify({ error: "Conflict" }), {
        status: 409,
        statusText: "Conflict",
      });
      Object.defineProperty(response, "url", {
        value: "https://example.invalid/1/endpoint",
      });
      if (bodyState === "consumed") {
        await response.text();
      }
      const reader =
        bodyState === "locked" ? response.body!.getReader() : undefined;
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(response);
      try {
        const result =
          operation === "read" ? client.getSkeleton(456) : client.deleteNode(7);
        await expect(result).rejects.toMatchObject({
          name: "HttpError",
          status: 409,
          statusText: "Conflict",
          response,
          message:
            'Fetching "https://example.invalid/1/endpoint" resulted in HTTP error 409: Conflict.',
        });
        expect(response.bodyUsed).toBe(bodyState === "consumed");
      } finally {
        reader?.releaseLock();
        fetchMock.mockRestore();
      }
    },
  );

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
          operation === "read" ? client.getSkeleton(456) : client.deleteNode(7);
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
      await expect(client.getSkeleton(456)).rejects.toMatchObject({
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
      await expect(client.deleteNode(7)).rejects.toMatchObject({
        name: "CatmaidStateValidationError",
        message:
          "CATMAID rejected the edit because the inspected skeleton is out of date. Refresh the skeleton and try again.",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
