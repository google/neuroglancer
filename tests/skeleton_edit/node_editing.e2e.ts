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
import { test, change, model, remap, type ModelNode } from "./real_test.js";
import {
  readGraph,
  readQueue,
  readRenderedNodeIds,
} from "./skeleton_edit_page.js";

for (const [index, field] of [
  "move",
  "radius",
  "confidence",
  "description",
  "true-end",
].entries()) {
  test(`[E2E-${String(index + 1).padStart(2, "0")}] ${field}: preview, Undo/Redo and persistence`, async ({
    real,
  }, testInfo) => {
    const { ui, ids, original, transport } = real;
    // A meaningful initial description checks preservation when toggling true-end.
    if (field === "true-end") {
      await real.api.request(
        `label/treenode/${ids.Aleaf}/update`,
        new URLSearchParams({ tags: "preserve me", delete_existing: "true" }),
      );
      real.api.initial = await real.api.snapshot();
    }
    const before = real.original;
    const id = field === "true-end" ? ids.Aleaf : ids.Amiddle;
    await real.open();
    if (field === "move") {
      for (const reactivateBeforeMouseup of [false, true]) {
        await test.step(`deactivation cancels a drag${reactivateBeforeMouseup ? " across reactivation" : ""}`, async () => {
          const queueBefore = await readQueue(ui.page);
          const pendingDragNodes = () =>
            ui.page.evaluate(() => {
              const layer = (
                window as unknown as { viewer: Viewer }
              ).viewer.layerManager.getLayerByName("Skeletons")!
                .layer as SegmentationUserLayer;
              return Array.from(layer.spatialSkeletonState.getPendingNodeIds());
            });
          await ui.selectNode(id);
          const center = await ui.panelCenter();
          await ui.page.mouse.move(center.x, center.y);
          await ui.page.mouse.down();
          await ui.page.mouse.move(center.x + 20, center.y + 15, { steps: 4 });
          expect(await pendingDragNodes()).toEqual([id]);
          await ui.page.keyboard.press("Shift+E");
          await expect(
            ui.page.getByText("Skeleton editing", { exact: true }),
          ).not.toBeVisible();
          expect(await pendingDragNodes()).toEqual([]);
          if (reactivateBeforeMouseup) await ui.activate();
          await ui.page.mouse.move(center.x + 40, center.y + 30, { steps: 4 });
          await ui.page.mouse.up();
          expect(await readQueue(ui.page)).toEqual(queueBefore);
          expect(transport.mutations).toHaveLength(0);
          expect(await pendingDragNodes()).toEqual([]);
          await expect(
            ui.page.locator('[data-skeleton-press-mode="move"]'),
          ).toHaveCount(0);
          await real.persisted(before);
          if (!reactivateBeforeMouseup) await ui.activate();
        });
      }
    }
    const endpoint =
      field === "move"
        ? "node/update"
        : field === "radius"
          ? `treenode/${id}/radius`
          : field === "confidence"
            ? `treenodes/${id}/confidence`
            : `label/treenode/${id}/update`;
    const gate = transport.hold(endpoint, "beforeRequest");
    let patch: Partial<ModelNode>;
    if (field === "move") {
      patch = {
        position: (await real.moved(before, id)).find((node) => node.id === id)!
          .position,
      };
    } else if (field === "radius") {
      await ui.radius(id, 160);
      patch = { radius: 160 };
    } else if (field === "confidence") {
      await ui.confidence(id, 75);
      patch = { confidence: 75 };
    } else if (field === "description") {
      await ui.description(id, "Árvore, ramo\nβeta");
      patch = { description: "Árvore, ramo\nβeta" };
    } else {
      await ui.trueEnd(id);
      patch = { isTrueEnd: true };
    }
    const edited = change(before, id, patch);
    await gate.reached;
    await real.pending(edited);
    await real.persisted(before, false);
    await ui.page.screenshot({
      path: testInfo.outputPath("pending-preview.png"),
    });
    const descriptionInput = ui.page.getByRole("textbox", {
      name: "Description",
      exact: true,
    });
    if (field === "move") {
      await descriptionInput.focus();
      await descriptionInput.press("ControlOrMeta+a");
      await ui.page.keyboard.type("unfinished description α");
      await expect(descriptionInput).toBeFocused();
    }
    gate.release();
    await real.saved(edited);
    if (field === "move") {
      // Acknowledging Move must neither submit the draft nor replace its focused
      // editor. Only the user's subsequent blur should enqueue the description.
      expect(transport.mutations).toHaveLength(1);
      await expect(descriptionInput).toBeFocused();
      await expect(descriptionInput).toHaveValue("unfinished description α");
      // Native text Undo/Redo must survive the acknowledgement, without touching
      // skeleton history or sending a description mutation.
      const queueBeforeTextUndo = await readQueue(ui.page);
      await descriptionInput.press("ControlOrMeta+z");
      await expect(descriptionInput).not.toHaveValue(
        "unfinished description α",
      );
      await descriptionInput.press("ControlOrMeta+Shift+z");
      await expect(descriptionInput).toHaveValue("unfinished description α");
      expect(await readQueue(ui.page)).toEqual(queueBeforeTextUndo);
      expect(transport.mutations).toHaveLength(1);
      await ui.page.keyboard.type(" completed");
      await ui.runEdit(() => descriptionInput.press("Tab"));
      await real.saved(
        change(edited, id, {
          description: "unfinished description α completed",
        }),
      );
      await ui.undo();
      await real.saved(edited);
    }
    await ui.undo();
    await real.saved(before);
    await ui.redo();
    await real.saved(edited);
    if (field === "description") {
      for (const input of ["", "ends", "  \n\t"]) {
        const cleared = change(before, id, { description: "" });
        await ui.description(id, input);
        await real.saved(cleared);
        await ui.undo();
        await real.saved(edited);
        await ui.redo();
        await real.saved(cleared);
        await ui.undo();
        await real.saved(edited);
      }
    }
    expect(transport.mutations).toHaveLength(
      field === "description" ? 15 : field === "move" ? 5 : 3,
    );
    if (field === "move") {
      await test.step("Move acknowledgement preserves an unsubmitted Radius draft", async () => {
        const mutationStart = transport.mutations.length;
        const acknowledgement = transport.hold("node/update", "afterResponse");
        const moved = await real.moved(edited, id);
        await acknowledgement.reached;
        await real.pending(moved);
        const radiusInput = ui.page.getByRole("spinbutton");
        await radiusInput.fill("123");
        await expect(radiusInput).toBeFocused();
        acknowledgement.release();
        await real.saved(moved);
        expect(transport.mutations).toHaveLength(mutationStart + 1);
        await expect(radiusInput).toBeFocused();
        await expect(radiusInput).toHaveValue("123");
        // The unsubmitted value must still commit on blur without further typing.
        await ui.runEdit(() => radiusInput.press("Tab"));
        await real.saved(change(moved, id, { radius: 123 }));
        expect(transport.mutations).toHaveLength(mutationStart + 2);
        await ui.undo();
        await real.saved(moved);
        await ui.undo();
        await real.saved(edited);
      });
      await test.step("Move acknowledgement preserves a pending Radius spinner save", async () => {
        const mutationStart = transport.mutations.length;
        const acknowledgement = transport.hold("node/update", "afterResponse");
        const moved = await real.moved(edited, id);
        await acknowledgement.reached;
        await real.pending(moved);
        const radiusInput = ui.page.getByRole("spinbutton");
        const radiusSave = transport.hold(`treenode/${id}/radius`);
        await radiusInput.focus();
        await ui.runEdit(async () => {
          await radiusInput.press("ArrowUp");
          await expect(radiusInput).toHaveValue("101");
          acknowledgement.release();
        });
        // Wait for the real debounce to dispatch, without blurring the control.
        await radiusSave.reached;
        const resized = change(moved, id, { radius: 101 });
        expect(
          transport.mutations
            .slice(mutationStart)
            .map((record) => record.endpoint),
        ).toEqual(["node/update", `treenode/${id}/radius`]);
        await real.pending(resized);
        await real.persisted(moved, false);
        radiusSave.release();
        await real.saved(resized);
        await ui.undo();
        await real.saved(moved);
        await ui.undo();
        await real.saved(edited);
      });
    }
    await real.reload(edited);
    expect(original.length).toBe(before.length);
  });
}

