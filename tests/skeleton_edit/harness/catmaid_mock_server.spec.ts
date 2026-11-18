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
import { getSkeletonNodeConfidence } from "#src/skeleton/node_attributes.js";
import type { CatmaidMockServer } from "./catmaid_mock_server.js";
import {
  makeCatmaidTestNodes,
  startCatmaidMockServer,
} from "./catmaid_mock_server.js";

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
    expect(await client.listSkeletons()).toEqual([10n, 20n]);
    expect(await client.getSpatialIndexMetadata()).toMatchObject({
      bounds: {
        lowerBounds: Float64Array.of(0, 0, 0),
        upperBounds: Float64Array.of(10000, 10000, 10000),
      },
      readonly: false,
      spatial: [{ chunkSize: [10000, 10000, 10000], limit: 0 }],
    });
    const spatial = await client.fetchNodes({
      lowerBounds: Float64Array.of(0, 0, 0),
      upperBounds: Float64Array.of(10000, 10000, 10000),
    });
    expect(spatial.map((n) => n.nodeId)).toEqual([
      101n,
      102n,
      103n,
      201n,
      202n,
      203n,
    ]);
    const complete = await client.getSkeleton(10n);
    expect(
      complete.map((n) => [
        n.nodeId,
        n.parentNodeId,
        getSkeletonNodeConfidence(n),
      ]),
    ).toEqual([
      [101n, undefined, 100],
      [102n, 101n, 100],
      [103n, 102n, 100],
    ]);
    expect(await client.getSkeleton(999n)).toEqual([]);
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
    expect(await client.mergeSkeletons(103n, 203n)).toMatchObject({
      resultSegmentId: 10n,
      deletedSegmentId: 20n,
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
    expect(await client.getSkeleton(20n)).toEqual([]);
    const split = await client.splitSkeleton(203n);
    expect(split).toEqual({ existingSegmentId: 10n, newSegmentId: 30n });
    await client.rerootSkeleton(201n);
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
      getSkeletonNodeConfidence(
        (await client.getSkeleton(30n)).find((n) => n.nodeId === 204n)!,
      ),
    ).toBe(50);
    await client.mergeSkeletons(103n, 203n);
    expect(await client.splitSkeleton(203n)).toEqual({
      existingSegmentId: 10n,
      newSegmentId: 31n,
    });
    await client.rerootSkeleton(201n);
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
    await client.mergeSkeletons(103n, 201n);
    expect(server.snapshot().find(({ id }) => id === 201)).toMatchObject({
      parentId: 103,
      skeletonId: 10,
      confidence: 2,
    });
    expect(
      getSkeletonNodeConfidence(
        (await client.getSkeleton(10n)).find(({ nodeId }) => nodeId === 201n)!,
      ),
    ).toBe(25);
  });

  it("recreates deleted root and child nodes with fresh IDs and persists properties", async () => {
    const root = await client.addNode(5000, 5000, 1000);
    const child = await client.addNode(6000, 5000, 1000, root.nodeId);
    expect([root.nodeId, root.segmentId, child.nodeId]).toEqual([
      1001n,
      30n,
      1002n,
    ]);
    await client.moveNode(child.nodeId, 6100, 5200, 1000);
    await client.updateRadius(child.nodeId, 80);
    await client.updateConfidence(child.nodeId, 75);
    await client.updateDescription(child.nodeId, "Restored root fixture");
    await client.toggleTrueEnd(child.nodeId, true);
    const savedChild = (await client.getSkeleton(30n)).find(
      (n) => n.nodeId === child.nodeId,
    )!;
    expect(Array.from(savedChild.position)).toEqual([6100, 5200, 1000]);
    expect(savedChild).toMatchObject({
      description: "Restored root fixture",
      attributes: { radius: [80], confidence: [75], true_end: [1] },
    });
    await client.deleteNode(child.nodeId);
    await client.deleteNode(root.nodeId);
    expect(await client.getSkeleton(30n)).toEqual([]);
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
    ]).toEqual([1003n, 31n, 1004n]);
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
    await client.deleteNode(102n);
    expect(topology().filter((n) => Number(n[0]) < 200)).toEqual([
      [101, null, 10],
      [103, 101, 10],
      [104, 101, 10],
    ]);
    const restored = await client.insertNode(2000, 1000, 1000, 101n, [
      103n,
      104n,
    ]);
    expect(restored.nodeId).toBe(1001n);
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
    const pending = client.splitSkeleton(102n).then((result) => {
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
      (await client.getSkeleton(30n)).find(
        (node) => node.parentNodeId === undefined,
      ),
    ).toMatchObject({
      nodeId: 102n,
      position: new Float32Array([2000, 1000, 1000]),
    });
    expect(() => server.reset()).toThrow("Drain held mutation responses");
    held.release();
    await pending;
    await client.mergeSkeletons(101n, 102n);
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
