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

import { expect, type TestInfo } from "@playwright/test";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { Viewer } from "#src/viewer.js";
import {
  startCatmaidMockServer,
  type CatmaidMockServer,
} from "./catmaid_mock_server.js";
import { test } from "./fixtures.js";
import {
  readGraph,
  readQueue,
  SkeletonEditPage,
} from "./skeleton_edit_page.js";

async function withBackend(
  testInfo: TestInfo,
  run: (backend: CatmaidMockServer) => Promise<void>,
) {
  const backend = await startCatmaidMockServer();
  try {
    await run(backend);
    expect(backend.unknownRequests).toEqual([]);
    expect(backend.mutations.every((mutation) => mutation.status === 200)).toBe(
      true,
    );
    expect(backend.maxInFlightMutations).toBe(1);
  } finally {
    try {
      await testInfo.attach("catmaid-state-and-mutations", {
        body: Buffer.from(
          JSON.stringify(
            {
              nodes: backend.snapshot(),
              mutations: backend.mutations,
              unknownRequests: backend.unknownRequests,
              maxInFlightMutations: backend.maxInFlightMutations,
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
    } finally {
      await backend.close();
    }
  }
}

for (const trigger of ["description blur", "save acknowledgement"] as const) {
  test(`Delete survives a panel redraw from ${trigger} during a mouse press`, async ({
    page,
  }, testInfo) => {
    await withBackend(testInfo, async (backend) => {
      const ui = new SkeletonEditPage(page);
      await ui.open(backend.sourceUrl);
      const input = page.getByRole("textbox", {
        name: "Description",
        exact: true,
      });
      if (trigger === "description blur") {
        await ui.selectNode(102);
        await input.fill("saved before deleting");
      } else {
        const held = backend.holdNextMutation("node/update");
        await ui.move(102, 15, 15);
        await held.received;
        await input.focus();
        held.release();
        await ui.waitSaved();
        await expect(input).toBeFocused();
      }
      // A real press spans frames. Blur must save first without replacing the
      // pressed button before its click can submit Delete.
      await ui.runEdit(() =>
        page
          .locator(
            '.neuroglancer-selection-details-skeleton-action[title="Delete node"]',
          )
          .click({
            delay: 150,
          }),
      );
      await expect
        .poll(() => backend.mutations.map(({ path }) => path))
        .toEqual([
          trigger === "description blur"
            ? "label/treenode/102/update"
            : "node/update",
          "treenode/delete",
        ]);
      await ui.waitSaved();
      expect(await readGraph(page, [102])).toEqual([]);
      expect(backend.snapshot().some(({ id }) => id === 102)).toBe(false);
      expect(
        (await readQueue(page)).recent.map(({ status }) => status),
      ).toEqual(["saved", "saved"]);
    });
  });
}

test("Delete survives a Move acknowledgement during a press without a focused editor", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    const held = backend.holdNextMutation("node/update");
    await ui.move(102, 15, 15);
    await held.received;
    await expect(
      page.getByRole("textbox", { name: "Description", exact: true }),
    ).not.toBeFocused();
    const button = page.locator(
      '.neuroglancer-selection-details-skeleton-action[title="Delete node"]',
    );
    await ui.runEdit(async () => {
      await button.hover();
      await page.mouse.down();
      try {
        held.release();
        await ui.waitSaved();
        // Let the acknowledgement's queued redraw run before releasing Delete.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      } finally {
        await page.mouse.up();
      }
    });
    await ui.waitSaved();
    expect(backend.mutations.map(({ path }) => path)).toEqual([
      "node/update",
      "treenode/delete",
    ]);
    expect(await readGraph(page, [102])).toEqual([]);
    expect(backend.snapshot().some(({ id }) => id === 102)).toBe(false);
    expect((await readQueue(page)).recent.map(({ status }) => status)).toEqual([
      "saved",
      "saved",
    ]);
  });
});

test("Confidence keeps keyboard focus through a Move acknowledgement", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    const held = backend.holdNextMutation("node/update");
    await ui.move(102, 15, 15);
    await held.received;
    // Finish rendering the initial Move preview before entering Confidence.
    const redraw = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    await redraw();
    const radius = page.getByRole("spinbutton");
    const confidence = page.locator(
      "select.neuroglancer-selection-details-skeleton-properties-input",
    );
    await radius.focus();
    await radius.press("Tab");
    await expect(confidence).toBeFocused();
    const editor = await confidence.elementHandle();
    held.release();
    await ui.waitSaved();
    await redraw();
    expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(confidence).toBeFocused();
    await ui.runEdit(() => page.keyboard.press("ArrowUp"));
    await ui.waitSaved();
    expect((await readGraph(page, [102]))[0].confidence).toBe(75);
    expect(backend.snapshot().find(({ id }) => id === 102)?.confidence).toBe(4);
    expect(backend.mutations.map(({ path }) => path)).toEqual([
      "node/update",
      "treenodes/102/confidence",
    ]);
    expect((await readQueue(page)).recent.map(({ status }) => status)).toEqual([
      "saved",
      "saved",
    ]);
  });
});

