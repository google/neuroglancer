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
import { test, change } from "./real_test.js";
import { readQueue } from "./skeleton_edit_page.js";

for (const [number, operation, preset] of [
  [23, "Split", "branch"],
  [24, "Merge", "branchPair"],
] as const) {
  test.describe(`pending ${operation} dependencies`, () => {
    test.use({ preset });
    test(`[E2E-${number}] edits queued behind pending ${operation} preserve topology and history through ID changes`, async ({
      real,
    }) => {
      const { ui, ids, original, transport } = real;
      await real.open();
      const endpoint =
        operation === "Split" ? "skeleton/split" : "skeleton/join";
      const topology =
        operation === "Split"
          ? change(original, ids.Amiddle, { parentId: null })
          : change(
              change(
                change(original, ids.Bside, { parentId: ids.Aside }),
                ids.Bmiddle,
                { parentId: ids.Bside },
              ),
              ids.Broot,
              { parentId: ids.Bmiddle },
            );
      const movedId = operation === "Split" ? ids.Aside : ids.Bside;
      const radiusId = operation === "Split" ? ids.Atip : ids.Btip;
      const initialSegment = real.api.initial.find(
        (node) => node.id === movedId,
      )!.skeletonId;
      const forward = transport.hold(endpoint);
      if (operation === "Split") await ui.split(ids.Amiddle);
      else await ui.merge(ids.Aside, ids.Bside);
      const structuralRequest = await forward.reached;
      await real.pending(topology);

      const moved = await real.moved(topology, movedId, 15, -10);
      await ui.radius(radiusId, 175);
      const edited = change(moved, radiusId, { radius: 175 });
      await real.pending(edited);
      expect(
        (await readQueue(ui.page)).entries.filter(
          (entry) => entry.lifecycle.authority === "queued",
        ),
      ).toHaveLength(2);
      expect(transport.mutations).toHaveLength(1);
      await real.persisted(original, false);

      const moveGate = transport.hold("node/update");
      forward.release();
      const moveRequest = await moveGate.reached;
      expect(moveRequest.forwarded).toBeUndefined();
      expect(structuralRequest.acknowledged).toBeDefined();
      expect(moveRequest.body["t[0][0]"]).toBe(String(movedId));
      await real.pending(edited);
      await real.persisted(topology, false);
      moveGate.release();
      const saved = await real.saved(edited);
      const savedSegment = saved.find(
        (node) => node.id === movedId,
      )!.skeletonId;
      expect(savedSegment).not.toBe(initialSegment);
      expect((await ui.selected()).skeletonId).toBe(savedSegment);
      expect(transport.mutations.map((record) => record.endpoint)).toEqual([
        endpoint,
        "node/update",
        `treenode/${radiusId}/radius`,
      ]);
      expect(moveRequest.forwarded).toBeGreaterThan(
        structuralRequest.acknowledged!,
      );
      await real.visibleCurrentSegments();

      // Undo the property and move first, then restore the complete original trees.
      for (const expected of [moved, topology, original]) {
        await ui.undo();
        await real.saved(expected);
      }
      await real.visibleCurrentSegments();
      for (const expected of [topology, moved, edited]) {
        await ui.redo();
        await real.saved(expected);
      }
      const redone = await real.persisted(edited);
      const redoneSegment = redone.find(
        (node) => node.id === movedId,
      )!.skeletonId;
      if (operation === "Split") expect(redoneSegment).not.toBe(savedSegment);
      expect(
        transport.mutations
          .filter((record) => record.endpoint === "node/update")
          .map((record) => record.body["t[0][0]"]),
      ).toEqual(Array(3).fill(String(movedId)));
      expect(
        transport.mutations.filter(
          (record) => record.endpoint === `treenode/${radiusId}/radius`,
        ),
      ).toHaveLength(3);
      await real.visibleCurrentSegments();
      await real.reload(edited);
    });
  });
}
