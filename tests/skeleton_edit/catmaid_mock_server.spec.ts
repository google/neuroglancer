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

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatmaidClient } from "#src/datasource/catmaid/api.js";
import type { CatmaidMockServer } from "#tests/skeleton_edit/catmaid_mock_server.js";
import {
  makeCatmaidTestNodes,
  startCatmaidMockServer,
} from "#tests/skeleton_edit/catmaid_mock_server.js";

describe("stateful CATMAID browser test backend", () => {
  let server: CatmaidMockServer;
  let client: CatmaidClient;

  beforeEach(async () => {
    server = await startCatmaidMockServer();
    client = new CatmaidClient(server.url, 1);
  });

  afterEach(async () => {
    await server.close();
    expect(server.unknownRequests).toEqual([]);
  });

  function topology() {
    return server
      .snapshot()
      .map(({ id, parentId, skeletonId }) => [id, parentId, skeletonId]);
  }

  it("serves real adapter initialization and spatial/full skeleton reads", async () => {
    expect(await client.listSkeletons()).toEqual([10, 20]);
    expect(await client.getSpatialIndexMetadata()).toMatchObject({
      lowerBounds: [0, 0, 0],
      upperBounds: [10000, 10000, 10000],
      readonly: false,
      spatial: [
        { chunkSize: [10000, 10000, 10000], gridShape: [1, 1, 1], limit: 0 },
      ],
    });
    const spatial = await client.fetchNodes({
      lowerBounds: [0, 0, 0],
      upperBounds: [10000, 10000, 10000],
    });
    expect(spatial.map((n) => n.nodeId)).toEqual([
      101, 102, 103, 201, 202, 203,
    ]);
    const complete = await client.getSkeleton(10);
    expect(
      complete.map((n) => [n.nodeId, n.parentNodeId, n.confidence]),
    ).toEqual([
      [101, undefined, 100],
      [102, 101, 100],
      [103, 102, 100],
    ]);
    expect(await client.getSkeleton(999)).toEqual([]);
    const credentials = await fetch(
      `${server.url}/accounts/anonymous-api-token`,
    );
    expect(await credentials.json()).toEqual({ token: "local-test-token" });
    expect(server.mutations).toEqual([]);
  });

  it("independently joins through a non-root, splits, and restores the old root path and branch", async () => {
    server.reset([
      ...makeCatmaidTestNodes(),
      {
        id: 204,
        parentId: 202,
        skeletonId: 20,
        x: 2000,
        y: 4000,
        z: 1000,
        radius: 40,
        confidence: 3,
        labels: [],
      },
    ]);
    expect(await client.mergeSkeletons(103, 203)).toMatchObject({
      resultSegmentId: 10,
      deletedSegmentId: 20,
      directionAdjusted: false,
    });
    expect(topology()).toEqual([
      [101, null, 10],
      [102, 101, 10],
      [103, 102, 10],
      [201, 202, 10],
      [202, 203, 10],
      [203, 103, 10],
      [204, 202, 10],
    ]);
    expect(await client.getSkeleton(20)).toEqual([]);
    const split = await client.splitSkeleton(203);
    expect(split).toEqual({ existingSegmentId: 10, newSegmentId: 30 });
    await client.rerootSkeleton(201);
    expect(topology()).toEqual([
      [101, null, 10],
      [102, 101, 10],
      [103, 102, 10],
      [201, null, 30],
      [202, 201, 30],
      [203, 202, 30],
      [204, 202, 30],
    ]);
    expect(
      (await client.getSkeleton(30)).find((n) => n.nodeId === 204)?.confidence,
    ).toBe(50);
    await client.mergeSkeletons(103, 203);
    expect(await client.splitSkeleton(203)).toEqual({
      existingSegmentId: 10,
      newSegmentId: 31,
    });
    await client.rerootSkeleton(201);
    expect(topology().filter((n) => Number(n[0]) >= 200)).toEqual([
      [201, null, 31],
      [202, 201, 31],
      [203, 202, 31],
      [204, 202, 31],
    ]);
    expect(server.maxInFlightMutations).toBe(1);
  });

  it("preserves confidence when joining at an existing root", async () => {
    const initial = makeCatmaidTestNodes();
    initial.find(({ id }) => id === 201)!.confidence = 2;
    server.reset(initial);
    await client.mergeSkeletons(103, 201);
    expect(server.snapshot().find(({ id }) => id === 201)).toMatchObject({
      parentId: 103,
      skeletonId: 10,
      confidence: 2,
    });
    expect(
      (await client.getSkeleton(10)).find(({ nodeId }) => nodeId === 201)
        ?.confidence,
    ).toBe(25);
  });

  it("recreates deleted root and child nodes with fresh IDs and persists properties", async () => {
    const root = await client.addNode(5000, 5000, 1000);
    const child = await client.addNode(6000, 5000, 1000, root.nodeId);
    expect([root.nodeId, root.segmentId, child.nodeId]).toEqual([
      1001, 30, 1002,
    ]);
    await client.moveNode(child.nodeId, 6100, 5200, 1000);
    await client.updateRadius(child.nodeId, 80);
    await client.updateConfidence(child.nodeId, 75);
    await client.updateDescription(child.nodeId, "Restored root fixture");
    await client.toggleTrueEnd(child.nodeId, true);
    const savedChild = (await client.getSkeleton(30)).find(
      (n) => n.nodeId === child.nodeId,
    )!;
    expect(Array.from(savedChild.position)).toEqual([6100, 5200, 1000]);
    expect(savedChild).toMatchObject({
      radius: 80,
      confidence: 75,
      description: "Restored root fixture",
      isTrueEnd: true,
    });
    await client.deleteNode(child.nodeId);
    await client.deleteNode(root.nodeId);
    expect(await client.getSkeleton(30)).toEqual([]);
    const restoredRoot = await client.addNode(5000, 5000, 1000);
    const restoredChild = await client.addNode(
      6100,
      5200,
      1000,
      restoredRoot.nodeId,
    );
    expect([
      restoredRoot.nodeId,
      restoredRoot.segmentId,
      restoredChild.nodeId,
    ]).toEqual([1003, 31, 1004]);
    expect(topology().filter((n) => Number(n[0]) >= 1000)).toEqual([
      [1003, null, 31],
      [1004, 1003, 31],
    ]);
  });

  it("supports deleting and restoring a branch node through treenode/insert", async () => {
    server.reset([
      ...makeCatmaidTestNodes(),
      {
        id: 104,
        parentId: 102,
        skeletonId: 10,
        x: 2000,
        y: 2000,
        z: 1000,
        radius: 40,
        confidence: 5,
        labels: [],
      },
    ]);
    await client.deleteNode(102);
    expect(topology().filter((n) => Number(n[0]) < 200)).toEqual([
      [101, null, 10],
      [103, 101, 10],
      [104, 101, 10],
    ]);
    const restored = await client.insertNode(2000, 1000, 1000, 101, [103, 104]);
    expect(restored.nodeId).toBe(1001);
    expect(
      server
        .snapshot()
        .filter((n) => n.skeletonId === 10)
        .map(({ id, parentId }) => [id, parentId]),
    ).toEqual([
      [101, null],
      [103, 1001],
      [104, 1001],
      [1001, 101],
    ]);
  });

  it("holds acknowledgement after commit and records exact request order without sleeps", async () => {
    const held = server.holdNextMutation("skeleton/split");
    let completed = false;
    const pending = client.splitSkeleton(102).then((result) => {
      completed = true;
      return result;
    });
    const request = await held.received;
    expect(completed).toBe(false);
    expect(request).toMatchObject({
      path: "skeleton/split",
      body: { treenode_id: "102" },
      status: 200,
    });
    expect(request.completedAt).toBeUndefined();
    expect(server.inFlightMutations).toBe(1);
    expect(
      (await client.getSkeleton(30)).find(
        (node) => node.parentNodeId === undefined,
      ),
    ).toMatchObject({
      nodeId: 102,
      position: new Float32Array([2000, 1000, 1000]),
    });
    expect(() => server.reset()).toThrow("Drain held mutation responses");
    held.release();
    await pending;
    await client.mergeSkeletons(101, 102);
    expect(server.mutations.map((n) => n.path)).toEqual([
      "skeleton/split",
      "skeleton/join",
    ]);
    expect(server.mutations[0].completedAt).toBeLessThanOrEqual(
      server.mutations[1].startedAt,
    );
    expect(server.inFlightMutations).toBe(0);
    expect(server.maxInFlightMutations).toBe(1);
    server.reset();
    expect(server.snapshot()).toEqual(makeCatmaidTestNodes());
    expect(server.mutations).toEqual([]);
  });
});
