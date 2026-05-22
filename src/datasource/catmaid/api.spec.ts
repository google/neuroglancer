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
  makeCatmaidNodeSourceState,
} from "#src/datasource/catmaid/api.js";

type FetchMock = ReturnType<typeof vi.fn>;

function testSourceState(revisionToken: string) {
  return makeCatmaidNodeSourceState(revisionToken);
}

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

  it("parses live compact-detail history rows and current label maps", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce([
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
            "2026-03-29T10:15:00Z",
          ],
          [
            22107946,
            null,
            2,
            23697030.0,
            15055839.0,
            16651262.0,
            2000.0,
            5,
            "2026-03-28T08:00:00Z",
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
            "2026-03-29T10:15:00Z",
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
            "2026-03-29T10:16:00Z",
          ],
        ],
        [],
        {},
        [],
        [],
      ])
      .mockResolvedValueOnce([
        [],
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
    (client as any).fetch = fetchMock;

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
        sourceState: testSourceState("2026-03-29T10:15:00Z"),
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
        sourceState: testSourceState("2026-03-29T10:16:00Z"),
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
        sourceState: testSourceState("2026-03-29T10:17:00Z"),
      },
    ]);
    expect(getFetchPath(fetchMock, 0)).toBe(
      "skeletons/2/compact-detail?with_tags=true&with_history=true",
    );
    expect(getFetchPath(fetchMock, 1)).toBe(
      "skeletons/2/compact-detail?with_tags=true",
    );
  });

  it("ignores historical compact-detail labels that are not current", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce([
        [
          [
            23218380,
            null,
            1,
            24233266,
            13917594,
            15605623,
            0,
            5,
            "2026-05-06 20:17:31.181383+00:00",
            "2026-04-20 14:56:29.593124+00:00",
            1,
          ],
        ],
        [],
        {
          ends: [[23218380, "2026-04-22 15:11:58.824455+00:00"]],
        },
        [],
        [],
      ])
      .mockResolvedValueOnce([[], [], {}, [], []]);
    (client as any).fetch = fetchMock;

    await expect(client.getSkeleton(2974940)).resolves.toEqual([
      {
        nodeId: 23218380,
        parentNodeId: undefined,
        position: new Float32Array([24233266, 13917594, 15605623]),
        segmentId: 2974940,
        radius: 0,
        confidence: 100,
        description: undefined,
        isTrueEnd: false,
        sourceState: testSourceState("2026-05-06 20:17:31.181383+00:00"),
      },
    ]);
  });

  it("ignores zero-width history rows when compact-detail includes ordering", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue([
      [
        [
          11422971,
          11422970,
          2,
          24313028.0,
          14983333.0,
          6761820.5,
          2000.0,
          5,
          "2026-04-14 08:56:49.985049+00:00",
          "2026-04-14 08:56:49.985049+00:00",
          2,
        ],
        [
          11422972,
          11422971,
          2,
          24318870.0,
          14984255.0,
          6765134.0,
          2000.0,
          5,
          "2026-04-14 08:56:49.985049+00:00",
          "2026-04-14 08:56:49.985049+00:00",
          2,
        ],
      ],
      [],
      {},
      [],
      [],
    ]);
    (client as any).fetch = fetchMock;

    await expect(client.getSkeleton(1140285)).resolves.toEqual([]);
  });

  it("merges skeletons using from/to treenode ids", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      result_skeleton_id: 17,
      deleted_skeleton_id: 21,
      stable_annotation_swap: false,
    });
    (client as any).fetch = fetchMock;

    await expect(
      client.mergeSkeletons(101, 202, {
        nodes: [
          { nodeId: 101, revisionToken: "2026-03-29T11:50:00Z" },
          { nodeId: 202, revisionToken: "2026-03-29T11:51:00Z" },
        ],
      }),
    ).resolves.toEqual({
      resultSegmentId: 17,
      deletedSegmentId: 21,
      directionAdjusted: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = getFetchBody(fetchMock);
    expect(getFetchPath(fetchMock)).toBe("skeleton/join");
    expect(requestBody.get("from_id")).toBe("101");
    expect(requestBody.get("to_id")).toBe("202");
    expect(requestBody.get("state")).toBe(
      JSON.stringify([
        [101, "2026-03-29T11:50:00Z"],
        [202, "2026-03-29T11:51:00Z"],
      ]),
    );
  });

  it("parses browse node/list rows with revision tokens", async () => {
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
    (client as any).fetch = fetchMock;

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
        sourceState: testSourceState("2026-03-29T11:50:00Z"),
      },
      {
        nodeId: 102,
        parentNodeId: 101,
        position: new Float32Array([4, 5, 6]),
        segmentId: 17,
        sourceState: testSourceState("2026-03-29T11:51:00Z"),
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
    (client as any).fetch = fetchMock;

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
    (client as any).fetch = fetchMock;

    await expect(
      client.fetchNodes({
        lowerBounds: [0, 0],
        upperBounds: [10, 10],
      }),
    ).rejects.toThrow(/requires at least 3 coordinates/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches skeleton root targets", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      root_id: 303,
      x: 1,
      y: 2,
      z: 3,
    });
    (client as any).fetch = fetchMock;

    await expect(client.getSkeletonRootNode(17)).resolves.toEqual({
      nodeId: 303,
      position: [1, 2, 3],
    });

    expect(getFetchPath(fetchMock)).toBe("skeletons/17/root");
  });

  it("rejects merge state when the provided node ids do not match the request", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn();
    (client as any).fetch = fetchMock;

    await expect(
      client.mergeSkeletons(101, 202, {
        nodes: [{ nodeId: 101, revisionToken: "2026-03-29T11:50:00Z" }],
      }),
    ).rejects.toThrow(
      "CATMAID merge-skeleton node state does not match the requested node ids.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ids and source state from addNode and sends CATMAID parent state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      treenode_id: 88,
      skeleton_id: 13,
      edition_time: "2026-03-29T12:00:00Z",
      parent_edition_time: "2026-03-29T12:00:01Z",
    });
    (client as any).fetch = fetchMock;

    await expect(
      client.addNode(13, 1, 2, 3, 7, {
        node: {
          nodeId: 7,
          revisionToken: "2026-03-29T11:59:00Z",
        },
      }),
    ).resolves.toEqual({
      nodeId: 88,
      segmentId: 13,
      sourceState: testSourceState("2026-03-29T12:00:00Z"),
      parentSourceState: testSourceState("2026-03-29T12:00:01Z"),
    });

    expect(getFetchBody(fetchMock).get("state")).toBe(
      JSON.stringify({ parent: [7, "2026-03-29T11:59:00Z"] }),
    );
  });

  it("sends CATMAID root parent state when creating a root node", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      treenode_id: 88,
      skeleton_id: 13,
      edition_time: "2026-03-29T12:00:00Z",
    });
    (client as any).fetch = fetchMock;

    await expect(client.addNode(13, 1, 2, 3)).resolves.toEqual({
      nodeId: 88,
      segmentId: 13,
      sourceState: testSourceState("2026-03-29T12:00:00Z"),
      parentSourceState: undefined,
    });

    expect(getFetchBody(fetchMock).get("state")).toBe(
      JSON.stringify({ parent: [-1, ""] }),
    );
  });

  it("inserts nodes using CATMAID local parent-and-child state", async () => {
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
    (client as any).fetch = fetchMock;

    await expect(
      client.insertNode(13, 1, 2, 3, 7, [11, 12], {
        node: {
          nodeId: 7,
          revisionToken: "2026-03-29T12:00:30Z",
        },
        children: [
          { nodeId: 11, revisionToken: "2026-03-29T12:00:31Z" },
          { nodeId: 12, revisionToken: "2026-03-29T12:00:32Z" },
        ],
      }),
    ).resolves.toEqual({
      nodeId: 89,
      segmentId: 13,
      sourceState: testSourceState("2026-03-29T12:01:00Z"),
      parentSourceState: testSourceState("2026-03-29T12:01:01Z"),
      nodeSourceStateUpdates: [
        { nodeId: 11, sourceState: testSourceState("2026-03-29T12:01:02Z") },
        { nodeId: 12, sourceState: testSourceState("2026-03-29T12:01:03Z") },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = getFetchBody(fetchMock);
    expect(getFetchPath(fetchMock)).toBe("treenode/insert");
    expect(requestBody.get("parent_id")).toBe("7");
    expect(requestBody.get("child_id")).toBe("11");
    expect(requestBody.get("takeover_child_ids[0]")).toBe("12");
    expect(requestBody.get("state")).toBe(
      JSON.stringify({
        edition_time: "2026-03-29T12:00:30Z",
        children: [
          [11, "2026-03-29T12:00:31Z"],
          [12, "2026-03-29T12:00:32Z"],
        ],
        links: [],
      }),
    );
  });

  it("reroots skeletons using treenode ids", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ newroot: 202, skeleton_id: 17 })
      .mockResolvedValueOnce([
        [201, 200, 1, 2, 3, 5, 2000, 13, 1711711711.25, 9],
        [202, 201, 4, 5, 6, 5, 2000, 13, 1711711712.5, 9],
      ]);
    (client as any).fetch = fetchMock;

    await expect(
      client.rerootSkeleton(202, {
        node: {
          nodeId: 202,
          parentNodeId: 201,
          revisionToken: "2026-03-29T12:05:00Z",
        },
        parent: {
          nodeId: 201,
          revisionToken: "2026-03-29T12:04:00Z",
        },
        children: [
          { nodeId: 203, revisionToken: "2026-03-29T12:06:00Z" },
          { nodeId: 204, revisionToken: "2026-03-29T12:07:00Z" },
        ],
        nodes: [
          { nodeId: 202, revisionToken: "2026-03-29T12:05:00Z" },
          { nodeId: 201, revisionToken: "2026-03-29T12:04:00Z" },
        ],
      }),
    ).resolves.toEqual({
      nodeSourceStateUpdates: [
        {
          nodeId: 201,
          sourceState: testSourceState("2024-03-29T11:28:31.250Z"),
        },
        {
          nodeId: 202,
          sourceState: testSourceState("2024-03-29T11:28:32.500Z"),
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBody = getFetchBody(fetchMock, 0);
    expect(getFetchPath(fetchMock)).toBe("skeleton/reroot");
    expect(requestBody.get("treenode_id")).toBe("202");
    expect(requestBody.get("state")).toBe(
      JSON.stringify({
        edition_time: "2026-03-29T12:05:00Z",
        parent: [201, "2026-03-29T12:04:00Z"],
        children: [
          [203, "2026-03-29T12:06:00Z"],
          [204, "2026-03-29T12:07:00Z"],
        ],
        links: [],
      }),
    );
    expect(getFetchPath(fetchMock, 1)).toBe("treenodes/compact-detail");
    expect(getFetchBody(fetchMock, 1).toString()).toBe(
      "treenode_ids%5B0%5D=201&treenode_ids%5B1%5D=202",
    );
  });

  it("rejects reroot state when the parent neighborhood is incomplete", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn();
    (client as any).fetch = fetchMock;

    await expect(
      client.rerootSkeleton(202, {
        node: {
          nodeId: 202,
          parentNodeId: 201,
          revisionToken: "2026-03-29T12:05:00Z",
        },
        children: [{ nodeId: 203, revisionToken: "2026-03-29T12:06:00Z" }],
      }),
    ).rejects.toThrow(
      "CATMAID reroot-skeleton parent state does not match the cached skeleton neighborhood.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits skeletons using neighborhood state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      existing_skeleton_id: 17,
      new_skeleton_id: 21,
    });
    (client as any).fetch = fetchMock;

    await expect(
      client.splitSkeleton(202, {
        node: {
          nodeId: 202,
          parentNodeId: 201,
          revisionToken: "2026-03-29T12:05:00Z",
        },
        parent: {
          nodeId: 201,
          revisionToken: "2026-03-29T12:04:00Z",
        },
        children: [{ nodeId: 203, revisionToken: "2026-03-29T12:06:00Z" }],
      }),
    ).resolves.toEqual({
      existingSegmentId: 17,
      newSegmentId: 21,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = getFetchBody(fetchMock);
    expect(getFetchPath(fetchMock)).toBe("skeleton/split");
    expect(requestBody.get("treenode_id")).toBe("202");
    expect(requestBody.get("state")).toBe(
      JSON.stringify({
        edition_time: "2026-03-29T12:05:00Z",
        parent: [201, "2026-03-29T12:04:00Z"],
        children: [[203, "2026-03-29T12:06:00Z"]],
        links: [],
      }),
    );
  });

  it("rejects reroot when the follow-up revision refresh is incomplete", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ newroot: 202, skeleton_id: 17 })
      .mockResolvedValueOnce([
        [201, 200, 1, 2, 3, 5, 2000, 13, 1711711711.25, 9],
      ]);
    (client as any).fetch = fetchMock;

    await expect(
      client.rerootSkeleton(202, {
        node: {
          nodeId: 202,
          parentNodeId: 201,
          revisionToken: "2026-03-29T12:05:00Z",
        },
        parent: {
          nodeId: 201,
          revisionToken: "2026-03-29T12:04:00Z",
        },
        nodes: [
          { nodeId: 202, revisionToken: "2026-03-29T12:05:00Z" },
          { nodeId: 201, revisionToken: "2026-03-29T12:04:00Z" },
        ],
      }),
    ).rejects.toThrow(
      "CATMAID treenodes/compact-detail did not return revision metadata for node(s) 202.",
    );
  });

  it("moves nodes using node revision state and returns the updated revision", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      updated: 1,
      old_treenodes: [[42, "2026-03-29T12:10:00Z", 1, 2, 3]],
      old_connectors: [],
    });
    (client as any).fetch = fetchMock;

    await expect(
      client.moveNode(42, 10, 11, 12, {
        node: {
          nodeId: 42,
          revisionToken: "2026-03-29T12:00:00Z",
        },
      }),
    ).resolves.toEqual({
      sourceState: testSourceState("2026-03-29T12:10:00Z"),
    });

    expect(getFetchBody(fetchMock).get("state")).toBe(
      JSON.stringify([[42, "2026-03-29T12:00:00Z"]]),
    );
  });

  it("deletes nodes using neighborhood state and returns child revisions", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      success: "Removed treenode successfully.",
      children: [
        [12, "2026-03-29T12:20:00Z"],
        [13, "2026-03-29T12:20:01Z"],
      ],
    });
    (client as any).fetch = fetchMock;

    await expect(
      client.deleteNode(11, {
        childNodeIds: [12, 13],
        editContext: {
          node: {
            nodeId: 11,
            parentNodeId: 7,
            revisionToken: "2026-03-29T12:15:00Z",
          },
          parent: {
            nodeId: 7,
            revisionToken: "2026-03-29T12:14:00Z",
          },
          children: [
            { nodeId: 12, revisionToken: "2026-03-29T12:13:00Z" },
            { nodeId: 13, revisionToken: "2026-03-29T12:13:01Z" },
          ],
        },
      }),
    ).resolves.toEqual({
      nodeSourceStateUpdates: [
        { nodeId: 12, sourceState: testSourceState("2026-03-29T12:20:00Z") },
        { nodeId: 13, sourceState: testSourceState("2026-03-29T12:20:01Z") },
      ],
    });

    expect(getFetchBody(fetchMock).get("state")).toBe(
      JSON.stringify({
        edition_time: "2026-03-29T12:15:00Z",
        parent: [7, "2026-03-29T12:14:00Z"],
        children: [
          [12, "2026-03-29T12:13:00Z"],
          [13, "2026-03-29T12:13:01Z"],
        ],
        links: [],
      }),
    );
  });

  it("updates descriptions without CATMAID node state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ edition_time: "2026-03-29T13:00:00Z" });
    (client as any).fetch = fetchMock;

    await expect(
      client.updateDescription(11, "updated description"),
    ).resolves.toEqual({
      description: "updated description",
      sourceState: testSourceState("2026-03-29T13:00:00Z"),
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("state")).toBeNull();
    expect(requestBody.get("tags")).toBe("updated description");
    expect(requestBody.get("delete_existing")).toBe("true");
  });

  it("preserves true-end labels while replacing description labels", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ edition_time: "2026-03-29T13:05:00Z" });
    (client as any).fetch = fetchMock;

    await expect(
      client.updateDescription(11, "updated description\nends", {
        isTrueEnd: true,
      }),
    ).resolves.toEqual({
      description: "updated description",
      sourceState: testSourceState("2026-03-29T13:05:00Z"),
    });

    const requestBody = getFetchBody(fetchMock);
    expect(requestBody.get("tags")).toBe("updated description,ends");
    expect(requestBody.get("delete_existing")).toBe("true");
  });

  it("toggles true-end labels without CATMAID node state", async () => {
    const client = new CatmaidClient("https://example.invalid", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ edition_time: "2026-03-29T13:10:00Z" })
      .mockResolvedValueOnce({ edition_time: "2026-03-29T13:11:00Z" });
    (client as any).fetch = fetchMock;

    await expect(client.toggleTrueEnd(11, true)).resolves.toEqual({
      sourceState: testSourceState("2026-03-29T13:10:00Z"),
    });
    await expect(client.toggleTrueEnd(11, false)).resolves.toEqual({
      sourceState: testSourceState("2026-03-29T13:11:00Z"),
    });

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
    (client as any).fetch = fetchMock;

    await expect(
      client.updateConfidence(11, 75, {
        node: {
          nodeId: 11,
          revisionToken: "2026-03-29T13:19:00Z",
        },
      }),
    ).resolves.toEqual({
      sourceState: testSourceState("2026-03-29T13:20:00Z"),
    });

    expect(getFetchPath(fetchMock)).toBe("treenodes/11/confidence");
    expect(getFetchBody(fetchMock).get("new_confidence")).toBe("4");
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

    await expect(
      client.moveNode(11, 1, 2, 3, {
        node: {
          nodeId: 11,
          revisionToken: "2026-03-29T13:11:00Z",
        },
      }),
    ).rejects.toThrow(
      "CATMAID rejected the edit because the inspected skeleton is out of date. Refresh the skeleton and try again.",
    );

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

    await expect(
      client.moveNode(11, 1, 2, 3, {
        node: {
          nodeId: 11,
          revisionToken: "2026-03-29T13:11:00Z",
        },
      }),
    ).rejects.toMatchObject({
      name: "HttpError",
      status: 400,
    });

    fetchMock.mockRestore();
  });
});
