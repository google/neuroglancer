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
import { test, change, remap } from "./real_test.js";
import { readQueue } from "./skeleton_edit_page.js";

test("[E2E-19] Undo cancels an undispatched edit and Redo saves it once", async ({
  real,
}) => {
  const { ui, ids, original, transport } = real;
  await real.open();
  const gate = transport.hold(`treenode/${ids.Aroot}/radius`);
  await ui.radius(ids.Aroot, 180);
  await gate.reached;
  const first = change(original, ids.Aroot, { radius: 180 });
  await ui.radius(ids.Amiddle, 160);
  const second = change(first, ids.Amiddle, { radius: 160 });
  await real.pending(second);
  await ui.undo();
  await real.pending(first);
  expect(transport.mutations).toHaveLength(1);
  await real.persisted(original, false);
  gate.release();
  await expect.poll(async () => (await readQueue(ui.page)).pending).toBe(false);
  await real.persisted(first);
  expect(transport.mutations).toHaveLength(1);
  await ui.redo();
  await real.saved(second);
  expect(transport.mutations.map((record) => record.endpoint)).toEqual([
    `treenode/${ids.Aroot}/radius`,
    `treenode/${ids.Amiddle}/radius`,
  ]);
  await real.reload(second);
});

for (const [number, operation] of [
  [20, "move"],
  [21, "Split"],
] as const) {
  test(`[E2E-${number}] Undo while ${operation} is Saving previews the inverse before acknowledgement`, async ({
    real,
  }, testInfo) => {
    const { ui, ids, original, transport } = real;
    await real.open();
    const forward = transport.hold(
      operation === "move" ? "node/update" : "skeleton/split",
      "afterResponse",
    );
    const edited =
      operation === "move"
        ? await real.moved(original, ids.Amiddle)
        : change(original, ids.Amiddle, { parentId: null });
    if (operation === "Split") await ui.split(ids.Amiddle);
    const request = await forward.reached;
    await real.pending(edited);
    await real.persisted(edited, false);
    const inverse = transport.hold(
      operation === "move" ? "node/update" : "skeleton/join",
    );
    await ui.undo();
    await real.pending(original);
    expect(transport.mutations).toHaveLength(1);
    await ui.showQueue();
    await expect(ui.page.getByText("Queued", { exact: true })).toBeVisible();
    await ui.page.screenshot({
      path: testInfo.outputPath("undo-before-forward-ack.png"),
    });
    await ui.showSkeleton();
    forward.release();
    const inverseRequest = await inverse.reached;
    expect(request.acknowledged).toBeDefined();
    expect(inverseRequest.forwarded).toBeUndefined();
    await real.pending(original);
    await real.persisted(edited, false);
    inverse.release();
    await real.saved(original);
    expect(inverseRequest.forwarded).toBeGreaterThan(request.acknowledged!);
    await ui.redo();
    await real.saved(edited);
    await real.reload(edited);
  });
}

test("[E2E-22] mixed history remains LIFO across replacement IDs and clears the redo branch", async ({
  real,
}) => {
  const { ui, ids, original, transport } = real;
  await real.open();
  const resized = change(original, ids.Aleaf, { radius: 175 });
  await ui.radius(ids.Aleaf, 175);
  await real.saved(resized);
  const split = change(resized, ids.Amiddle, { parentId: null });
  await ui.split(ids.Amiddle);
  await real.saved(split);
  const deleted = split.filter((node) => node.id !== ids.Aleaf);
  await ui.deleteNode(ids.Aleaf);
  await real.saved(deleted);
  // Undo Delete creates a replacement node. Older Split and Radius history must
  // keep following that logical node through the backend identity change.
  await ui.undo();
  await ui.waitSaved();
  const replacement = transport.mutations.findLast(
    (record) => record.endpoint === "treenode/create",
  )!.response.treenode_id;
  expect(replacement).not.toBe(ids.Aleaf);
  const splitRestored = remap(split, ids.Aleaf, replacement);
  const resizedRestored = remap(resized, ids.Aleaf, replacement);
  const originalRestored = remap(original, ids.Aleaf, replacement);
  await real.saved(splitRestored);
  await ui.undo();
  await real.saved(resizedRestored);
  await ui.undo();
  await real.saved(originalRestored);
  await ui.redo();
  await real.saved(resizedRestored);
  await ui.redo();
  await real.saved(splitRestored);
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
  const restored = remap(split, ids.Aleaf, next);
  await real.persisted(restored);
  expect((await readQueue(ui.page)).canRedo).toBe(true);
  await ui.description(next, "new history branch");
  const branched = change(restored, next, {
    description: "new history branch",
  });
  await real.saved(branched);
  expect((await readQueue(ui.page)).canRedo).toBe(false);
  await expect(
    ui.page.getByRole("button", { name: "Nothing to redo.", exact: true }),
  ).toBeDisabled();
  await real.reload(branched);
});
