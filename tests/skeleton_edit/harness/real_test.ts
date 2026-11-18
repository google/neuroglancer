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

/**
 * @file Extends the Playwright test with a session that seeds a real CATMAID
 * project, edits it through the viewer, and checks that the viewer and CATMAID
 * agree on the skeleton graph.
 */

import { expect } from "@playwright/test";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { bigintCompare } from "#src/util/bigint.js";
import type { Viewer } from "#src/viewer.js";
import {
  CatmaidIntegrationFixture,
  type CatmaidTestNode,
  type PresetName,
  type SeedNode,
} from "./catmaid_integration_fixture.js";
import { withCatmaidProject } from "./catmaid_project.js";
import { CatmaidTransport } from "./catmaid_transport.js";
import { test as base } from "./fixtures.js";
import {
  SkeletonEditPage,
  readGraph,
  readQueue,
  type ViewerNode,
} from "./skeleton_edit_page.js";

type ViewerTestNode = Omit<CatmaidTestNode, "id" | "parentId" | "skeletonId"> &
  ViewerNode;
export type ModelNode = Omit<ViewerTestNode, "skeletonId">;
function viewerIds(node: CatmaidTestNode): ViewerTestNode {
  return {
    ...node,
    id: BigInt(node.id),
    parentId: node.parentId === null ? null : BigInt(node.parentId),
    skeletonId: BigInt(node.skeletonId),
  };
}
export function model(nodes: ViewerTestNode[]): ModelNode[] {
  return nodes
    .map(({ skeletonId: _skeletonId, ...node }) => ({
      ...node,
      position: [...node.position],
    }))
    .sort((a, b) => bigintCompare(a.id, b.id));
}
export function change(
  nodes: ModelNode[],
  id: bigint,
  patch: Partial<ModelNode>,
) {
  return nodes.map((node) => ({ ...node, ...(node.id === id ? patch : {}) }));
}
export function remap(nodes: ModelNode[], from: bigint, to: bigint) {
  return nodes
    .map((node) => ({
      ...node,
      id: node.id === from ? to : node.id,
      parentId: node.parentId === from ? to : node.parentId,
    }))
    .sort((a, b) => bigintCompare(a.id, b.id));
}
export function groups(nodes: ModelNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const components = new Map<bigint, bigint[]>();
  for (const node of nodes) {
    let root = node;
    const visited = new Set<bigint>();
    while (root.parentId !== null) {
      if (visited.has(root.id)) throw new Error("Cyclic expected graph");
      visited.add(root.id);
      const parent = byId.get(root.parentId);
      if (!parent) throw new Error("Missing expected parent");
      root = parent;
    }
    components.set(root.id, [...(components.get(root.id) ?? []), node.id]);
  }
  return [...components.values()]
    .map((ids) => ids.sort(bigintCompare))
    .sort((a, b) => bigintCompare(a[0], b[0]));
}

