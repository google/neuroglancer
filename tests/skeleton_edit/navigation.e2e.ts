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
import type { Viewer } from "#src/viewer.js";
import { test, change, type RealSkeletonPage } from "./real_test.js";

test.use({ preset: "branch" });

async function expectListedNodes(ui: RealSkeletonPage, ids: number[]) {
  await expect
    .poll(async () =>
      (
        await ui.page
          .locator(
            ".neuroglancer-skeleton-tree-row[data-node-type] .neuroglancer-skeleton-node-id",
          )
          .allTextContents()
      )
        .map(Number)
        .sort((a, b) => a - b),
    )
    .toEqual([...ids].sort((a, b) => a - b));
}

async function filter(
  ui: RealSkeletonPage,
  label: string,
  ids: number[],
  query = "",
) {
  await ui.page
    .getByRole("textbox", { name: "Enter node ID or description" })
    .fill(query);
  await ui.page
    .getByRole("combobox", { name: "Filter loaded nodes by node type" })
    .selectOption({ label });
  await expectListedNodes(ui, ids);
}

async function navigate(ui: RealSkeletonPage, action: string, id: number) {
  await ui.page
    .getByRole("button", { name: new RegExp(`^Go to ${action}`) })
    .click();
  await expect.poll(async () => (await ui.selected()).id).toBe(id);
  const node = await ui.selected();
  await expect
    .poll(() =>
      ui.page.evaluate(() =>
        Array.from(
          (window as unknown as { viewer: Viewer }).viewer.position.value,
        ),
      ),
    )
    .toEqual(node.position);
}

async function expectRootRow(ui: RealSkeletonPage, id: number) {
  await expect(
    ui.page.locator(
      '.neuroglancer-skeleton-tree-row[data-node-type="root"] .neuroglancer-skeleton-node-id',
    ),
  ).toHaveText(String(id));
}

test("[E2E-25] navigation and filters follow pending Split partitions through Undo/Redo and reload", async ({
  real,
}) => {
  const { ui, ids, original, transport } = real;
  await real.open();
  const originalNavigation = async () => {
    await ui.selectNode(ids.Atip);
    await navigate(ui, "start of branch", ids.Amiddle);
    await navigate(ui, "root", ids.Aroot);
    await filter(ui, "Default", [
      ids.Aroot,
      ids.Amiddle,
      ids.Aleaf,
      ids.Atip,
      ids.Asibling,
    ]);
    await expectRootRow(ui, ids.Aroot);
  };
  const splitNavigation = async () => {
    await ui.selectNode(ids.Atip);
    await navigate(ui, "parent", ids.Aside);
    await navigate(ui, "root", ids.Aside);
    await navigate(ui, "end of branch", ids.Atip);
    await filter(ui, "Default", [ids.Aside, ids.Atip]);
    await expectRootRow(ui, ids.Aside);
    await ui.selectNode(ids.Aleaf);
    await navigate(ui, "start of branch", ids.Aroot);
    await filter(ui, "Default", [ids.Aroot, ids.Aleaf, ids.Asibling]);
    await expectRootRow(ui, ids.Aroot);
    await filter(ui, "Leaf", [ids.Aleaf, ids.Asibling]);
    await ui.selectNode(ids.Amiddle);
    await navigate(ui, "child", ids.Aleaf);
  };
  await originalNavigation();
  const split = change(original, ids.Aside, { parentId: null });
  const gate = transport.hold("skeleton/split");
  await ui.split(ids.Aside);
  await gate.reached;
  await real.pending(split);
  await splitNavigation();
  await real.persisted(original, false);
  expect(transport.mutations).toHaveLength(1);
  gate.release();
  await real.saved(split);
  await splitNavigation();
  await ui.undo();
  await real.saved(original);
  await originalNavigation();
  await ui.redo();
  await real.saved(split);
  await splitNavigation();
  await real.visibleCurrentSegments();
  await real.reload(split);
  await splitNavigation();
  expect(transport.mutations.map((record) => record.endpoint)).toEqual([
    "skeleton/split",
    "skeleton/join",
    "skeleton/split",
  ]);
});