test("Description can return to its original value while switching between property editors", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    await ui.selectNode(102);
    const [original] = await readGraph(page, [102]);
    const description = page.getByRole("textbox", {
      name: "Description",
      exact: true,
    });
    const radius = page.getByRole("spinbutton");
    const editor = await description.elementHandle();
    await ui.runEdit(async () => {
      await description.fill("Checked");
      // Keep the view alive in another protected editor across the save.
      await radius.click();
    });
    await ui.waitSaved();
    await expect(radius).toBeFocused();
    expect((await readGraph(page, [102]))[0].description).toBe("Checked");

    await ui.runEdit(async () => {
      await description.click();
      await description.fill(original.description ?? "");
      await radius.click();
    });
    await ui.waitSaved();
    expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
    expect((await readGraph(page, [102]))[0].description).toBe(
      original.description,
    );
    expect(backend.mutations.map(({ body }) => body.tags)).toEqual([
      "Checked",
      original.description,
    ]);

    // A third edit also becomes the comparison value for an unchanged blur.
    await ui.runEdit(async () => {
      await description.click();
      await description.fill("Checked again");
      await radius.click();
    });
    await ui.waitSaved();
    await description.click();
    await radius.click();
    expect((await readQueue(page)).entries).toHaveLength(3);
    expect(backend.mutations).toHaveLength(3);

    await ui.undo();
    await ui.waitSaved();
    expect((await readGraph(page, [102]))[0].description).toBe(
      original.description,
    );
    await ui.redo();
    await ui.waitSaved();
    expect((await readGraph(page, [102]))[0].description).toBe("Checked again");
  });
});

test("a rejected Radius can be retried while switching between property editors", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    await ui.selectNode(102);
    const [original] = await readGraph(page, [102]);
    const description = page.getByRole("textbox", {
      name: "Description",
      exact: true,
    });
    const radius = page.getByRole("spinbutton");
    const editor = await radius.elementHandle();
    const blocked = Promise.withResolvers<void>();
    const intercepted = Promise.withResolvers<void>();
    // Reject before applying the mutation, then let the retry reach the backend.
    await page.route(
      "**/treenode/102/radius",
      async (route) => {
        intercepted.resolve();
        await blocked.promise;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Radius rejected for recovery test" }),
        });
      },
      { times: 1 },
    );
    try {
      await ui.runEdit(async () => {
        await radius.fill("80");
        await description.click();
      });
      await intercepted.promise;
      await expect(description).toBeFocused();
      await expect(radius).toBeEnabled();
      expect((await readGraph(page, [102]))[0].radius).toBe(80);
    } finally {
      blocked.resolve();
    }
    await expect.poll(async () => (await readQueue(page)).pending).toBe(false);
    expect((await readGraph(page, [102]))[0].radius).toBe(original.radius);
    expect((await readQueue(page)).recent[0].status).toBe("not-saved");
    expect(backend.mutations).toHaveLength(0);

    await ui.runEdit(async () => {
      await radius.click();
      await radius.fill("81");
      await radius.fill("80");
      await description.click();
    });
    await ui.waitSaved();
    expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
    expect((await readGraph(page, [102]))[0].radius).toBe(80);
    expect(backend.snapshot().find(({ id }) => id === 102)?.radius).toBe(80);
    expect(backend.mutations.map(({ path }) => path)).toEqual([
      "treenode/102/radius",
    ]);
    expect((await readQueue(page)).recent.map(({ status }) => status)).toEqual([
      "saved",
      "not-saved",
    ]);
    await ui.undo();
    await ui.waitSaved();
    expect((await readGraph(page, [102]))[0].radius).toBe(original.radius);
  });
});