test.describe("creation", () => {
  test.use({ preset: "empty" });
  test("[E2E-06] pending root and child chain remap IDs through full Undo/Redo", async ({
    real,
  }, testInfo) => {
    const { ui, transport } = real;
    await real.open();
    const held = transport.hold("treenode/create");
    const root = await ui.createRoot();
    await held.reached;
    const middle = await ui.addChild();
    const leaf = await ui.addChild();
    const moved = await ui.moveSelected();
    expect(middle.parentId).toBe(root.id);
    expect(leaf.parentId).toBe(middle.id);
    expect(moved.id).toBe(leaf.id);
    expect(moved.position).not.toEqual(leaf.position);
    const preview = model([root, middle, moved]);
    await real.pending(preview);
    await real.persisted([], false);
    expect(transport.mutations).toHaveLength(1);
    await ui.page.screenshot({
      path: testInfo.outputPath("pending-chain.png"),
    });
    held.release();
    await ui.waitSaved();
    const created = transport.mutations.filter(
      (record) => record.endpoint === "treenode/create",
    );
    expect(created).toHaveLength(3);
    let saved = preview;
    [root, middle, leaf].forEach((node, i) => {
      saved = remap(saved, node.id, created[i].response.treenode_id);
    });
    expect(created[1].body.parent_id).toBe(
      String(created[0].response.treenode_id),
    );
    expect(created[2].body.parent_id).toBe(
      String(created[1].response.treenode_id),
    );
    expect(transport.mutations.at(-1)!.body["t[0][0]"]).toBe(
      String(created[2].response.treenode_id),
    );
    await real.saved(saved);
    expect((await ui.selected()).id).toBe(created[2].response.treenode_id);
    await real.visibleCurrentSegments();
    const beforeMove = change(saved, created[2].response.treenode_id, {
      position: leaf.position,
    });
    const undoSteps = [
      beforeMove,
      beforeMove.filter((node) => node.id !== created[2].response.treenode_id),
      beforeMove.filter((node) => node.id === created[0].response.treenode_id),
      [],
    ];
    for (const expected of undoSteps) {
      const heldUndo =
        expected === undoSteps[0]
          ? undefined
          : transport.hold("treenode/delete", "afterResponse");
      await ui.undo();
      if (heldUndo) {
        await heldUndo.reached;
        await real.pending(expected);
        heldUndo.release();
      }
      await real.saved(expected);
    }
    let redone = beforeMove;
    for (let i = 0; i < 3; ++i) {
      await ui.redo();
      await ui.waitSaved();
      const id = transport.mutations.at(-1)!.response.treenode_id;
      redone = remap(redone, created[i].response.treenode_id, id);
      const remainingIds = created
        .slice(i + 1)
        .map((record) => record.response.treenode_id);
      await real.persisted(
        redone.filter((node) => !remainingIds.includes(node.id)),
      );
    }
    await ui.redo();
    await ui.waitSaved();
    const recreated = transport.mutations
      .filter((record) => record.endpoint === "treenode/create")
      .slice(-3);
    let restored = saved;
    created.forEach((record, i) => {
      expect(recreated[i].response.treenode_id).not.toBe(
        record.response.treenode_id,
      );
      restored = remap(
        restored,
        record.response.treenode_id,
        recreated[i].response.treenode_id,
      );
    });
    await real.persisted(restored);
    await real.visibleCurrentSegments();

    const [rootId, middleId] = recreated.map(
      (record) => record.response.treenode_id,
    );
    await test.step("new root confidence survives reroot and repeated Undo/Redo", async () => {
      const rerooted = change(
        change(restored, middleId, { parentId: null, confidence: 100 }),
        rootId,
        { parentId: middleId },
      );
      const gate = transport.hold("skeleton/reroot");
      await ui.reroot(middleId);
      await gate.reached;
      await real.pending(rerooted);
      await real.persisted(restored, false);
      gate.release();
      await real.saved(rerooted);
      for (let cycle = 0; cycle < 2; ++cycle) {
        const confidenceGate = transport.hold(`treenodes/${rootId}/confidence`);
        await ui.undo();
        await confidenceGate.reached;
        await real.pending(restored);
        await real.persisted(
          change(restored, rootId, { confidence: 100 }),
          false,
        );
        confidenceGate.release();
        await real.saved(restored);
        if (cycle === 0) {
          await ui.redo();
          await real.saved(rerooted);
        }
      }
    });

    await test.step("new root confidence survives non-root Merge and repeated Undo/Redo", async () => {
      await ui.createRoot(-100, 80);
      await ui.waitSaved();
      const source = await ui.selected();
      restored = [...restored, ...model([source])];
      const beforeMerge = await real.saved(restored);
      let previousSegment = beforeMerge.find(
        (node) => node.id === rootId,
      )!.skeletonId;
      const merged = change(
        change(restored, middleId, { parentId: source.id, confidence: 100 }),
        rootId,
        { parentId: middleId },
      );
      const gate = transport.hold("skeleton/join");
      await ui.merge(source.id, middleId);
      await gate.reached;
      await real.pending(merged);
      await real.persisted(restored, false);
      gate.release();
      await real.saved(merged);
      for (let cycle = 0; cycle < 2; ++cycle) {
        const confidenceGate = transport.hold(`treenodes/${rootId}/confidence`);
        await ui.undo();
        await confidenceGate.reached;
        await real.pending(restored);
        await real.persisted(
          change(restored, rootId, { confidence: 100 }),
          false,
        );
        confidenceGate.release();
        const savedNodes = await real.saved(restored);
        const currentSegment = savedNodes.find(
          (node) => node.id === rootId,
        )!.skeletonId;
        expect(currentSegment).not.toBe(previousSegment);
        previousSegment = currentSegment;
        await real.visibleCurrentSegments();
        if (cycle === 0) {
          await ui.redo();
          await real.saved(merged);
        }
      }
    });
    await test.step("drag survives creation acknowledgement before mouse-up", async () => {
      const mutationStart = transport.mutations.length;
      const creation = transport.hold("treenode/create", "afterResponse");
      const provisional = await ui.createRoot(-100, -80);
      const acknowledgement = await creation.reached;
      const permanentId = acknowledgement.response.treenode_id;
      const center = await ui.panelCenter();
      // Creating the root centers the viewport on its provisional preview.
      const start = center;
      const dragPosition = (id: number) =>
        ui.page.evaluate((id) => {
          const layer = (
            window as unknown as { viewer: Viewer }
          ).viewer.layerManager.getLayerByName("Skeletons")!
            .layer as SegmentationUserLayer;
          return Array.from(
            layer.spatialSkeletonState.getPendingNodePosition(id) ?? [],
          );
        }, id);
      await ui.page.mouse.move(start.x, start.y);
      await ui.page.mouse.down();
      await ui.page.mouse.move(start.x + 20, start.y + 15, { steps: 4 });
      const firstPosition = await dragPosition(provisional.id);
      expect(firstPosition).toHaveLength(3);
      expect(firstPosition).not.toEqual(provisional.position);
      creation.release();
      await ui.waitSaved();
      expect((await ui.selected()).id).toBe(permanentId);
      expect(await dragPosition(permanentId)).toEqual(firstPosition);
      await ui.page.mouse.move(start.x + 40, start.y + 30, { steps: 4 });
      const finalPosition = await dragPosition(permanentId);
      expect(finalPosition).toHaveLength(3);
      expect(finalPosition).not.toEqual(firstPosition);
      const moveGate = transport.hold("node/update");
      await ui.runEdit(() => ui.page.mouse.up());
      const move = await moveGate.reached;
      expect(move.body["t[0][0]"]).toBe(String(permanentId));
      expect(
        transport.mutations
          .slice(mutationStart)
          .map((record) => record.endpoint),
      ).toEqual(["treenode/create", "node/update"]);
      const created = remap(
        [...restored, ...model([provisional])],
        provisional.id,
        permanentId,
      );
      const moved = change(created, permanentId, { position: finalPosition });
      await real.pending(moved);
      await real.persisted(created, false);
      await ui.page.screenshot({
        path: testInfo.outputPath("drag-after-creation-ack.png"),
      });
      moveGate.release();
      await real.saved(moved);
      await ui.undo();
      await real.saved(created);
      await ui.undo();
      await real.saved(restored);
      await ui.redo();
      await ui.waitSaved();
      const replacementId = (await ui.selected()).id;
      expect(replacementId).not.toBe(permanentId);
      await real.saved(remap(created, permanentId, replacementId));
      await ui.redo();
      restored = remap(moved, permanentId, replacementId);
      await real.saved(restored);
      expect(transport.mutations.at(-1)!.body["t[0][0]"]).toBe(
        String(replacementId),
      );
      await real.visibleCurrentSegments();
    });
    await test.step("Description draft survives a new root's permanent ID", async () => {
      const mutationStart = transport.mutations.length;
      const creation = transport.hold("treenode/create", "afterResponse");
      const provisional = await ui.createRoot(100, -80);
      const acknowledgement = await creation.reached;
      const permanentId = acknowledgement.response.treenode_id;
      await real.pending([...restored, ...model([provisional])]);
      await ui.page
        .getByRole("textbox", { name: "Enter node ID or description" })
        .fill("");
      await ui.page
        .locator('.neuroglancer-skeleton-tree-row[role="button"]')
        .filter({ has: ui.page.locator('[data-provisional="true"]') })
        .click();
      const input = ui.page.getByRole("textbox", {
        name: "Description",
        exact: true,
      });
      await input.focus();
      await ui.page.keyboard.insertText("unfinished α\nβ description");
      await input.press("Home");
      await input.press("ArrowRight");
      const caret = () =>
        input.evaluate((element: HTMLTextAreaElement) => ({
          start: element.selectionStart,
          end: element.selectionEnd,
          direction: element.selectionDirection,
        }));
      const beforeCaret = await caret();
      const editor = await input.elementHandle();
      creation.release();
      const created = remap(
        [...restored, ...model([provisional])],
        provisional.id,
        permanentId,
      );
      await real.saved(created);
      expect((await ui.selected()).id).toBe(permanentId);
      expect(transport.mutations).toHaveLength(mutationStart + 1);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("unfinished α\nβ description");
      expect(await caret()).toEqual(beforeCaret);
      expect(
        await editor!.evaluate((element) => element === document.activeElement),
      ).toBe(true);
      await input.press("ControlOrMeta+z");
      await expect(input).not.toHaveValue("unfinished α\nβ description");
      await input.press("ControlOrMeta+Shift+z");
      await expect(input).toHaveValue("unfinished α\nβ description");
      // Clicking Delete blurs/saves the draft and must target the current
      // permanent ID even though the focused editor deferred this view's redraw.
      // Span animation frames between press and release to catch lost clicks.
      await ui.runEdit(() =>
        ui.page
          .locator(
            '.neuroglancer-selection-details-skeleton-action[title="Delete node"]',
          )
          .click({ delay: 150 }),
      );
      const described = change(created, permanentId, {
        description: "unfinished α\nβ description",
      });
      await expect
        .poll(() => transport.mutations.length)
        .toBe(mutationStart + 3);
      await real.saved(restored);
      expect(
        transport.mutations
          .slice(mutationStart + 1)
          .map((record) => record.endpoint),
      ).toEqual([`label/treenode/${permanentId}/update`, "treenode/delete"]);
      expect(transport.mutations.at(-1)!.body.treenode_id).toBe(
        String(permanentId),
      );
      await ui.undo();
      await ui.waitSaved();
      const replacementId = transport.mutations
        .filter((record) => record.endpoint === "treenode/create")
        .at(-1)!.response.treenode_id;
      expect(replacementId).not.toBe(permanentId);
      const recreated = remap(created, permanentId, replacementId);
      const recreatedDescription = remap(described, permanentId, replacementId);
      await real.saved(recreatedDescription);
      await ui.undo();
      await real.saved(recreated);
      await ui.redo();
      await real.saved(recreatedDescription);
      await ui.redo();
      await real.saved(restored);
      expect(transport.mutations.at(-1)!.body.treenode_id).toBe(
        String(replacementId),
      );
      await ui.undo();
      await ui.waitSaved();
      const finalId = transport.mutations
        .filter((record) => record.endpoint === "treenode/create")
        .at(-1)!.response.treenode_id;
      expect(finalId).not.toBe(replacementId);
      restored = remap(described, permanentId, finalId);
      await real.saved(restored);
    });
    await real.reload(restored);
  });
});

