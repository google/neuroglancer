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

import { isDeepStrictEqual } from "node:util";
import type { GraphNode } from "./skeleton_edit_page.js";

export interface CatmaidIntegrationConfig {
  baseUrl: string;
  projectId: number;
  apiToken: string;
}

export type PresetName =
  | "empty"
  | "singleton"
  | "rootChild"
  | "chain"
  | "pair"
  | "branch"
  | "branchPair";
export interface SeedNode {
  name: string;
  parent: string | null;
  position: [number, number, number];
  radius: number;
  confidence: number;
  description: string;
  isTrueEnd: boolean;
}
export interface CatmaidTestNode extends GraphNode {
  radius: number;
  confidence: number;
  description: string;
  isTrueEnd: boolean;
}

export function skeletonPreset(preset: PresetName): SeedNode[][] {
  const chain = (prefix: string, y: number, branched: boolean): SeedNode[] => {
    const data: Array<[string, string | null, number, number]> = branched
      ? [
          ["root", null, 1000, y],
          ["middle", "root", 2000, y],
          ["leaf", "middle", 3000, y - 300],
          ["side", "middle", 3000, y + 300],
          ["tip", "side", 4000, y + 300],
          ["sibling", "root", 1000, y + 700],
        ]
      : [
          ["root", null, 1000, y],
          ["middle", "root", 2000, y],
          ["leaf", "middle", 3000, y],
        ];
    return data.map(([name, parent, x, py]) => ({
      name: prefix + name,
      parent: parent === null ? null : prefix + parent,
      position: [x, py, 1000],
      radius: 100,
      confidence: 100,
      description: "",
      isTrueEnd: false,
    }));
  };
  if (preset === "empty") return [];
  const a = chain("A", 1000, preset === "branch" || preset === "branchPair");
  if (preset === "singleton") return [a.slice(0, 1)];
  if (preset === "rootChild") return [a.slice(0, 2)];
  if (preset === "pair" || preset === "branchPair")
    return [a, chain("B", 3000, preset === "branchPair")];
  return [a];
}

export function serializeSwc(nodes: SeedNode[]): string {
  const ids = new Map(nodes.map((node, index) => [node.name, index + 1]));
  if (
    ids.size !== nodes.length ||
    nodes.filter((node) => node.parent === null).length !== 1
  ) {
    throw new Error(
      "A fixture skeleton must have unique names and exactly one root",
    );
  }
  return (
    nodes
      .map((node, index) => {
        const parent = node.parent === null ? -1 : ids.get(node.parent);
        if (parent === undefined)
          throw new Error(`Unknown fixture parent: ${node.parent}`);
        return [index + 1, 3, ...node.position, node.radius, parent].join(" ");
      })
      .join("\n") + "\n"
  );
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid CATMAID fixture ID");
  return value;
}

/** Independent API oracle; no production graph/description conversion helpers. */
export class CatmaidIntegrationFixture {
  readonly ids: Record<string, number> = {};
  initial: CatmaidTestNode[] = [];
  constructor(
    readonly config: CatmaidIntegrationConfig,
    private fetchApi: typeof fetch = fetch,
  ) {}
  get datasourceUrl() {
    return `catmaid://${this.config.baseUrl}/${this.config.projectId}`;
  }

