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

import { expect } from "@playwright/test";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { Viewer } from "#src/viewer.js";
import { test, change, type RealSession } from "./real_test.js";
import { readGraph, readQueue } from "./skeleton_edit_page.js";

// Hold a real response captured while CATMAID still has the skeleton removed by
// the preview. Confirmation must retire its physical ID even with no snapshot.
async function holdRetiringSegmentRead(real: RealSession, segmentId: number) {
  const { ui, transport } = real;
  const gate = transport.hold(
    `skeletons/${segmentId}/compact-detail`,
    "afterResponse",
    "GET",
  );
  const before = await ui.page.evaluate((segmentId) => {
    const layer = (
      window as unknown as { viewer: Viewer }
    ).viewer.layerManager.getLayerByName("Skeletons")!
      .layer as SegmentationUserLayer;
    return {
      revision: layer.spatialSkeletonState.getCachedSegmentRevision(segmentId),
      cached:
        layer.spatialSkeletonState.getCachedSegmentNodes(segmentId) !==
        undefined,
    };
  }, segmentId);
  expect(before.cached).toBe(false);
  const result = ui.page.evaluate(async (segmentId) => {
    const layer = (
      window as unknown as { viewer: Viewer }
    ).viewer.layerManager.getLayerByName("Skeletons")!
      .layer as SegmentationUserLayer;
    try {
      await layer.spatialSkeletonState.getFullSegmentNodes(
        layer.getSpatiallyIndexedSkeletonLayer()!,
        segmentId,
        { retainWhileInactive: true },
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  }, segmentId);
  // Observe page disposal if an earlier assertion fails; normal errors are checked below.
  void result.catch(() => {});
  expect((await gate.reached).status).toBe(200);
  return async () => {
    const after = await ui.page.evaluate((segmentId) => {
      const layer = (
        window as unknown as { viewer: Viewer }
      ).viewer.layerManager.getLayerByName("Skeletons")!
        .layer as SegmentationUserLayer;
      return {
        revision:
          layer.spatialSkeletonState.getCachedSegmentRevision(segmentId),
        cached:
          layer.spatialSkeletonState.getCachedSegmentNodes(segmentId) !==
          undefined,
      };
    }, segmentId);
    gate.release();
    expect(await result).toBe("AbortError");
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.cached).toBe(false);
  };
}

for (const [number, preset] of [
  [13, "chain"],
  [14, "branch"],
] as const)
  test.describe(preset, () => {
    test.use({ preset });
    test(`[E2E-${number}] Split a ${preset}: complete partitions and repeated Undo/Redo`, async ({
      real,
    }, testInfo) => {
      const { ui, ids, original, transport } = real;
      await real.open();
      const split = change(original, ids.Amiddle, { parentId: null });
      const gate = transport.hold("skeleton/split");
      await ui.split(ids.Amiddle);
      await gate.reached;
      await real.pending(split);
      await real.persisted(original, false);
      expect((await ui.selected()).id).toBe(ids.Amiddle);
      await ui.page.screenshot({
        path: testInfo.outputPath("split-partitions.png"),
      });
      gate.release();
      let graph = await real.saved(split);
      let splitId = graph.find((node) => node.id === ids.Amiddle)!.skeletonId;
      expect(splitId).not.toBe(real.api.initial[0].skeletonId);
      await real.visibleCurrentSegments();
      for (let cycle = 0; cycle < 2; ++cycle) {
        const join = transport.hold("skeleton/join");
        await ui.undo();
        await join.reached;
        await real.pending(original);
        const expectRetired = await holdRetiringSegmentRead(real, splitId);
        join.release();
        await real.saved(original);
        await expectRetired();
        await real.persisted(original);
        await ui.redo();
        graph = await real.saved(split);
        const next = graph.find((node) => node.id === ids.Amiddle)!.skeletonId;
        expect(next).not.toBe(splitId);
        splitId = next;
        await real.visibleCurrentSegments();
      }
      expect(transport.mutations.map((record) => record.endpoint)).toEqual([
        "skeleton/split",
        "skeleton/join",
        "skeleton/split",
        "skeleton/join",
        "skeleton/split",
      ]);
      await real.reload(split);
    });
  });

test.describe("merge at root", () => {
  test.use({ seedOverrides: { Broot: { confidence: 25 } } });
  test("[E2E-15] Merge at the target root separates again without reroot", async ({
    real,
  }) => {
    const { ui, ids, original, transport } = real;
    await real.open();
    const merged = change(original, ids.Broot, { parentId: ids.Amiddle });
    const gate = transport.hold("skeleton/join");
    await ui.merge(ids.Amiddle, ids.Broot);
    await gate.reached;
    await real.pending(merged);
    await real.persisted(original, false);
    expect((await ui.selected()).id).toBe(ids.Broot);
    const targetId = real.api.initial.find(
      (node) => node.id === ids.Broot,
    )!.skeletonId;
    const expectRetired = await holdRetiringSegmentRead(real, targetId);
    gate.release();
    await real.saved(merged);
    await expectRetired();
    await real.persisted(merged);
    expect((await ui.selected()).id).toBe(ids.Broot);
    await real.visibleCurrentSegments();
    await ui.undo();
    await real.saved(original);
    await ui.redo();
    await real.saved(merged);
    expect(transport.mutations.map((record) => record.endpoint)).toEqual([
      "skeleton/join",
      "skeleton/split",
      "skeleton/join",
    ]);
    await real.reload(merged);
  });
});

test.describe("branched merge", () => {
  test.use({
    preset: "branchPair",
    seedOverrides: { Broot: { confidence: 25 } },
  });
  test("[E2E-16] non-root Merge preserves branches and restores both original roots repeatedly", async ({
    real,
  }, testInfo) => {
    const { ui, ids, original, transport } = real;
    await real.open();
    const merged = change(
      change(
        change(original, ids.Bside, { parentId: ids.Aside }),
        ids.Bmiddle,
        { parentId: ids.Bside },
      ),
      ids.Broot,
      { parentId: ids.Bmiddle, confidence: 100 },
    );
    const forward = transport.hold("skeleton/join");
    await ui.merge(ids.Aside, ids.Bside);
    await forward.reached;
    await real.pending(merged);
    await real.persisted(original, false);
    expect((await ui.selected()).id).toBe(ids.Bside);
    forward.release();
    await real.saved(merged);
    await real.visibleCurrentSegments();
    let previousTargetSkeleton = real.api.initial.find(
      (node) => node.id === ids.Broot,
    )!.skeletonId;
    for (let cycle = 0; cycle < 2; ++cycle) {
      const splitGate = transport.hold("skeleton/split", "afterResponse");
      const rerootGate = transport.hold("skeleton/reroot", "afterResponse");
      const confidenceGate = transport.hold(
        `treenodes/${ids.Broot}/confidence`,
      );
      await ui.undo();
      await splitGate.reached;
      await real.pending(original);
      await real.persisted(
        change(merged, ids.Bside, { parentId: null }),
        false,
      );
      expect(transport.mutations.at(-1)!.endpoint).toBe("skeleton/split");
      splitGate.release();
      await rerootGate.reached;
      await real.pending(original);
      await real.persisted(
        change(original, ids.Broot, { confidence: 100 }),
        false,
      );
      expect(
        (await readQueue(ui.page)).recent.filter(
          (entry) => entry.intent === "undo",
        ),
      ).toHaveLength(cycle);
      await ui.page.screenshot({
        path: testInfo.outputPath(`original-roots-before-ack-${cycle}.png`),
      });
      rerootGate.release();
      await confidenceGate.reached;
      await real.pending(original);
      confidenceGate.release();
      const restored = await real.saved(original);
      expect((await ui.selected()).id).toBe(ids.Bside);
      const targetSkeleton = restored.find(
        (node) => node.id === ids.Broot,
      )!.skeletonId;
      expect(targetSkeleton).not.toBe(previousTargetSkeleton);
      previousTargetSkeleton = targetSkeleton;
      await real.visibleCurrentSegments();
      if (cycle === 0) {
        await ui.redo();
        await real.saved(merged);
      }
    }
    expect(transport.mutations.map((record) => record.endpoint)).toEqual([
      "skeleton/join",
      "skeleton/split",
      "skeleton/reroot",
      `treenodes/${ids.Broot}/confidence`,
      "skeleton/join",
      "skeleton/split",
      "skeleton/reroot",
      `treenodes/${ids.Broot}/confidence`,
    ]);
    expect(
      transport.mutations
        .filter((record) => record.endpoint === "skeleton/reroot")
        .map((record) => record.body.treenode_id),
    ).toEqual([String(ids.Broot), String(ids.Broot)]);
    await real.reload(original);
  });
});

test("[E2E-17] cold Merge target is prepared before preview and before the CATMAID request", async ({
  real,
}) => {
  const { ui, ids, original, transport } = real;
  const sourceSkeleton = real.api.initial.find(
    (node) => node.id === ids.Aroot,
  )!.skeletonId;
  const targetSkeleton = real.api.initial.find(
    (node) => node.id === ids.Broot,
  )!.skeletonId;
  const endpoint = `skeletons/${targetSkeleton}/compact-detail`;
  // Visible skeletons may prefetch full details. Hold the first target read
  // before opening the page so Merge must still wait for real preparation.
  const read = transport.hold(endpoint, "beforeRequest", "GET");
  await real.open([sourceSkeleton]);
  expect(
    transport.records
      .filter((record) => record.endpoint === endpoint)
      .every((record) => record.acknowledged === undefined),
  ).toBe(true);
  // The target can be picked from spatial chunks without complete details.
  expect(await readGraph(ui.page, [ids.Bmiddle])).toEqual([]);
  const mutation = transport.hold("skeleton/join");
  const merging = ui.mergeAtPosition(
    ids.Amiddle,
    original.find((node) => node.id === ids.Bmiddle)!.position,
  );
  void merging.catch(() => {}); // The awaited promise below still propagates failures.
  await read.reached;
  await expect(
    ui.page.getByText("Merging skeletons...", { exact: true }),
  ).toBeVisible();
  const { entries } = await readQueue(ui.page);
  expect(entries).toHaveLength(1);
  expect(entries[0].lifecycle).toMatchObject({
    preview: "preparing",
    authority: "queued",
  });
  expect(transport.mutations).toHaveLength(0);
  await real.preview(
    original.filter(
      (node) =>
        real.api.initial.find((saved) => saved.id === node.id)!.skeletonId ===
        sourceSkeleton,
    ),
  );
  expect(await readGraph(ui.page, [ids.Bmiddle])).toEqual([]);
  await real.persisted(original, false);
  read.release();
  await merging;
  await mutation.reached;
  const merged = change(
    change(original, ids.Bmiddle, { parentId: ids.Amiddle }),
    ids.Broot,
    { parentId: ids.Bmiddle },
  );
  await real.pending(merged);
  expect((await ui.selected()).id).toBe(ids.Bmiddle);
  expect(
    transport.records.find((record) => record.endpoint === endpoint)!
      .acknowledged,
  ).toBeDefined();
  mutation.release();
  await real.saved(merged);
  await ui.undo();
  await real.saved(original);
  await real.reload(original);
});

test.describe("branched reroot", () => {
  test.use({
    preset: "branch",
    seedOverrides: {
      Aroot: { confidence: 25 },
      Amiddle: { confidence: 75 },
      Aside: { confidence: 50 },
      Aleaf: { confidence: 25, description: "side branch" },
    },
  });
  test("[E2E-18] reroot reverses the attachment path and carries edge confidence", async ({
    real,
  }) => {
    const { ui, ids, original, transport } = real;
    await real.open();
    // CATMAID stores edge confidence on the child; reversing an edge transfers it.
    const rerooted = change(
      change(
        change(original, ids.Aside, { parentId: null, confidence: 100 }),
        ids.Amiddle,
        { parentId: ids.Aside, confidence: 50 },
      ),
      ids.Aroot,
      { parentId: ids.Amiddle, confidence: 75 },
    );
    const gate = transport.hold("skeleton/reroot");
    await ui.reroot(ids.Aside);
    await gate.reached;
    await real.pending(rerooted);
    await real.persisted(original, false);
    expect((await ui.selected()).id).toBe(ids.Aside);
    gate.release();
    await real.saved(rerooted);
    const restoreConfidence = transport.hold(
      `treenodes/${ids.Aroot}/confidence`,
    );
    await ui.undo();
    await restoreConfidence.reached;
    await real.pending(original);
    await real.persisted(
      change(original, ids.Aroot, { confidence: 100 }),
      false,
    );
    restoreConfidence.release();
    await real.saved(original);
    await ui.redo();
    await real.saved(rerooted);
    expect(
      transport.mutations
        .filter((record) => record.endpoint === "skeleton/reroot")
        .map((record) => record.body.treenode_id),
    ).toEqual([String(ids.Aside), String(ids.Aroot), String(ids.Aside)]);
    await real.reload(rerooted);
  });
});