test("[E2E-07] adding children branches an existing tree without changing its original nodes", async ({
  real,
}) => {
  const { ui, ids, original, transport } = real;
  await real.open();
  let expected = original;
  for (const offset of [25, -25]) {
    const gate = transport.hold("treenode/create");
    const preview = await ui.addChild(ids.Amiddle, 30, offset);
    expect(preview.parentId).toBe(ids.Amiddle);
    await gate.reached;
    const next = [...expected, ...model([preview])];
    await real.pending(next);
    await real.persisted(expected, false);
    gate.release();
    await ui.waitSaved();
    const id = transport.mutations.at(-1)!.response.treenode_id;
    expected = remap(next, preview.id, id);
    await real.saved(expected);
    expect((await ui.selected()).id).toBe(id);
  }
  await ui.undo();
  await ui.waitSaved();
  await real.persisted(expected.slice(0, -1));
  await ui.undo();
  await real.saved(original);
  await ui.redo();
  await ui.waitSaved();
  const firstChild = expected.find(
    (node) => !original.some((originalNode) => originalNode.id === node.id),
  )!;
  expected = remap(
    expected,
    firstChild.id,
    transport.mutations.at(-1)!.response.treenode_id,
  );
  const secondChild = expected.find(
    (node) =>
      node.id !== transport.mutations.at(-1)!.response.treenode_id &&
      !original.some((originalNode) => originalNode.id === node.id),
  )!;
  await real.persisted(expected.filter((node) => node.id !== secondChild.id));
  await ui.redo();
  await ui.waitSaved();
  const oldId = secondChild.id;
  expected = remap(
    expected,
    oldId,
    transport.mutations.at(-1)!.response.treenode_id,
  );
  await real.persisted(expected);
  await real.visibleCurrentSegments();
  await real.reload(expected);
});

