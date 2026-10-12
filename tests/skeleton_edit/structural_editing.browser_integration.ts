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

import { expect, type Page } from "@playwright/test";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { Viewer } from "#src/viewer.js";
import {
  startCatmaidMockServer,
  type CatmaidMockServer,
} from "./catmaid_mock_server.js";
import { test as base } from "./fixtures.js";
import {
  SkeletonEditPage,
  readGraph,
  readQueue,
  readRenderedNodeIds,
  parentMap,
  type GraphNode,
} from "./skeleton_edit_page.js";

const IDS = [101, 102, 103, 201, 202, 203];
const INITIAL_PARENTS = [
  [101, null],
  [102, 101],
  [103, 102],
  [201, null],
  [202, 201],
  [203, 202],
];

const SPLIT_PARENTS = [
  [101, null],
  [102, null],
  [103, 102],
  [201, null],
  [202, 201],
  [203, 202],
];
const REROOT_PARENTS = [
  [101, 102],
  [102, 103],
  [103, null],
  [201, null],
  [202, 201],
  [203, 202],
];

function savedParents(server: CatmaidMockServer) {
  return server.snapshot().map(({ id, parentId }) => [id, parentId]);
}

const test = base.extend<{ server: CatmaidMockServer }>({
  // Playwright requires destructured fixture arguments, even with no dependencies.
  // eslint-disable-next-line no-empty-pattern
  server: async ({}, use, testInfo) => {
    const server = await startCatmaidMockServer();
    try {
      await use(server);
      expect(server.unknownRequests).toEqual([]);
      expect(server.mutations.every((entry) => entry.status === 200)).toBe(
        true,
      );
      expect(server.maxInFlightMutations).toBe(1);
    } finally {
      try {
        await testInfo.attach("backend", {
          body: JSON.stringify(
            {
              mutations: server.mutations,
              unknown: server.unknownRequests,
              graph: server.snapshot(),
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
      } finally {
        await server.close();
      }
    }
  },
});

function savedTopology(server: CatmaidMockServer) {
  return server.snapshot().map((node) => ({
    id: node.id,
    parentId: node.parentId,
    skeletonId: node.skeletonId,
    position: [node.x, node.y, node.z],
  }));
}

function topology(nodes: GraphNode[]) {
  return nodes.map(({ id, parentId, skeletonId, position }) => ({
    id,
    parentId,
    skeletonId,
    position,
  }));
}

test("split previews the complete branch, then Undo and Redo restore topology", async ({
  page,
  server,
}, testInfo) => {
  const ui = new SkeletonEditPage(page);
  await ui.open(server.sourceUrl);
  const held = server.holdNextMutation("skeleton/split");
  await ui.split(102);
  await held.received;
  await expect
    .poll(async () => parentMap(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual([
      [101, null],
      [102, null],
      [103, 102],
      [201, null],
      [202, 201],
      [203, 202],
    ]);
  const preview = await readGraph(page, IDS);
  expect(preview.find((n) => n.id === 101)!.skeletonId).not.toBe(
    preview.find((n) => n.id === 102)!.skeletonId,
  );
  expect(preview.find((n) => n.id === 102)!.skeletonId).toBe(
    preview.find((n) => n.id === 103)!.skeletonId,
  );
  await ui.showQueue();
  await expect(page.getByText("Saving", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("split-preview.png") });
  held.release();
  await ui.waitSaved();
  await expect
    .poll(async () => topology(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(savedTopology(server));
  expect(savedParents(server)).toEqual(SPLIT_PARENTS);
  const firstSplitId = server.snapshot().find((n) => n.id === 102)!.skeletonId;
  await ui.showSkeleton();
  await ui.undo();
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(INITIAL_PARENTS);
  await expect
    .poll(async () => parentMap(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(INITIAL_PARENTS);
  await expect
    .poll(async () => topology(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(savedTopology(server));
  await ui.redo();
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(SPLIT_PARENTS);
  expect(server.snapshot().find((n) => n.id === 102)!.skeletonId).not.toBe(
    firstSplitId,
  );
  await expect
    .poll(async () => topology(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(savedTopology(server));
  expect(server.mutations.map((r) => r.path)).toEqual([
    "skeleton/split",
    "skeleton/join",
    "skeleton/split",
  ]);
});

test("a cold merge appears in Queue immediately and can be undone before its target loads", async ({
  page,
  server,
}) => {
  let releaseReads!: () => void;
  const readBarrier = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  let blocked = true;
  await page.route("**/20/compact-detail*", async (route) => {
    if (blocked) await readBarrier;
    await route.continue().catch(() => {});
  });
  const ui = new SkeletonEditPage(page);
  try {
    await ui.open(server.sourceUrl, [10, 20], false, [2000, 2000, 1000], [10]);
    await ui.selectNode(103);
    const center = await ui.panelCenter();
    const scale = await page.evaluate(
      () =>
        (window as unknown as { viewer: Viewer }).viewer.crossSectionScale
          .value,
    );
    await page.mouse.move(center.x, center.y);
    await ui.runEdit(async () => {
      await page.keyboard.down("m");
      try {
        await page.mouse.click(center.x, center.y);
        await page.mouse.click(center.x, center.y + 2000 / scale);
      } finally {
        await page.keyboard.up("m");
      }
    });
    const pending = await readQueue(page);
    expect(pending.entries).toMatchObject([
      {
        intent: "execute",
        lifecycle: { authority: "queued", preview: "preparing" },
      },
    ]);
    expect(pending.canUndo).toBe(true);
    expect(server.mutations).toHaveLength(0);
    await ui.showQueue();
    await expect(page.getByText("Preparing", { exact: true })).toBeVisible();
    await ui.showSkeleton();
    await ui.undo();
    expect(server.mutations).toHaveLength(0);
    await expect.poll(async () => (await readQueue(page)).canRedo).toBe(true);
    await ui.redo();
    blocked = false;
    releaseReads();
    await ui.waitSaved();
    expect(server.mutations.map(({ path }) => path)).toEqual(["skeleton/join"]);
    await expect
      .poll(async () =>
        parentMap(await readGraph(page, IDS, "Skeletons", true)),
      )
      .toEqual([
        [101, null],
        [102, 101],
        [103, 102],
        [201, 202],
        [202, 203],
        [203, 103],
      ]);
  } finally {
    blocked = false;
    releaseReads();
  }
});

test("merge through a non-root node restores the original root after repeated Undo and reload", async ({
  page,
  server,
}, testInfo) => {
  const ui = new SkeletonEditPage(page);
  await ui.open(server.sourceUrl);
  const heldMerge = server.holdNextMutation("skeleton/join");
  await ui.merge(103, 203);
  await heldMerge.received;
  const mergedParents = [
    [101, null],
    [102, 101],
    [103, 102],
    [201, 202],
    [202, 203],
    [203, 103],
  ];
  await expect
    .poll(async () => parentMap(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(mergedParents);
  expect(
    new Set((await readGraph(page, IDS)).map((n) => n.skeletonId)).size,
  ).toBe(1);
  await ui.showQueue();
  await expect(page.getByText("Saving", { exact: true })).toBeVisible();
  heldMerge.release();
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(mergedParents);
  await ui.showSkeleton();

  // The inverse has two real requests. Saved must wait for reroot as well as split.
  const heldSplit = server.holdNextMutation("skeleton/split");
  const heldReroot = server.holdNextMutation("skeleton/reroot");
  await ui.undo();
  await heldSplit.received;
  await expect
    .poll(async () => parentMap(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(INITIAL_PARENTS);
  expect(server.snapshot().find((n) => n.id === 203)!.parentId).toBeNull();
  expect(server.snapshot().find((n) => n.id === 201)!.parentId).toBe(202);
  heldSplit.release();
  await heldReroot.received;
  expect((await readQueue(page)).pending).toBe(true);
  expect(
    (await readQueue(page)).recent.filter((entry) => entry.intent === "undo"),
  ).toEqual([]);
  await ui.showQueue();
  await expect(page.getByText("Saving", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("merge-undo-reroot-pending.png"),
  });
  heldReroot.release();
  await ui.waitSaved();
  await expect
    .poll(async () => topology(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(savedTopology(server));
  expect(savedParents(server)).toEqual(INITIAL_PARENTS);
  const restoredId = server.snapshot().find((n) => n.id === 201)!.skeletonId;
  await ui.showSkeleton();
  await ui.redo();
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(mergedParents);
  await expect
    .poll(async () => parentMap(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(mergedParents);
  await ui.undo();
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(INITIAL_PARENTS);
  await expect
    .poll(async () => parentMap(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(INITIAL_PARENTS);
  expect(server.snapshot().find((n) => n.id === 201)!.skeletonId).not.toBe(
    restoredId,
  );
  expect(server.mutations.map((r) => r.path)).toEqual([
    "skeleton/join",
    "skeleton/split",
    "skeleton/reroot",
    "skeleton/join",
    "skeleton/split",
    "skeleton/reroot",
  ]);
  expect(savedParents(server)).toEqual(INITIAL_PARENTS);
  expect(
    server.mutations
      .filter((entry) => entry.path === "skeleton/reroot")
      .map((entry) => entry.body.treenode_id),
  ).toEqual(["201", "201"]);
  const persisted = savedTopology(server);
  await ui.reload([...new Set(server.snapshot().map((n) => n.skeletonId))]);
  await expect
    .poll(async () => topology(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(persisted);
  expect(parentMap(await readGraph(page, IDS, "Skeletons", true))).toEqual(
    INITIAL_PARENTS,
  );
  await page.screenshot({
    path: testInfo.outputPath("original-root-restored-after-reload.png"),
  });
});

test("Undo during a saving Split restores the preview before its ordered inverse saves", async ({
  page,
  server,
}) => {
  const ui = new SkeletonEditPage(page);
  await ui.open(server.sourceUrl);
  const held = server.holdNextMutation("skeleton/split");
  await ui.split(102);
  await held.received;
  await ui.undo();
  expect(parentMap(await readGraph(page, IDS, "Skeletons", true))).toEqual(
    INITIAL_PARENTS,
  );
  expect(server.mutations.map((r) => r.path)).toEqual(["skeleton/split"]);
  await ui.showQueue();
  await expect(page.getByText("Saving", { exact: true })).toBeVisible();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  held.release();
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(INITIAL_PARENTS);
  expect(server.mutations.map((r) => r.path)).toEqual([
    "skeleton/split",
    "skeleton/join",
  ]);
  await expect
    .poll(async () => topology(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(savedTopology(server));
});

async function reverseNextMerge(page: Page) {
  // Model CATMAID's direction adjustment by reversing the actual backend
  // request, then reporting the swap. Changing only the reply would leave
  // the mock's saved topology inconsistent with the simulated result.
  await page.route(
    "**/skeleton/join",
    async (route) => {
      const body = new URLSearchParams(route.request().postData()!);
      const from = body.get("from_id")!;
      body.set("from_id", body.get("to_id")!);
      body.set("to_id", from);
      const response = await route.fetch({ postData: body.toString() });
      await route.fulfill({
        response,
        json: { ...(await response.json()), stable_annotation_swap: true },
      });
    },
    { times: 1 },
  );
}

test("Undo and Redo during root creation preserve the preview and save in order", async ({
  page,
  server,
}, testInfo) => {
  const ui = new SkeletonEditPage(page);
  await ui.open(server.sourceUrl);
  const held = server.holdNextMutation("treenode/create");
  const center = await ui.panelCenter();
  await page.mouse.move(center.x, center.y);
  await ui.runEdit(async () => {
    await page.keyboard.down("n");
    try {
      await page.mouse.click(center.x + 50, center.y + 30);
    } finally {
      await page.keyboard.up("n");
    }
  });
  await held.received;
  await ui.undo();
  await ui.redo();
  expect(server.mutations).toHaveLength(1);
  const previewNodeId = await page.evaluate(() => {
    const viewer = (window as unknown as { viewer: Viewer }).viewer;
    const layer = viewer.layerManager.getLayerByName("Skeletons")!
      .layer as SegmentationUserLayer;
    return layer.selectedSpatialSkeletonNodeInfo.value!.nodeId;
  });
  const preview = await readGraph(page, [previewNodeId]);
  expect(preview).toHaveLength(1);

  const undoHeld = server.holdNextMutation("treenode/delete");
  held.release();
  await undoHeld.received;
  expect(await readGraph(page, [previewNodeId])).toEqual(preview);
  await expect
    .poll(() => readRenderedNodeIds(page))
    .toEqual(expect.arrayContaining([previewNodeId]));
  await page.mouse.click(center.x, center.y);
  await expect(
    page.locator(".neuroglancer-skeleton-node-segment-chip", {
      hasText: /^Preview$/,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("redo-preview-while-undo-saves.png"),
  });
  undoHeld.release();
  await ui.waitSaved();
  expect(
    server.mutations.map(({ path }) => path.split("/").slice(-2).join("/")),
  ).toEqual(["treenode/create", "treenode/delete", "treenode/create"]);
  const ids = [...IDS, 1002];
  await expect
    .poll(async () => topology(await readGraph(page, ids, "Skeletons", true)))
    .toEqual(savedTopology(server));
  expect(await readGraph(page, [previewNodeId, 1001])).toEqual([]);
  expect((await readQueue(page)).recent.map(({ status }) => status)).toEqual([
    "saved",
    "saved",
    "saved",
  ]);

  await ui.undo();
  await ui.waitSaved();
  expect(server.snapshot().map(({ id }) => id)).toEqual(IDS);
  await ui.redo();
  await ui.waitSaved();
  await ui.reload([
    ...new Set(server.snapshot().map(({ skeletonId }) => skeletonId)),
  ]);
  expect(
    topology(await readGraph(page, [...IDS, 1003], "Skeletons", true)),
  ).toEqual(savedTopology(server));
});

for (const kind of ["new root", "split"] as const) {
  test(`a pending Merge stays visible when its ${kind} input saves`, async ({
    page,
    server,
  }, testInfo) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(server.sourceUrl);
    const inputHeld = server.holdNextMutation(
      kind === "new root" ? "treenode/create" : "skeleton/split",
    );
    if (kind === "new root") {
      const center = await ui.panelCenter();
      await page.mouse.move(center.x, center.y);
      await ui.runEdit(async () => {
        await page.keyboard.down("n");
        try {
          await page.mouse.click(center.x + 50, center.y + 30);
        } finally {
          await page.keyboard.up("n");
        }
      });
    } else {
      await ui.split(102);
    }
    await inputHeld.received;
    const inputNodeId = await page.evaluate(() => {
      const viewer = (window as unknown as { viewer: Viewer }).viewer;
      const layer = viewer.layerManager.getLayerByName("Skeletons")!
        .layer as SegmentationUserLayer;
      return layer.selectedSpatialSkeletonNodeInfo.value!.nodeId;
    });
    const [source] = await readGraph(page, [inputNodeId]);
    const [target] = await readGraph(page, [203]);
    const center = await ui.panelCenter();
    const camera = await page.evaluate(() => {
      const viewer = (window as unknown as { viewer: Viewer }).viewer;
      return {
        position: [...viewer.position.value],
        scale: viewer.crossSectionScale.value,
      };
    });
    // Click the provisional root directly: its node-list label is "Preview".
    await ui.runEdit(async () => {
      await page.mouse.move(center.x, center.y);
      await page.keyboard.down("m");
      try {
        for (const node of [source, target]) {
          await page.mouse.click(
            center.x + (node.position[0] - camera.position[0]) / camera.scale,
            center.y + (node.position[1] - camera.position[1]) / camera.scale,
          );
        }
      } finally {
        await page.keyboard.up("m");
      }
    });
    const [mergedTarget] = await readGraph(page, [203]);
    const previewId = mergedTarget.skeletonId;
    expect(previewId).not.toBe(source.skeletonId);
    const previewChip = page.locator(
      ".neuroglancer-skeleton-node-segment-chip",
      { hasText: /^Preview$/ },
    );
    await expect(previewChip).toBeVisible();

    const mergeHeld = server.holdNextMutation("skeleton/join");
    inputHeld.release();
    await mergeHeld.received;
    const savedNodeId = kind === "new root" ? 1001 : 102;
    const mergedNodeIds =
      kind === "new root"
        ? [201, 202, 203, savedNodeId]
        : [102, 103, 201, 202, 203];
    await expect
      .poll(async () => (await readGraph(page, [savedNodeId]))[0]?.skeletonId)
      .toBe(previewId);
    const merged = await readGraph(page, [savedNodeId], "Skeletons", true);
    expect(merged.map(({ id }) => id)).toEqual(mergedNodeIds);
    expect(merged.every(({ skeletonId }) => skeletonId === previewId)).toBe(
      true,
    );
    expect(merged.find(({ id }) => id === 203)?.parentId).toBe(savedNodeId);
    await expect
      .poll(() => readRenderedNodeIds(page))
      .toEqual(expect.arrayContaining(mergedNodeIds));
    await expect(previewChip).toBeVisible();
    const selected = await page.evaluate(() => {
      const viewer = (window as unknown as { viewer: Viewer }).viewer;
      const layer = viewer.layerManager.getLayerByName("Skeletons")!
        .layer as SegmentationUserLayer;
      return {
        segmentId: layer.selectedSpatialSkeletonNodeInfo.value?.segmentId,
        visible: [
          ...layer.displayState.segmentationGroupState.value.visibleSegments,
        ].map(Number),
      };
    });
    expect(selected.segmentId).toBe(previewId);
    expect(selected.visible).toContain(previewId);
    await page.screenshot({ path: testInfo.outputPath("pending-merge.png") });

    mergeHeld.release();
    await ui.waitSaved();
    const ids = kind === "new root" ? [...IDS, savedNodeId] : IDS;
    await expect
      .poll(async () => topology(await readGraph(page, ids, "Skeletons", true)))
      .toEqual(savedTopology(server));
    await expect(previewChip).toHaveCount(0);
    await ui.reload([
      ...new Set(server.snapshot().map(({ skeletonId }) => skeletonId)),
    ]);
    expect(topology(await readGraph(page, ids, "Skeletons", true))).toEqual(
      savedTopology(server),
    );
  });
}

for (const secondDirectionAdjusted of [false, true]) {
  test(`a reversed Merge corrects chained Merge history through Undo/Redo and reload (second direction adjusted: ${secondDirectionAdjusted})`, async ({
    page,
    server,
  }) => {
    const initial = server.snapshot();
    initial.find(({ id }) => id === 101)!.confidence = 3;
    initial.find(({ id }) => id === 201)!.confidence = 2;
    initial.push({
      ...initial[0],
      id: 301,
      skeletonId: 40,
      x: 4000,
      y: 2000,
      parentId: null,
    });
    server.reset(initial);
    const ids = [...IDS, 301];
    const ui = new SkeletonEditPage(page);
    await ui.open(server.sourceUrl, [10, 20, 40]);
    await reverseNextMerge(page);
    const held = server.holdNextMutation("skeleton/join");
    await ui.merge(103, 203);
    await held.received;
    if (secondDirectionAdjusted) {
      await reverseNextMerge(page);
      await ui.merge(103, 301);
    } else {
      await ui.merge(301, 103);
    }
    expect(server.mutations).toHaveLength(1);
    held.release();
    await ui.waitSaved();

    const assertRestored = async () => {
      expect(savedParents(server)).toEqual([
        [101, 102],
        [102, 103],
        [103, 203],
        [201, null],
        [202, 201],
        [203, 202],
        [301, null],
      ]);
      expect(server.snapshot().find(({ id }) => id === 201)?.confidence).toBe(
        2,
      );
      await expect
        .poll(async () =>
          topology(await readGraph(page, ids, "Skeletons", true)),
        )
        .toEqual(savedTopology(server));
      expect((await readGraph(page, [201]))[0]?.confidence).toBe(25);
    };
    const restoredSegmentIds = [];
    for (let cycle = 0; cycle < 2; ++cycle) {
      await ui.undo();
      await ui.waitSaved();
      await assertRestored();
      restoredSegmentIds.push(
        server.snapshot().find(({ id }) => id === 201)!.skeletonId,
      );
      if (cycle === 0) {
        await ui.redo();
        await ui.waitSaved();
      }
    }
    expect(restoredSegmentIds[1]).not.toBe(restoredSegmentIds[0]);
    expect(
      server.mutations
        .filter(({ path }) => path === "skeleton/reroot")
        .map(({ body }) => body.treenode_id),
    ).toEqual(["201", "201"]);
    expect(
      (await readQueue(page)).recent.every(({ status }) => status === "saved"),
    ).toBe(true);
    await ui.reload([
      ...new Set(server.snapshot().map(({ skeletonId }) => skeletonId)),
    ]);
    await assertRestored();
  });
}

for (const action of ["Undo Merge", "Reroot then Undo"] as const) {
  test(`a reversed Merge preserves queued ${action} and matches the saved graph`, async ({
    page,
    server,
  }) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(server.sourceUrl);
    await reverseNextMerge(page);
    const held = server.holdNextMutation("skeleton/join");
    await ui.merge(103, 203);
    await held.received;
    if (action === "Undo Merge") {
      await ui.undo();
    } else {
      await ui.reroot(102);
    }
    held.release();
    await ui.waitSaved();
    if (action === "Reroot then Undo") {
      await ui.undo();
      await ui.waitSaved();
      expect(
        server.mutations
          .filter(({ path }) => path === "skeleton/reroot")
          .map(({ body }) => body.treenode_id),
      ).toEqual(["102", "201"]);
    }
    const expectedParents =
      action === "Undo Merge"
        ? INITIAL_PARENTS
        : [
            [101, 102],
            [102, 103],
            [103, 203],
            [201, null],
            [202, 201],
            [203, 202],
          ];
    expect(savedParents(server)).toEqual(expectedParents);
    await expect
      .poll(async () => topology(await readGraph(page, IDS, "Skeletons", true)))
      .toEqual(savedTopology(server));
    expect(
      (await readQueue(page)).recent.every(({ status }) => status === "saved"),
    ).toBe(true);
  });
}

for (const action of ["Delete", "Split", "Confidence"] as const) {
  test(`a reversed Merge corrects dependent ${action} history through Undo/Redo and reload`, async ({
    page,
    server,
  }) => {
    const initial = server.snapshot();
    initial.find(({ id }) => id === 202)!.confidence = 2;
    initial.find(({ id }) => id === 203)!.confidence = 4;
    server.reset(initial);
    const ui = new SkeletonEditPage(page);
    await ui.open(server.sourceUrl);
    await reverseNextMerge(page);
    const held = server.holdNextMutation("skeleton/join");
    await ui.merge(103, 203);
    await held.received;
    expect((await readGraph(page, [202]))[0]).toMatchObject({
      parentId: 203,
      confidence: 75,
    });
    if (action === "Split") {
      await ui.split(202);
    } else {
      await ui.selectNode(202);
      await ui.runEdit(async () => {
        if (action === "Delete") {
          await page
            .locator(
              '.neuroglancer-selection-details-skeleton-action[title="Delete node"]',
            )
            .click();
        } else {
          await page
            .locator(
              "select.neuroglancer-selection-details-skeleton-properties-input",
            )
            .selectOption("50");
        }
      });
    }
    expect(server.mutations).toHaveLength(1);
    held.release();
    await ui.waitSaved();

    const assertRestored = async () => {
      const saved = server.snapshot();
      const restored = saved.find(({ x, y }) => x === 2000 && y === 3000)!;
      expect(restored).toMatchObject({
        parentId: 201,
        confidence: 2,
        radius: 40,
      });
      expect(savedParents(server)).toEqual([
        [101, 102],
        [102, 103],
        [103, 203],
        [201, null],
        ...(action === "Delete" ? [] : [[202, 201]]),
        [203, restored.id],
        ...(action === "Delete" ? [[restored.id, 201]] : []),
      ]);
      const ids = saved.map(({ id }) => id);
      await expect
        .poll(async () =>
          topology(await readGraph(page, ids, "Skeletons", true)),
        )
        .toEqual(savedTopology(server));
      expect((await readGraph(page, [restored.id]))[0]).toMatchObject({
        confidence: 25,
        radius: 40,
      });
      if (action === "Delete") expect(restored.id).not.toBe(202);
      return restored.id;
    };
    for (let cycle = 0; cycle < 2; ++cycle) {
      await ui.undo();
      await ui.waitSaved();
      const restoredId = await assertRestored();
      if (cycle === 0) {
        await ui.redo();
        await ui.waitSaved();
        if (action === "Delete") {
          expect(
            server.mutations
              .filter(({ path }) => path === "treenode/delete")
              .map(({ body }) => body.treenode_id),
          ).toEqual(["202", String(restoredId)]);
        }
      }
    }
    expect(
      (await readQueue(page)).recent.every(({ status }) => status === "saved"),
    ).toBe(true);
    const segmentIds = [
      ...new Set(server.snapshot().map(({ skeletonId }) => skeletonId)),
    ];
    await ui.reload(segmentIds);
    await assertRestored();
  });
}

test("reroot reverses the full path and preserves values through Undo and Redo", async ({
  page,
  server,
}) => {
  const ui = new SkeletonEditPage(page);
  await ui.open(server.sourceUrl);
  const initial = await readGraph(page, IDS, "Skeletons", true);
  const initialSaved = server.snapshot();
  await ui.reroot(103);
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(REROOT_PARENTS);
  await expect
    .poll(async () => parentMap(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual([
      [101, 102],
      [102, 103],
      [103, null],
      [201, null],
      [202, 201],
      [203, 202],
    ]);
  await ui.undo();
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(INITIAL_PARENTS);
  await expect
    .poll(() => readGraph(page, IDS, "Skeletons", true))
    .toEqual(initial);
  expect(server.snapshot()).toEqual(initialSaved);
  await ui.redo();
  await ui.waitSaved();
  expect(savedParents(server)).toEqual(REROOT_PARENTS);
  await expect
    .poll(async () => topology(await readGraph(page, IDS, "Skeletons", true)))
    .toEqual(savedTopology(server));
  expect(server.mutations.map((r) => r.body.treenode_id)).toEqual([
    "103",
    "101",
    "103",
  ]);
});