for (const field of ["Confidence", "True End"] as const) {
  test(`choosing the saved ${field} after rejection preserves Redo`, async ({
    page,
  }, testInfo) => {
    await withBackend(testInfo, async (backend) => {
      const ui = new SkeletonEditPage(page);
      await ui.open(backend.sourceUrl);
      await ui.selectNode(103);
      const [original] = await readGraph(page, [103]);
      const property = field === "Confidence" ? "confidence" : "isTrueEnd";
      const nextValue = field === "Confidence" ? 75 : true;
      const description = page.getByRole("textbox", {
        name: "Description",
        exact: true,
      });
      const radius = page.getByRole("spinbutton");
      const confidence = page.locator(
        "select.neuroglancer-selection-details-skeleton-properties-input",
      );
      const changeProperty = () =>
        field === "Confidence"
          ? confidence.press("ArrowUp")
          : page
              .getByRole("radio", { name: "Flag True end", exact: true })
              .check();
      const redraw = () =>
        page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
      await expect(
        page.getByRole("button", { name: "Nothing to undo.", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Nothing to redo.", exact: true }),
      ).toBeDisabled();
      await ui.runEdit(async () => {
        await description.fill("keep this Redo");
        await description.press("Tab");
      });
      await ui.waitSaved();
      await ui.undo();
      await ui.waitSaved();
      const redo = page.getByRole("button", {
        name: "Redo Edit node description",
        exact: true,
      });
      await expect(redo).toBeEnabled();

      const blocked = Promise.withResolvers<void>();
      const intercepted = Promise.withResolvers<void>();
      // Intercept before applying the request so recovery must preserve Redo.
      await page.route(
        field === "Confidence"
          ? "**/treenodes/103/confidence"
          : "**/label/treenode/103/update",
        async (route) => {
          intercepted.resolve();
          await blocked.promise;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: `${field} rejected for recovery test`,
            }),
          });
        },
        { times: 1 },
      );
      try {
        await ui.runEdit(changeProperty);
        await intercepted.promise;
        await expect(confidence).toBeEnabled();
        await radius.focus();
        await radius.press("Tab");
        await expect(confidence).toBeFocused();
        expect((await readGraph(page, [103]))[0][property]).toBe(nextValue);
      } finally {
        blocked.resolve();
      }
      await expect
        .poll(async () => (await readQueue(page)).pending)
        .toBe(false);
      await redraw();
      await expect(confidence).toBeFocused();
      expect((await readGraph(page, [103]))[0][property]).toBe(
        original[property],
      );
      expect((await readQueue(page)).canRedo).toBe(true);

      // Return the preserved control to the value rollback already restored.
      if (field === "Confidence") {
        await expect(confidence).toHaveValue("75");
        await confidence.press("ArrowDown");
      } else {
        await expect(
          page.getByRole("radio", { name: "Flag True end", exact: true }),
        ).toBeChecked();
        await page
          .getByRole("radio", { name: "Circle Virtual end", exact: true })
          .check();
      }
      await redraw();
      const queue = await readQueue(page);
      expect(queue.canRedo).toBe(true);
      expect(queue.entries).toHaveLength(3);
      expect(queue.recent.map(({ status }) => status)).toEqual([
        "not-saved",
        "saved",
        "saved",
      ]);
      expect(backend.mutations.map(({ path }) => path)).toEqual([
        "label/treenode/103/update",
        "label/treenode/103/update",
      ]);
      await expect(redo).toBeEnabled();
      await ui.redo();
      await ui.waitSaved();
      expect((await readGraph(page, [103]))[0].description).toBe(
        "keep this Redo",
      );

      // The previously rejected value remains a valid new edit and Undo target.
      await ui.runEdit(changeProperty);
      await ui.waitSaved();
      expect((await readGraph(page, [103]))[0][property]).toBe(nextValue);
      const saved = backend.snapshot().find(({ id }) => id === 103)!;
      if (field === "Confidence") expect(saved.confidence).toBe(4);
      else expect(saved.labels).toContain("ends");
      await ui.undo();
      await ui.waitSaved();
      expect((await readGraph(page, [103]))[0][property]).toBe(
        original[property],
      );
    });
  });
}