const deletions = [
  { number: 8, name: "leaf", preset: "chain", target: "Aleaf" },
  {
    number: 9,
    name: "internal chain node",
    preset: "chain",
    target: "Amiddle",
  },
  { number: 10, name: "branch node", preset: "branch", target: "Amiddle" },
  { number: 12, name: "singleton", preset: "singleton", target: "Aroot" },
] as const;
for (const item of deletions)
  test.describe(item.name, () => {
    test.use({
      preset: item.preset,
      seedOverrides: {
        [item.target]: {
          radius: 140,
          confidence: 75,
          description: "restore, détails",
          isTrueEnd: item.name === "leaf" || item.name === "singleton",
        },
      },
    });
    test(`[E2E-${String(item.number).padStart(2, "0")}] delete and restore ${item.name} with replacement IDs`, async ({
      real,
    }, testInfo) => {
      const { ui, original, ids, transport } = real;
      const id = ids[item.target];
      const deleted = original.find((node) => node.id === id)!;
      const after = original
        .filter((node) => node.id !== id)
        .map((node) => ({
          ...node,
          parentId: node.parentId === id ? deleted.parentId : node.parentId,
        }));
      await real.open();
      const forward = transport.hold("treenode/delete");
      await ui.deleteNode(id);
      await forward.reached;
      await real.pending(after);
      await real.persisted(original, false);
      forward.release();
      await real.saved(after);
      const restoreEndpoint = original.some((node) => node.parentId === id)
        ? "treenode/insert"
        : "treenode/create";
      // Match the creation step; the returned ID is deliberately unknown beforehand.
      const restore = transport.hold(restoreEndpoint, "afterResponse");
      await ui.undo();
      const creation = await restore.reached;
      const restoredId = creation.response.treenode_id;
      expect(restoredId).not.toBe(id);
      // Before the acknowledgement, Undo uses a provisional node identity.
      const selected = await ui.selected();
      const preview = await readGraph(
        ui.page,
        [...real.knownIds, selected.id],
        "Skeletons",
        true,
      );
      const provisional = preview.find(
        (node) => !after.some((existing) => existing.id === node.id),
      );
      expect(provisional).toBeDefined();
      await real.pending(remap(original, id, provisional!.id));
      restore.release();
      const restored = remap(original, id, restoredId);
      await real.saved(restored);
      expect((await ui.selected()).id).toBe(restoredId);
      expect(
        transport.mutations.some(
          (record) => record.endpoint === restoreEndpoint,
        ),
      ).toBe(true);
      await ui.page.screenshot({
        path: testInfo.outputPath("restored-node.png"),
      });
      if (item.name === "singleton") {
        await expect
          .poll(() => readRenderedNodeIds(ui.page))
          .toEqual([restoredId]);
      }
      const deletion = transport.hold("treenode/delete");
      await ui.redo();
      await deletion.reached;
      await real.pending(after);
      if (item.name === "singleton") {
        await expect.poll(() => readRenderedNodeIds(ui.page)).toEqual([]);
        await ui.page.screenshot({
          path: testInfo.outputPath("deleted-singleton-preview.png"),
        });
      }
      deletion.release();
      await real.saved(after);
      if (item.name === "singleton") {
        await expect.poll(() => readRenderedNodeIds(ui.page)).toEqual([]);
      }
      expect(transport.mutations.at(-1)!.body.treenode_id).toBe(
        String(restoredId),
      );
      await ui.undo();
      await ui.waitSaved();
      const nextId = transport.mutations
        .filter((record) => record.endpoint === restoreEndpoint)
        .at(-1)!.response.treenode_id;
      await real.persisted(remap(original, id, nextId));
      await real.visibleCurrentSegments();
      await real.reload(remap(original, id, nextId));
    });
  });