  async request(
    endpoint: string,
    body?: URLSearchParams | FormData,
  ): Promise<any> {
    let response: Response;
    try {
      response = await this.fetchApi(
        `${this.config.baseUrl}/${this.config.projectId}/${endpoint}`,
        {
          method: body === undefined ? "GET" : "POST",
          body,
          headers: { Authorization: `Token ${this.config.apiToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new Error(`CATMAID fixture request ${endpoint} did not complete`);
    }
    const data = await response.json();
    if (!response.ok || data?.error) {
      const detail = String(data?.error ?? "")
        .replaceAll(this.config.apiToken, "[redacted]")
        .slice(0, 300);
      throw new Error(
        `CATMAID fixture ${endpoint}: HTTP ${response.status} ${detail}`,
      );
    }
    return data;
  }

  async seed(
    preset: PresetName,
    overrides: Partial<
      Record<
        string,
        Partial<
          Pick<SeedNode, "confidence" | "description" | "isTrueEnd" | "radius">
        >
      >
    > = {},
  ) {
    const definitions = skeletonPreset(preset).map((nodes) =>
      nodes.map((node) => ({ ...node, ...overrides[node.name] })),
    );
    const expected: CatmaidTestNode[] = [];
    for (const nodes of definitions) {
      const form = new FormData();
      form.set(
        "file",
        new Blob([serializeSwc(nodes)], { type: "text/plain" }),
        "fixture.swc",
      );
      form.set("name", `E2E ${nodes[0].name}`);
      const imported = await this.request("skeletons/import", form);
      const skeletonId = positiveId(imported.skeleton_id);
      const mapped = nodes.map((_, i) =>
        positiveId(imported.node_id_map?.[i + 1]),
      );
      if (
        new Set(mapped).size !== nodes.length ||
        Object.keys(imported.node_id_map).length !== nodes.length
      )
        throw new Error("Incomplete or duplicate SWC node mapping");
      nodes.forEach((node, i) => {
        this.ids[node.name] = mapped[i];
      });
      for (const node of nodes) {
        const id = this.ids[node.name];
        if (node.confidence !== 100)
          await this.request(
            `treenodes/${id}/confidence`,
            new URLSearchParams({
              new_confidence: String(node.confidence / 25 + 1),
              state: '{"nocheck":true}',
            }),
          );
        if (node.description || node.isTrueEnd) {
          const tags = [
            ...(node.description
              ? [
                  `neuroglancer-description:v1:${encodeURIComponent(node.description)}`,
                ]
              : []),
            ...(node.isTrueEnd ? ["ends"] : []),
          ];
          await this.request(
            `label/treenode/${id}/update`,
            new URLSearchParams({
              tags: tags.join(","),
              delete_existing: "true",
            }),
          );
        }
        expected.push({
          id,
          skeletonId,
          parentId: node.parent === null ? null : this.ids[node.parent],
          position: [...node.position],
          radius: node.radius,
          confidence: node.confidence,
          description: node.description,
          isTrueEnd: node.isTrueEnd,
        });
      }
    }
    expected.sort((a, b) => a.id - b.id);
    const actual = await this.snapshot();
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `Imported fixture differs from definition:\nexpected ${JSON.stringify(expected)}\nactual ${JSON.stringify(actual)}`,
      );
    }
    this.initial = expected;
  }

  async snapshot(): Promise<CatmaidTestNode[]> {
    const skeletons = await this.request("skeletons/");
    if (!Array.isArray(skeletons))
      throw new Error("Invalid skeleton enumeration");
    const nodes: CatmaidTestNode[] = [];
    for (const value of skeletons) {
      const skeletonId = positiveId(value);
      const data = await this.request(
        `skeletons/${skeletonId}/compact-detail?with_tags=true&with_connectors=true`,
      );
      const tags = new Map<number, string[]>();
      for (const [tag, members] of Object.entries(data[2]) as Array<
        [string, number[]]
      >) {
        for (const id of members) tags.set(id, [...(tags.get(id) ?? []), tag]);
      }
      for (const row of data[0]) {
        const labels = tags.get(row[0]) ?? [];
        const encoded = labels.filter((tag) =>
          tag.startsWith("neuroglancer-description:v1:"),
        );
        const description = encoded.length
          ? encoded
              .map((tag) =>
                decodeURIComponent(
                  tag.slice("neuroglancer-description:v1:".length),
                ),
              )
              .join("\n")
          : labels.filter((tag) => tag !== "ends").join("\n");
        nodes.push({
          id: positiveId(row[0]),
          skeletonId,
          parentId: row[1],
          position: [row[3], row[4], row[5]],
          radius: row[6],
          confidence: Math.max(0, Math.min(100, (row[7] - 1) * 25)),
          description,
          isTrueEnd: labels.includes("ends"),
        });
      }
    }
    nodes.sort((a, b) => a.id - b.id);
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
      throw new Error("Duplicate node in project snapshot");
    return nodes;
  }
}