test("a rejected move cancels its child and preserves Undo of a saved description", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    await ui.selectNode(102);
    const [original] = await readGraph(page, [102]);
    await ui.runEdit(async () => {
      const description = page.getByRole("textbox", {
        name: "Description",
        exact: true,
      });
      await description.fill("checked");
      await description.press("Tab");
    });
    await ui.waitSaved();

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received!: () => void;
    const intercepted = new Promise<void>((resolve) => {
      received = resolve;
    });
    // Reject before forwarding: the mock's ordinary response hold applies the
    // mutation first and therefore cannot simulate a definitive rejection.
    await page.route(
      "**/node/update",
      async (route) => {
        received();
        await blocked;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Move rejected for recovery test" }),
        });
      },
      { times: 1 },
    );
    try {
      await ui.move(102, 24, 16);
      await intercepted;
      expect((await readGraph(page, [102]))[0].position).not.toEqual(
        original.position,
      );
      const center = await ui.panelCenter();
      await ui.runEdit(async () => {
        await page.keyboard.down("Shift");
        try {
          await page.mouse.click(center.x + 60, center.y + 40);
        } finally {
          await page.keyboard.up("Shift");
        }
      });
      await expect
        .poll(
          async () => (await readGraph(page, [102], "Skeletons", true)).length,
        )
        .toBe(4);
      expect(backend.mutations).toHaveLength(1);
    } finally {
      release();
    }
    await expect.poll(async () => (await readQueue(page)).pending).toBe(false);
    expect((await readGraph(page, [102]))[0]).toMatchObject({
      position: original.position,
      description: "checked",
    });
    expect(await readGraph(page, [102], "Skeletons", true)).toHaveLength(3);
    expect((await readQueue(page)).recent.map(({ status }) => status)).toEqual([
      "not-saved",
      "not-saved",
      "saved",
    ]);
    expect((await readQueue(page)).canUndo).toBe(true);
    expect((await readQueue(page)).canRedo).toBe(false);
    expect(backend.mutations).toHaveLength(1);
    await ui.showQueue();
    await expect(page.getByText("Not saved", { exact: true })).toHaveCount(2);
    await ui.showSkeleton();
    await ui.undo();
    await ui.waitSaved();
    expect((await readGraph(page, [102]))[0].description).toBe(
      original.description,
    );
    await ui.move(102, 12, 8);
    await ui.waitSaved();
    const [saved] = await readGraph(page, [102]);
    expect(saved.position).not.toEqual(original.position);
    expect(backend.mutations).toHaveLength(3);
    await page.reload();
    await ui.inspect(10);
    expect((await readGraph(page, [102]))[0]).toMatchObject({
      position: saved.position,
      description: original.description,
    });
  });
});

