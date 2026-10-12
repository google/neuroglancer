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

const SEGMENT_INPUT =
  "enter→toggle-listed, shift+enter→hide-listed, control+enter→hide-all, escape→cancel";

export interface GraphNode {
  id: number;
  parentId: number | null;
  skeletonId: number;
  position: number[];
  radius?: number;
  confidence?: number;
  description?: string;
  isTrueEnd?: boolean;
}

/** All edits use the UI. This helper only reads the existing public viewer state. */
export async function readGraph(
  page: Page,
  ids: number[],
  layerName = "Skeletons",
  completeComponents = false,
) {
  return page.evaluate(
    ({ ids, layerName, completeComponents }) => {
      const viewer = (window as unknown as { viewer: Viewer }).viewer;
      const layer = viewer?.layerManager.getLayerByName(layerName)?.layer as
        | SegmentationUserLayer
        | undefined;
      if (!layer) return [];
      const seedNodes = ids.flatMap((id) => {
        const node = layer.spatialSkeletonState.getCachedNode(id);
        return node ? [node] : [];
      });
      const nodes = completeComponents
        ? [...new Set(seedNodes.map((node) => node.segmentId))].flatMap(
            (id) => layer.spatialSkeletonState.getCachedSegmentNodes(id) ?? [],
          )
        : seedNodes;
      return nodes
        .flatMap((node) => {
          return node
            ? [
                {
                  id: node.nodeId,
                  parentId: node.parentNodeId ?? null,
                  skeletonId: node.segmentId,
                  position: Array.from(node.position),
                  radius: node.radius,
                  confidence: node.confidence,
                  description: node.description ?? "",
                  isTrueEnd: node.isTrueEnd ?? false,
                },
              ]
            : [];
        })
        .sort((a, b) => a.id - b.id);
    },
    { ids, layerName, completeComponents },
  );
}

/** Reads the chunks published by the normal renderer, without triggering a draw. */
export async function readRenderedNodeIds(page: Page, layerName = "Skeletons") {
  return page.evaluate((layerName) => {
    const viewer = (window as unknown as { viewer: Viewer }).viewer;
    const layer = viewer.layerManager.getLayerByName(layerName)!
      .layer as SegmentationUserLayer;
    const renderer = layer.getSpatiallyIndexedSkeletonLayer() as unknown as {
      overlayRenderChunks: readonly { pickNodeIds: Int32Array }[];
    };
    return renderer.overlayRenderChunks
      .flatMap(({ pickNodeIds }) => Array.from(pickNodeIds, (id) => id >>> 0))
      .sort((a, b) => a - b);
  }, layerName);
}

export async function readQueue(page: Page, layerName = "Skeletons") {
  return page.evaluate((layerName) => {
    const viewer = (window as unknown as { viewer: Viewer }).viewer;
    const layer = viewer.layerManager.getLayerByName(layerName)
      ?.layer as SegmentationUserLayer;
    return {
      entries: layer.spatialSkeletonState.getOptimisticEditQueueSnapshot(),
      pending: layer.spatialSkeletonState.hasUnconfirmedOptimisticEdits(),
      recent: layer.spatialSkeletonState.getOptimisticEditQueueRecentActivity(),
      canUndo: layer.spatialSkeletonState.commandHistory.canUndo.value,
      canRedo: layer.spatialSkeletonState.commandHistory.canRedo.value,
    };
  }, layerName);
}

export function parentMap(nodes: GraphNode[]) {
  return nodes.map(({ id, parentId }) => [id, parentId]);
}

export class SkeletonEditPage {
  constructor(
    readonly page: Page,
    readonly layerName = "Skeletons",
  ) {}
  private lastOperationId: number | undefined;

  async runEdit(action: () => Promise<void>) {
    const before = Math.max(
      0,
      ...(await readQueue(this.page, this.layerName)).entries.map(
        (entry) => entry.operationId ?? 0,
      ),
    );
    await action();
    await expect
      .poll(
        async () =>
          Math.max(
            0,
            ...(await readQueue(this.page, this.layerName)).entries.map(
              (entry) => entry.operationId ?? 0,
            ),
          ),
        { message: "The gesture must admit a new skeleton edit" },
      )
      .toBeGreaterThan(before);
    this.lastOperationId = Math.max(
      ...(await readQueue(this.page, this.layerName)).entries.map(
        (entry) => entry.operationId ?? 0,
      ),
    );
  }