test.describe("root with one child", () => {
  test.use({
    preset: "rootChild",
    seedOverrides: {
      Aroot: { radius: 140, description: "original root, détails" },
      Amiddle: { confidence: 75 },
    },
  });
  test("[E2E-11] reroot then delete the former root and restore the original tree", async ({
    real,
  }, testInfo) => {
    const { ui, original, ids, transport } = real;
    await real.open();
    // The existing UI requires manual reroot before deleting a root with children.
    await ui.selectNode(ids.Aroot);
    await expect(
      ui.page
        .getByTitle(
          "Reroot the skeleton manually before deleting the current root node.",
          { exact: true },
        )
        .filter({ has: ui.page.locator("svg") })
        .first(),
    ).toBeDisabled();
    const rerooted = change(
      change(original, ids.Aroot, { parentId: ids.Amiddle, confidence: 75 }),
      ids.Amiddle,
      { parentId: null, confidence: 100 },
    );
    await ui.reroot(ids.Amiddle);
    await real.saved(rerooted);
    const deleted = rerooted.filter((node) => node.id !== ids.Aroot);
    const forward = transport.hold("treenode/delete");
    await ui.deleteNode(ids.Aroot);
    await forward.reached;
    await real.pending(deleted);
    await real.persisted(rerooted, false);
    forward.release();
    await real.saved(deleted);
    const restore = transport.hold("treenode/create", "afterResponse");
    await ui.undo();
    const request = await restore.reached;
    const temporary = (await ui.selected()).id;
    await real.pending(remap(rerooted, ids.Aroot, temporary));
    await ui.page.screenshot({
      path: testInfo.outputPath("former-root-restoration.png"),
    });
    restore.release();
    const replacement = request.response.treenode_id;
    expect(replacement).not.toBe(ids.Aroot);
    await real.saved(remap(rerooted, ids.Aroot, replacement));
    await ui.undo();
    await real.saved(remap(original, ids.Aroot, replacement));
    await ui.redo();
    await real.saved(remap(rerooted, ids.Aroot, replacement));
    await ui.redo();
    await real.saved(deleted);
    expect(transport.mutations.at(-1)!.body.treenode_id).toBe(
      String(replacement),
    );
    await ui.undo();
    await ui.waitSaved();
    const next = transport.mutations.findLast(
      (record) => record.endpoint === "treenode/create",
    )!.response.treenode_id;
    await real.saved(remap(rerooted, ids.Aroot, next));
    await ui.undo();
    await real.saved(remap(original, ids.Aroot, next));
    await real.visibleCurrentSegments();
    await real.reload(remap(original, ids.Aroot, next));
  });
});