test("a move previews immediately and queued Undo cancels its write until Redo", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    const [originalA, originalB] = await readGraph(page, [102, 202]);
    const held = backend.holdNextMutation("node/update");
    await ui.move(102, 24, 16);
    await held.received;
    const [movedA] = await readGraph(page, [102]);
    expect(movedA.position).not.toEqual(originalA.position);
    expect((await readQueue(page)).pending).toBe(true);

    await ui.move(202, 18, 12);
    const [movedB] = await readGraph(page, [202]);
    expect(movedB.position).not.toEqual(originalB.position);
    expect(backend.mutations).toHaveLength(1);
    expect(backend.snapshot().find((node) => node.id === 202)).toMatchObject({
      x: originalB.position[0],
      y: originalB.position[1],
      z: originalB.position[2],
    });
    await ui.showQueue();
    await expect(page.getByText("Saving", { exact: true })).toBeVisible();
    await expect(page.getByText("Queued", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("move-and-queued-preview.png"),
    });
    await ui.showSkeleton();
    await ui.undo();
    await expect
      .poll(async () => (await readGraph(page, [202]))[0].position)
      .toEqual(originalB.position);
    expect(backend.mutations).toHaveLength(1);
    held.release();
    await expect.poll(async () => (await readQueue(page)).pending).toBe(false);
    expect(backend.mutations).toHaveLength(1);

    await ui.redo();
    await ui.waitSaved();
    await expect.poll(() => backend.mutations.length).toBe(2);
    expect((await readGraph(page, [202]))[0].position).toEqual(movedB.position);
    expect(backend.snapshot().find((node) => node.id === 102)).toMatchObject({
      x: movedA.position[0],
      y: movedA.position[1],
      z: movedA.position[2],
    });
    expect(backend.snapshot().find((node) => node.id === 202)).toMatchObject({
      x: movedB.position[0],
      y: movedB.position[1],
      z: movedB.position[2],
    });
    expect(
      backend.mutations.map((mutation) => mutation.body["t[0][0]"]),
    ).toEqual(["102", "202"]);
  });
});

test("Undo of a saving move previews its inverse and submits it after acknowledgement", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    const [original] = await readGraph(page, [102]);
    const held = backend.holdNextMutation("node/update");
    await ui.move(102, 30, 20);
    await held.received;
    const [moved] = await readGraph(page, [102]);
    expect(moved.position).not.toEqual(original.position);

    await ui.undo();
    await expect
      .poll(async () => (await readGraph(page, [102]))[0].position)
      .toEqual(original.position);
    expect((await readQueue(page)).pending).toBe(true);
    expect(backend.mutations).toHaveLength(1);
    expect(backend.snapshot().find((node) => node.id === 102)).toMatchObject({
      x: moved.position[0],
      y: moved.position[1],
      z: moved.position[2],
    });
    held.release();
    await ui.waitSaved();
    expect(backend.mutations).toHaveLength(2);
    expect(backend.snapshot().find((node) => node.id === 102)).toMatchObject({
      x: original.position[0],
      y: original.position[1],
      z: original.position[2],
    });
    await ui.redo();
    await ui.waitSaved();
    expect(backend.mutations).toHaveLength(3);
    expect((await readGraph(page, [102]))[0].position).toEqual(moved.position);
    expect(backend.mutations.map((mutation) => mutation.path)).toEqual([
      "node/update",
      "node/update",
      "node/update",
    ]);
  });
});

for (const field of ["radius", "confidence", "description"] as const) {
  test(`${field} edit, Undo, and Redo preserve the final value after reload`, async ({
    page,
  }, testInfo) => {
    await withBackend(testInfo, async (backend) => {
      const ui = new SkeletonEditPage(page);
      await ui.open(backend.sourceUrl);
      await ui.selectNode(102);
      const [original] = await readGraph(page, [102]);
      const nextValue =
        field === "radius"
          ? 80
          : field === "confidence"
            ? 75
            : "Browser queue QA";
      const path =
        field === "radius"
          ? "treenode/102/radius"
          : field === "confidence"
            ? "treenodes/102/confidence"
            : "label/treenode/102/update";
      const held = backend.holdNextMutation(path);
      if (field === "radius") {
        await ui.radius(102, Number(nextValue));
      } else {
        await ui.runEdit(async () => {
          if (field === "confidence") {
            await page
              .locator(
                "select.neuroglancer-selection-details-skeleton-properties-input",
              )
              .selectOption(String(nextValue));
          } else {
            await page
              .getByRole("textbox", { name: "Description", exact: true })
              .fill(String(nextValue));
            await page
              .getByRole("textbox", { name: "Description", exact: true })
              .press("Tab");
          }
        });
      }
      await held.received;
      await expect
        .poll(async () => (await readGraph(page, [102]))[0][field])
        .toBe(nextValue);
      expect((await readQueue(page)).pending).toBe(true);
      held.release();
      await ui.waitSaved();
      expect(backend.mutations).toHaveLength(1);

      await ui.undo();
      await ui.waitSaved();
      await expect
        .poll(async () => (await readGraph(page, [102]))[0][field])
        .toBe(original[field]);
      expect(backend.mutations).toHaveLength(2);
      await ui.redo();
      await ui.waitSaved();
      await expect
        .poll(async () => (await readGraph(page, [102]))[0][field])
        .toBe(nextValue);
      expect(backend.mutations).toHaveLength(3);

      await page.reload();
      await ui.inspect(10);
      await expect
        .poll(async () => (await readGraph(page, [102]))[0][field])
        .toBe(nextValue);
      expect((await readQueue(page)).canUndo).toBe(false);
      expect((await readQueue(page)).canRedo).toBe(false);
    });
  });
}