  async open(
    sourceUrl: string,
    segmentIds = [10, 20],
    secondLayer = false,
    position = [2000, 2000, 1000],
    inspectIds = segmentIds,
  ) {
    const layer = (name: string, segments: number[], key: string) => ({
      type: "segmentation",
      name,
      source: sourceUrl,
      segments: segments.map(String),
      tab: "skeleton",
      skeletonNodeFilter: "none",
      toolBindings: { [key]: "spatialSkeletonEditMode" },
    });
    const state = {
      dimensions: { x: [1e-9, "m"], y: [1e-9, "m"], z: [1e-9, "m"] },
      position,
      crossSectionScale: 10,
      projectionScale: 10000,
      layout: "4panel",
      showSlices: false,
      layers: [
        layer(this.layerName, segmentIds, "E"),
        ...(secondLayer ? [layer("Second", segmentIds, "F")] : []),
      ],
      selectedLayer: { layer: this.layerName, visible: true },
    };
    await this.page.goto(`/#!${encodeURIComponent(JSON.stringify(state))}`);
    await expect(
      this.page.getByText("Skeleton", { exact: true }),
    ).toBeVisible();
    for (const id of inspectIds) await this.inspect(id);
    await this.activate("E");
  }

  async selectLayer() {
    const alreadyOpen = await this.page.evaluate((name) => {
      const selected = (window as unknown as { viewer: Viewer }).viewer
        .selectedLayer;
      return selected.layer?.name === name && selected.visible;
    }, this.layerName);
    if (!alreadyOpen)
      await this.page
        .locator(".neuroglancer-layer-item-label")
        .filter({ hasText: new RegExp(`^${this.layerName}$`) })
        .click({ modifiers: ["Control"] });
  }

  async inspect(segmentId: number) {
    await this.selectLayer();
    await this.page.getByText("Seg.", { exact: true }).click();
    await this.page
      .getByRole("textbox", { name: SEGMENT_INPUT, exact: true })
      .fill(String(segmentId));
    await this.page
      .locator(".neuroglancer-segment-list")
      .getByText(String(segmentId), { exact: true })
      .first()
      .click({ button: "right", modifiers: ["Control"] });
    await this.page.getByText("Skeleton", { exact: true }).click();
    await expect(
      this.page.getByTitle("Using inspected full skeleton data.", {
        exact: true,
      }),
    ).toBeVisible();
    await this.page
      .getByRole("combobox", { name: "Filter loaded nodes by node type" })
      .selectOption({ label: "None" });
  }

  async selectNode(id: number) {
    const [node] = await readGraph(this.page, [id], this.layerName);
    if (!node)
      throw new Error(
        `Node ${id} is not in the inspected ${this.layerName} layer`,
      );
    await this.inspect(node.skeletonId);
    await this.page
      .getByRole("textbox", { name: "Enter node ID or description" })
      .fill(String(id));
    await this.page
      .getByRole("button", {
        name: new RegExp(`^(Origin|Minus|Circle|Flag|Share) ${id} `),
      })
      .click();
    await expect(this.page.getByRole("spinbutton")).toBeVisible();
  }

  async panelCenter() {
    const bounds = await this.page
      .locator(".neuroglancer-rendered-data-panel")
      .first()
      .boundingBox();
    if (!bounds) throw new Error("Missing skeleton viewport");
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }

  async activate(key = "E") {
    const center = await this.panelCenter();
    await this.page.mouse.move(center.x, center.y);
    await this.page.keyboard.press(`Shift+${key}`);
    await expect(
      this.page.getByText("Skeleton editing", { exact: true }),
    ).toBeVisible();
  }

  async split(id: number) {
    await this.selectNode(id);
    const center = await this.panelCenter();
    await this.page.mouse.move(center.x, center.y);
    await this.runEdit(async () => {
      await this.page.keyboard.down("s");
      try {
        await this.page.mouse.click(center.x, center.y);
      } finally {
        await this.page.keyboard.up("s");
      }
    });
  }