export class RealSkeletonPage extends SkeletonEditPage {
  override async activate(key = "E") {
    await expect
      .poll(() =>
        this.page.evaluate(() =>
          (window as unknown as { viewer: Viewer }).viewer.layerManager
            .getLayerByName("Skeletons")
            ?.isReady(),
        ),
      )
      .toBe(true);
    await super.activate(key);
  }
  async selected() {
    const selection = await this.page.evaluate(() => {
      const layer = (
        window as unknown as { viewer: Viewer }
      ).viewer.layerManager.getLayerByName("Skeletons")!
        .layer as SegmentationUserLayer;
      const selected = layer.skeletonNodeSelection.selected.value;
      return (
        selected && { id: selected.nodeId, skeletonId: selected.segmentId }
      );
    });
    expect(selection).toBeDefined();
    const [node] = await readGraph(this.page, [selection!.id]);
    expect(node).toBeDefined();
    expect(node.skeletonId).toBe(selection!.skeletonId);
    return node as ViewerTestNode;
  }
  async createRoot(dx = 0, dy = 0) {
    const center = await this.panelCenter();
    await this.page.mouse.move(center.x + dx, center.y + dy);
    await this.runEdit(async () => {
      await this.page.keyboard.down("n");
      try {
        await this.page.mouse.click(center.x + dx, center.y + dy);
      } finally {
        await this.page.keyboard.up("n");
      }
    });
    return this.selected();
  }
  async addChild(parentId?: bigint, dx = 35, dy = 20) {
    if (parentId !== undefined) await this.selectNode(parentId);
    const center = await this.panelCenter();
    await this.runEdit(async () => {
      await this.page.keyboard.down("Shift");
      try {
        await this.page.mouse.click(center.x + dx, center.y + dy);
      } finally {
        await this.page.keyboard.up("Shift");
      }
    });
    return this.selected();
  }
  async moveSelected(dx = 20, dy = 15) {
    const center = await this.panelCenter();
    await this.page.mouse.move(center.x, center.y);
    await this.runEdit(async () => {
      await this.page.mouse.down();
      await this.page.mouse.move(center.x + dx, center.y + dy, { steps: 4 });
      await this.page.mouse.up();
    });
    return this.selected();
  }
  async deleteNode(id: bigint) {
    await this.selectNode(id);
    await this.runEdit(() =>
      this.page
        .locator(
          '.neuroglancer-selection-details-skeleton-action[title="Delete node"]',
        )
        .click(),
    );
  }
  async mergeAtPosition(sourceId: bigint, targetPosition: number[]) {
    await this.selectNode(sourceId);
    const source = await this.selected();
    const center = await this.panelCenter();
    await this.page.mouse.move(center.x, center.y);
    await this.runEdit(async () => {
      await this.page.keyboard.down("m");
      try {
        await this.page.mouse.click(center.x, center.y);
        await this.page.mouse.click(
          center.x + (targetPosition[0] - source.position[0]) / 10,
          center.y + (targetPosition[1] - source.position[1]) / 10,
        );
      } finally {
        await this.page.keyboard.up("m");
      }
    });
  }
  async confidence(id: bigint, value: number) {
    await this.selectNode(id);
    await this.runEdit(async () => {
      await this.page
        .locator(
          "select.neuroglancer-selection-details-skeleton-properties-input",
        )
        .selectOption(String(value));
    });
  }
  async description(id: bigint, value: string) {
    await this.selectNode(id);
    const input = this.page.getByRole("textbox", {
      name: "Description",
      exact: true,
    });
    await this.runEdit(async () => {
      await input.fill(value);
      await input.press("Tab");
    });
  }
  async trueEnd(id: bigint) {
    await this.selectNode(id);
    await this.runEdit(() =>
      this.page.getByRole("button", { name: /^(\S+ )?True end$/ }).click(),
    );
  }
}