test("true-end labels survive Undo, Redo, and a fresh inspection", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    await ui.selectNode(103);
    await ui.runEdit(() =>
      page.getByRole("radio", { name: "Flag True end", exact: true }).check(),
    );
    await expect
      .poll(async () => (await readGraph(page, [103]))[0].isTrueEnd)
      .toBe(true);
    await ui.waitSaved();
    expect(backend.mutations).toHaveLength(1);
    await ui.undo();
    await ui.waitSaved();
    expect((await readGraph(page, [103]))[0].isTrueEnd).toBe(false);
    expect(backend.mutations).toHaveLength(2);
    await ui.redo();
    await ui.waitSaved();
    expect((await readGraph(page, [103]))[0].isTrueEnd).toBe(true);
    expect(backend.mutations).toHaveLength(3);
    await page.reload();
    await ui.inspect(10);
    expect((await readGraph(page, [103]))[0].isTrueEnd).toBe(true);
    expect(
      backend.snapshot().find((node) => node.id === 103)?.labels,
    ).toContain("ends");
  });
});

test("deleting a leaf restores its parent and position under a fresh ID on Undo", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    await ui.selectNode(103);
    const [original] = await readGraph(page, [103]);
    const held = backend.holdNextMutation("treenode/delete");
    await ui.runEdit(() =>
      page
        .locator(
          '.neuroglancer-selection-details-skeleton-action[title="Delete node"]',
        )
        .click(),
    );
    await held.received;
    expect(await readGraph(page, [103])).toEqual([]);
    held.release();
    await ui.waitSaved();
    expect(backend.mutations).toHaveLength(1);
    await ui.undo();
    await ui.waitSaved();
    const restored = backend.snapshot().find((node) => node.id > 1000)!;
    expect(restored).toMatchObject({
      parentId: original.parentId,
      skeletonId: original.skeletonId,
      x: original.position[0],
      y: original.position[1],
      z: original.position[2],
    });
    expect((await readGraph(page, [restored.id]))[0]).toMatchObject({
      id: restored.id,
      parentId: original.parentId,
      skeletonId: original.skeletonId,
      position: original.position,
    });
    expect(backend.snapshot()).toHaveLength(6);
    expect(backend.mutations.map((mutation) => mutation.path)).toEqual([
      "treenode/delete",
      "treenode/create",
      "treenode/1001/radius",
      "treenodes/1001/confidence",
    ]);
    expect(restored.radius).toBe(original.radius);
    expect(restored.confidence).toBe(5);
    expect((await readGraph(page, [restored.id]))[0]).toMatchObject({
      radius: original.radius,
      confidence: original.confidence,
    });
    await ui.redo();
    await ui.waitSaved();
    expect(backend.mutations).toHaveLength(5);
    expect(backend.mutations[4].body.treenode_id).toBe(String(restored.id));
    expect(backend.snapshot()).toHaveLength(5);
    expect(await readGraph(page, [103, restored.id])).toEqual([]);
  });
});