  async merge(sourceId: number, targetId: number) {
    // Center the camera on the source. With the fixed orthogonal view and scale,
    // the other node's pixel location is derived from its inspected position.
    await this.selectNode(sourceId);
    const nodes = await readGraph(
      this.page,
      [sourceId, targetId],
      this.layerName,
    );
    const source = nodes.find((node) => node.id === sourceId)!;
    const target = nodes.find((node) => node.id === targetId)!;
    const center = await this.panelCenter();
    const scale = await this.page.evaluate(
      () =>
        (window as unknown as { viewer: Viewer }).viewer.crossSectionScale
          .value,
    );
    await this.page.mouse.move(center.x, center.y);
    await this.runEdit(async () => {
      await this.page.keyboard.down("m");
      try {
        await this.page.mouse.click(center.x, center.y);
        await this.page.mouse.click(
          center.x + (target.position[0] - source.position[0]) / scale,
          center.y + (target.position[1] - source.position[1]) / scale,
        );
      } finally {
        await this.page.keyboard.up("m");
      }
    });
  }

  async undo() {
    await this.runEdit(() =>
      this.page.getByRole("button", { name: /^Undo / }).click(),
    );
  }
  async redo() {
    await this.runEdit(() =>
      this.page.getByRole("button", { name: /^Redo / }).click(),
    );
  }
  async waitSaved() {
    await expect
      .poll(async () => (await readQueue(this.page, this.layerName)).pending)
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await readQueue(this.page, this.layerName)).recent.find(
            (entry) =>
              this.lastOperationId === undefined ||
              entry.operationId === this.lastOperationId,
          )?.status,
      )
      .toBe("saved");
  }

  async showQueue() {
    await this.selectLayer();
    await this.page.getByText("Queue", { exact: true }).click();
  }

  async showSkeleton() {
    await this.page.getByText("Skeleton", { exact: true }).click();
  }

  async radius(id: number, value: number) {
    await this.selectNode(id);
    await this.runEdit(async () => {
      await this.page.getByRole("spinbutton").fill(String(value));
      await this.page.getByRole("spinbutton").press("Tab");
    });
  }

  async move(id: number, dx: number, dy: number) {
    await this.selectNode(id);
    const center = await this.panelCenter();
    await this.page.mouse.move(center.x, center.y);
    await this.runEdit(async () => {
      await this.page.mouse.down();
      await this.page.mouse.move(center.x + dx, center.y + dy, { steps: 4 });
      await this.page.mouse.up();
    });
  }

  async reroot(id: number) {
    await this.selectNode(id);
    await this.runEdit(() =>
      this.page.getByRole("button", { name: "Origin", exact: true }).click(),
    );
  }

  async reload(segmentIds: number[]) {
    // URL serialization is debounced independently of mutation acknowledgement.
    // Reload only after the visible segments contain the saved permanent IDs.
    await expect
      .poll(
        () => {
          const state = JSON.parse(
            decodeURIComponent(new URL(this.page.url()).hash.slice(2)),
          ) as { layers: Array<{ name: string; segments?: string[] }> };
          const segments =
            state.layers.find((layer) => layer.name === this.layerName)
              ?.segments ?? [];
          return segments
            .filter((id) => !id.startsWith("!"))
            .map(Number)
            .sort((a, b) => a - b);
        },
        { message: "Reload must use the saved segment IDs in the URL" },
      )
      .toEqual([...segmentIds].sort((a, b) => a - b));
    await this.page.reload();
    this.lastOperationId = undefined;
    await expect(
      this.page.getByText("Skeleton", { exact: true }),
    ).toBeVisible();
    for (const id of segmentIds) await this.inspect(id);
    await expect
      .poll(() => readQueue(this.page, this.layerName))
      .toMatchObject({
        pending: false,
        recent: [],
        canUndo: false,
        canRedo: false,
      });
    await expect(
      this.page.getByRole("button", { name: "Nothing to undo.", exact: true }),
    ).toBeDisabled();
    await expect(
      this.page.getByRole("button", { name: "Nothing to redo.", exact: true }),
    ).toBeDisabled();
  }
}