export class RealSession {
  readonly ui: RealSkeletonPage;
  readonly knownIds = new Set<bigint>();
  constructor(
    readonly api: CatmaidIntegrationFixture,
    readonly transport: CatmaidTransport,
    page: ConstructorParameters<typeof SkeletonEditPage>[0],
  ) {
    this.ui = new RealSkeletonPage(page);
    this.initial.forEach((node) => this.knownIds.add(node.id));
  }
  get initial() {
    return this.api.initial.map(viewerIds);
  }
  get original() {
    return model(this.initial);
  }
  get ids() {
    return Object.fromEntries(
      Object.entries(this.api.ids).map(([name, id]) => [name, BigInt(id)]),
    );
  }
  async moved(before: ModelNode[], id: bigint, dx = 25, dy = 15) {
    await this.ui.move(id, dx, dy);
    const position = (await this.ui.selected()).position;
    const initial = before.find((node) => node.id === id)!.position;
    // Raster picking rounds the viewport origin to pixels. Check the requested
    // displacement to one pixel, then require the exact result to persist.
    for (let axis = 0; axis < 3; ++axis)
      expect(
        Math.abs(position[axis] - initial[axis] - [dx * 10, dy * 10, 0][axis]),
      ).toBeLessThanOrEqual(10);
    return change(before, id, { position });
  }
  async open(inspectIds?: bigint[]) {
    await this.ui.open(
      this.api.datasourceUrl,
      [...new Set(this.initial.map((node) => node.skeletonId))],
      false,
      [2000, 2000, 1000],
      inspectIds,
    );
  }
  async preview(expected: ModelNode[]) {
    expected.forEach((node) => this.knownIds.add(node.id));
    const desired = [...expected]
      .sort((a, b) => bigintCompare(a.id, b.id))
      .map((node) => ({ ...node, position: node.position.map(Math.fround) }));
    await expect
      .poll(async () =>
        model(
          (await readGraph(
            this.ui.page,
            [...this.knownIds],
            "Skeletons",
            true,
          )) as ViewerTestNode[],
        ),
      )
      .toEqual(desired);
    const graph = await readGraph(
      this.ui.page,
      [...this.knownIds],
      "Skeletons",
      true,
    );
    const components = new Map<bigint, bigint[]>();
    for (const node of graph)
      components.set(node.skeletonId, [
        ...(components.get(node.skeletonId) ?? []),
        node.id,
      ]);
    expect(
      [...components.values()]
        .map((ids) => ids.sort(bigintCompare))
        .sort((a, b) => bigintCompare(a[0], b[0])),
    ).toEqual(groups(expected));
  }
  async persisted(expected: ModelNode[], browser = true) {
    const desired = [...expected]
      .sort((a, b) => bigintCompare(a.id, b.id))
      .map((node) => ({ ...node, position: node.position.map(Math.fround) }));
    const actual = (await this.api.snapshot()).map(viewerIds);
    expect(
      model(actual).map((node) => ({
        ...node,
        position: node.position.map(Math.fround),
      })),
    ).toEqual(desired);
    const components = new Map<bigint, bigint[]>();
    for (const node of actual)
      components.set(node.skeletonId, [
        ...(components.get(node.skeletonId) ?? []),
        node.id,
      ]);
    expect(
      [...components.values()]
        .map((ids) => ids.sort(bigintCompare))
        .sort((a, b) => bigintCompare(a[0], b[0])),
    ).toEqual(groups(expected));
    if (browser) {
      await this.preview(expected);
      await expect
        .poll(async () =>
          readGraph(
            this.ui.page,
            actual.map((node) => node.id),
            "Skeletons",
            true,
          ),
        )
        .toEqual(
          actual.map((node) => ({
            ...node,
            position: node.position.map(Math.fround),
          })),
        );
    }
    return actual;
  }
  async saved(expected: ModelNode[]) {
    await this.ui.waitSaved();
    const actual = await this.persisted(expected);
    expect(
      this.transport.mutations.every(
        (entry) =>
          entry.status === 200 && !entry.response?.error && !entry.failed,
      ),
    ).toBe(true);
    expect(this.transport.maxUnacknowledgedMutations).toBeLessThanOrEqual(1);
    return actual;
  }
  async reload(expected: ModelNode[]) {
    const saved = await this.api.snapshot();
    await this.ui.reload([
      ...new Set(saved.map((node) => BigInt(node.skeletonId))),
    ]);
    await this.persisted(expected);
    expect(await readQueue(this.ui.page)).toMatchObject({
      pending: false,
      canUndo: false,
      canRedo: false,
    });
  }
  async pending(expected: ModelNode[], text = "Saving") {
    await this.preview(expected);
    expect((await readQueue(this.ui.page)).pending).toBe(true);
    await this.ui.showQueue();
    await expect(this.ui.page.getByText(text, { exact: true })).toBeVisible();
    await this.ui.showSkeleton();
  }
  async visibleCurrentSegments() {
    const current = await this.api.snapshot();
    const visible = await this.ui.page.evaluate(() => {
      const layer = (
        window as unknown as { viewer: Viewer }
      ).viewer.layerManager.getLayerByName("Skeletons")!
        .layer as SegmentationUserLayer;
      return [
        ...layer.displayState.segmentationGroupState.value.visibleSegments,
      ];
    });
    expect(visible.sort(bigintCompare)).toEqual(
      [...new Set(current.map((node) => BigInt(node.skeletonId)))].sort(
        bigintCompare,
      ),
    );
  }
}

export const test = base.extend<{
  preset: PresetName;
  seedOverrides: Partial<
    Record<
      string,
      Partial<
        Pick<SeedNode, "confidence" | "description" | "isTrueEnd" | "radius">
      >
    >
  >;
  real: RealSession;
}>({
  preset: ["pair", { option: true }],
  seedOverrides: [{}, { option: true }],
  real: [
    async (
      { page, context, catmaidServer, preset, seedOverrides },
      use,
      testInfo,
    ) => {
      await withCatmaidProject(
        catmaidServer,
        testInfo.title,
        async (config) => {
          const api = new CatmaidIntegrationFixture(config);
          const transport = new CatmaidTransport(context, config);
          try {
            await api.seed(preset, seedOverrides);
            await transport.install();
            await use(new RealSession(api, transport, page));
          } finally {
            await transport.close();
            await testInfo.attach("catmaid-mutations", {
              body: JSON.stringify(transport.records, null, 2),
              contentType: "application/json",
            });
            await testInfo.attach("catmaid-final-graph", {
              body: JSON.stringify(await api.snapshot(), null, 2),
              contentType: "application/json",
            });
          }
        },
      );
    },
    { timeout: 180_000 },
  ],
});