test("two layers preview independently while mutations share one FIFO", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const first = new SkeletonEditPage(page);
    const second = new SkeletonEditPage(page, "Second");
    await first.open(backend.sourceUrl, [10, 20], true);
    await second.inspect(20);
    const held = backend.holdNextMutation("treenode/101/radius");
    await first.radius(101, 80);
    await held.received;
    await second.radius(201, 120);
    expect((await readGraph(page, [101]))[0].radius).toBe(80);
    expect((await readGraph(page, [201], "Second"))[0].radius).toBe(120);
    expect((await readQueue(page)).pending).toBe(true);
    expect((await readQueue(page, "Second")).pending).toBe(true);
    expect(backend.mutations).toHaveLength(1);
    expect(backend.snapshot().find((node) => node.id === 201)?.radius).toBe(40);
    await second.showQueue();
    await expect(page.getByText("Queued", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("second-layer-queued.png"),
    });
    held.release();
    await Promise.all([first.waitSaved(), second.waitSaved()]);
    expect(backend.mutations.map((mutation) => mutation.path)).toEqual([
      "treenode/101/radius",
      "treenode/201/radius",
    ]);
    expect(backend.mutations[1].startedAt).toBeGreaterThanOrEqual(
      backend.mutations[0].completedAt!,
    );
    expect(backend.snapshot().find((node) => node.id === 101)?.radius).toBe(80);
    expect(backend.snapshot().find((node) => node.id === 201)?.radius).toBe(
      120,
    );
  });
});

test("a new root and pending child chain survive full Undo and Redo with fresh IDs", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    const center = await ui.panelCenter();
    const selectedNode = async () => {
      const id = await page.evaluate(() => {
        const viewer = (window as unknown as { viewer: Viewer }).viewer;
        const layer = viewer.layerManager.getLayerByName("Skeletons")!
          .layer as SegmentationUserLayer;
        return layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
      });
      expect(id).toBeDefined();
      const [node] = await readGraph(page, [id!]);
      expect(node).toBeDefined();
      return node;
    };
    const held = backend.holdNextMutation("treenode/create");
    await page.mouse.move(center.x, center.y);
    await ui.runEdit(async () => {
      await page.keyboard.down("n");
      try {
        await page.mouse.click(center.x, center.y);
      } finally {
        await page.keyboard.up("n");
      }
    });
    await held.received;
    const previewRoot = await selectedNode();
    expect(previewRoot.parentId).toBeNull();
    expect([10, 20]).not.toContain(previewRoot.skeletonId);
    const childPoint = { x: center.x + 40, y: center.y + 30 };
    await ui.runEdit(async () => {
      await page.keyboard.down("Shift");
      try {
        await page.mouse.click(childPoint.x, childPoint.y);
      } finally {
        await page.keyboard.up("Shift");
      }
    });
    const previewChild = await selectedNode();
    expect(previewChild.parentId).toBe(previewRoot.id);
    expect(previewChild.skeletonId).toBe(previewRoot.skeletonId);
    expect(backend.mutations).toHaveLength(1);
    // Adding a child centers the camera and opens its selection details.
    const childCenter = await ui.panelCenter();
    await page.mouse.move(childCenter.x, childCenter.y);
    await ui.runEdit(async () => {
      await page.mouse.down();
      await page.mouse.move(childCenter.x + 25, childCenter.y + 15, {
        steps: 4,
      });
      await page.mouse.up();
    });
    const movedPreviewChild = await selectedNode();
    expect(movedPreviewChild.position).not.toEqual(previewChild.position);
    expect(movedPreviewChild.parentId).toBe(previewRoot.id);
    expect(backend.mutations).toHaveLength(1);
    await page.screenshot({
      path: testInfo.outputPath("root-child-chain-preview.png"),
    });
    held.release();
    await ui.waitSaved();
    expect(backend.mutations.map((mutation) => mutation.path)).toEqual([
      "treenode/create",
      "treenode/create",
      "node/update",
    ]);
    const originalRoot = backend.snapshot().find((node) => node.id === 1001)!;
    const originalChild = backend.snapshot().find((node) => node.id === 1002)!;
    expect(originalRoot.parentId).toBeNull();
    expect(originalChild.parentId).toBe(originalRoot.id);
    expect(backend.mutations[1].body.parent_id).toBe(String(originalRoot.id));
    expect(backend.mutations[2].body["t[0][0]"]).toBe(String(originalChild.id));
    expect((await readGraph(page, [originalChild.id]))[0].position).toEqual(
      movedPreviewChild.position,
    );
    expect(await readGraph(page, [previewRoot.id, previewChild.id])).toEqual(
      [],
    );

    for (let step = 0; step < 3; ++step) {
      await ui.undo();
      await ui.waitSaved();
    }
    expect(backend.mutations).toHaveLength(6);
    expect(backend.snapshot()).toHaveLength(6);
    expect(await readGraph(page, [originalRoot.id, originalChild.id])).toEqual(
      [],
    );
    for (let step = 0; step < 3; ++step) {
      await ui.redo();
      await ui.waitSaved();
    }
    expect(backend.mutations).toHaveLength(9);
    const restoredRoot = backend.snapshot().find((node) => node.id === 1003)!;
    const restoredChild = backend.snapshot().find((node) => node.id === 1004)!;
    expect(restoredRoot).toMatchObject({
      parentId: null,
      x: originalRoot.x,
      y: originalRoot.y,
      z: originalRoot.z,
    });
    expect(restoredRoot.skeletonId).not.toBe(originalRoot.skeletonId);
    expect(restoredChild).toMatchObject({
      parentId: restoredRoot.id,
      skeletonId: restoredRoot.skeletonId,
      x: originalChild.x,
      y: originalChild.y,
      z: originalChild.z,
    });
    expect(backend.mutations[7].body.parent_id).toBe(String(restoredRoot.id));
    expect(backend.mutations[8].body["t[0][0]"]).toBe(String(restoredChild.id));
    expect(backend.snapshot()).toHaveLength(8);
    expect((await readGraph(page, [restoredChild.id]))[0]).toMatchObject({
      parentId: restoredRoot.id,
      skeletonId: restoredRoot.skeletonId,
      position: movedPreviewChild.position,
    });
  });
});