test("[E2E-26] navigation and collapsed-node filters follow pending reroot through Undo/Redo and reload", async ({
  real,
}) => {
  const { ui, ids, original, transport } = real;
  await real.open();
  const originalNavigation = async () => {
    await ui.selectNode(ids.Asibling);
    await navigate(ui, "start of branch", ids.Aroot);
    await filter(ui, "Default", [
      ids.Aroot,
      ids.Amiddle,
      ids.Aleaf,
      ids.Atip,
      ids.Asibling,
    ]);
    await expectRootRow(ui, ids.Aroot);
  };
  const rerootedNavigation = async () => {
    await ui.selectNode(ids.Aroot);
    await navigate(ui, "parent", ids.Amiddle);
    await navigate(ui, "root", ids.Aside);
    await ui.selectNode(ids.Asibling);
    await navigate(ui, "start of branch", ids.Amiddle);
    await ui.selectNode(ids.Aroot);
    await navigate(ui, "child", ids.Asibling);
    await filter(ui, "Default", [
      ids.Aside,
      ids.Amiddle,
      ids.Aleaf,
      ids.Atip,
      ids.Asibling,
    ]);
    await expectRootRow(ui, ids.Aside);
  };
  await originalNavigation();
  const rerooted = change(
    change(change(original, ids.Aside, { parentId: null }), ids.Amiddle, {
      parentId: ids.Aside,
    }),
    ids.Aroot,
    { parentId: ids.Amiddle },
  );
  const gate = transport.hold("skeleton/reroot");
  await ui.reroot(ids.Aside);
  await gate.reached;
  await real.pending(rerooted);
  await rerootedNavigation();
  await real.persisted(original, false);
  expect(transport.mutations).toHaveLength(1);
  gate.release();
  await real.saved(rerooted);
  await rerootedNavigation();
  await ui.undo();
  await real.saved(original);
  await originalNavigation();
  await ui.redo();
  await real.saved(rerooted);
  await rerootedNavigation();
  await real.reload(rerooted);
  await rerootedNavigation();
  expect(transport.mutations.map((record) => record.endpoint)).toEqual(
    Array(3).fill("skeleton/reroot"),
  );
});

test("[E2E-27] description and true-end filters react to pending properties and their inverses", async ({
  real,
}) => {
  const { ui, ids, original, transport } = real;
  await real.open();
  await ui.selectNode(ids.Atip);
  await filter(ui, "Has description", []);
  const description = "Pending, Δ branch";
  const described = change(original, ids.Atip, { description });
  const descriptionGate = transport.hold(`label/treenode/${ids.Atip}/update`);
  const input = ui.page.getByRole("textbox", {
    name: "Description",
    exact: true,
  });
  await ui.runEdit(async () => {
    await input.fill(description);
    await input.press("Tab");
  });
  await descriptionGate.reached;
  await expectListedNodes(ui, [ids.Atip]);
  await filter(ui, "Has description", [ids.Atip], "Δ BRANCH");
  await filter(ui, "Has description", [], "not present");
  await filter(ui, "Has description", [ids.Atip]);
  await real.pending(described);
  await real.persisted(original, false);
  descriptionGate.release();
  await real.saved(described);
  const undoDescription = transport.hold(`label/treenode/${ids.Atip}/update`);
  await ui.undo();
  await undoDescription.reached;
  await expectListedNodes(ui, []);
  await real.pending(original);
  await real.persisted(described, false);
  undoDescription.release();
  await real.saved(original);
  await ui.redo();
  await real.saved(described);
  await expectListedNodes(ui, [ids.Atip]);

  await filter(ui, "Virtual end", [ids.Aleaf, ids.Atip, ids.Asibling]);
  const ended = change(described, ids.Atip, { isTrueEnd: true });
  const endGate = transport.hold(`label/treenode/${ids.Atip}/update`);
  await ui.runEdit(() =>
    ui.page.getByRole("radio", { name: "Flag True end", exact: true }).check(),
  );
  await endGate.reached;
  await expectListedNodes(ui, [ids.Aleaf, ids.Asibling]);
  await filter(ui, "True end", [ids.Atip]);
  await filter(ui, "Leaf", [ids.Aleaf, ids.Atip, ids.Asibling]);
  await filter(ui, "Has description", [ids.Atip]);
  await filter(ui, "True end", [ids.Atip]);
  await real.pending(ended);
  await real.persisted(described, false);
  endGate.release();
  await real.saved(ended);
  const undoEnd = transport.hold(`label/treenode/${ids.Atip}/remove`);
  await ui.undo();
  await undoEnd.reached;
  await expectListedNodes(ui, []);
  await filter(ui, "Virtual end", [ids.Aleaf, ids.Atip, ids.Asibling]);
  await real.pending(described);
  await real.persisted(ended, false);
  undoEnd.release();
  await real.saved(described);
  await ui.redo();
  await real.saved(ended);
  await expectListedNodes(ui, [ids.Aleaf, ids.Asibling]);
  await real.reload(ended);
  await filter(ui, "True end", [ids.Atip]);
  await filter(ui, "Has description", [ids.Atip], "Δ branch");
  expect(transport.mutations).toHaveLength(6);
});