test("inserting a node previews the edge and persists through Undo, Redo, and reload", async ({
  page,
}, testInfo) => {
  await withBackend(testInfo, async (backend) => {
    const ui = new SkeletonEditPage(page);
    await ui.open(backend.sourceUrl);
    await ui.selectNode(101);
    const [parent, child] = await readGraph(page, [101, 102]);
    const center = await ui.panelCenter();
    const scale = await page.evaluate(
      () =>
        (window as unknown as { viewer: Viewer }).viewer.crossSectionScale
          .value,
    );
    const held = backend.holdNextMutation("treenode/insert");
    await page.mouse.move(center.x, center.y);
    await ui.runEdit(async () => {
      await page.keyboard.down("i");
      try {
        await page.mouse.click(center.x, center.y);
        await page.mouse.click(
          center.x + (child.position[0] - parent.position[0]) / scale,
          center.y + (child.position[1] - parent.position[1]) / scale,
        );
      } finally {
        await page.keyboard.up("i");
      }
    });
    await held.received;
    const provisional = (await readGraph(page, [101], ui.layerName, true)).find(
      (node) => node.id >= 1_000_000_000,
    )!;
    expect(provisional.parentId).toBe(101);
    expect((await readGraph(page, [102]))[0].parentId).toBe(provisional.id);
    held.release();
    await ui.waitSaved();
    const inserted = backend
      .snapshot()
      .find(
        (node) =>
          node.id !== 101 &&
          node.id !== 102 &&
          node.parentId === 101 &&
          backend.snapshot().find((child) => child.id === 102)?.parentId ===
            node.id,
      )!;
    expect(inserted).toBeDefined();
    await ui.undo();
    await ui.waitSaved();
    expect(backend.snapshot().find((node) => node.id === 102)?.parentId).toBe(
      101,
    );
    await ui.redo();
    await ui.waitSaved();
    const replacementId = backend
      .snapshot()
      .find((node) => node.id === 102)!.parentId!;
    expect(replacementId).not.toBe(inserted.id);
    await page.reload();
    await ui.inspect(parent.skeletonId);
    expect((await readGraph(page, [102]))[0].parentId).toBe(replacementId);
  });
});
