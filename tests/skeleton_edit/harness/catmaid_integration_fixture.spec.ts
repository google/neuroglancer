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

import { describe, expect, it, vi } from "vitest";
import {
  CatmaidIntegrationFixture,
  serializeSwc,
  skeletonPreset,
} from "./catmaid_integration_fixture.js";

const config = {
  baseUrl: "http://127.0.0.1:8000",
  projectId: 19,
  apiToken: "test-secret",
};

describe("SWC fixture import", () => {
  it("serializes a complete branched skeleton with local parent IDs", () => {
    const rows = serializeSwc(skeletonPreset("branch")[0])
      .trim()
      .split("\n")
      .map((line) => line.split(" ").map(Number));
    expect(rows).toEqual([
      [1, 3, 1000, 1000, 1000, 100, -1],
      [2, 3, 2000, 1000, 1000, 100, 1],
      [3, 3, 3000, 700, 1000, 100, 2],
      [4, 3, 3000, 1300, 1000, 100, 2],
      [5, 3, 4000, 1300, 1000, 100, 4],
      [6, 3, 1000, 1700, 1000, 100, 1],
    ]);
  });

  it("maps permuted backend IDs and verifies the imported graph before use", async () => {
    const imported = {
      skeleton_id: 51,
      neuron_id: 52,
      node_id_map: { 1: 903, 2: 401, 3: 702 },
    };
    const fetchApi = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(imported))
      .mockResolvedValueOnce(Response.json([51]))
      .mockResolvedValueOnce(
        Response.json([
          [
            [702, 401, 1, 3000, 1000, 1000, 100, 5],
            [903, null, 1, 1000, 1000, 1000, 100, 5],
            [401, 903, 1, 2000, 1000, 1000, 100, 5],
          ],
          [],
          {},
        ]),
      );
    const fixture = new CatmaidIntegrationFixture(config, fetchApi);
    await fixture.seed("chain");
    expect(fixture.ids).toEqual({ Aroot: 903, Amiddle: 401, Aleaf: 702 });
    expect(fixture.initial.map(({ id, parentId }) => [id, parentId])).toEqual([
      [401, 903],
      [702, 401],
      [903, null],
    ]);
    expect(fetchApi.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:8000/19/skeletons/import",
      "http://127.0.0.1:8000/19/skeletons/",
      "http://127.0.0.1:8000/19/skeletons/51/compact-detail?with_tags=true&with_connectors=true",
    ]);
    const body = fetchApi.mock.calls[0][1]!.body as FormData;
    const uploaded = body.get("file") as File;
    const text = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(uploaded);
    });
    expect(text).toBe(serializeSwc(skeletonPreset("chain")[0]));
  });

  it.each([{ 1: 10 }, { 1: 10, 2: 10, 3: 30 }, { 1: 10, 2: 20, 3: -1 }])(
    "rejects incomplete or invalid import mapping %j",
    async (node_id_map) => {
      const fetchApi = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ skeleton_id: 50, node_id_map }));
      await expect(
        new CatmaidIntegrationFixture(config, fetchApi).seed("chain"),
      ).rejects.toThrow(/mapping|fixture ID/);
    },
  );

  it("detects a read-back topology mismatch instead of trusting import success", async () => {
    const fetchApi = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ skeleton_id: 50, node_id_map: { 1: 10 } }),
      )
      .mockResolvedValueOnce(Response.json([50]))
      .mockResolvedValueOnce(
        Response.json([[[10, 999, 1, 1000, 1000, 1000, 100, 5]], [], {}]),
      );
    await expect(
      new CatmaidIntegrationFixture(config, fetchApi).seed("singleton"),
    ).rejects.toThrow("differs from definition");
  });

  it("enriches only requested properties and independently decodes Unicode labels", async () => {
    const description = "á, b\nβ";
    const fetchApi = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ skeleton_id: 50, node_id_map: { 1: 10 } }),
      )
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json([50]))
      .mockResolvedValueOnce(
        Response.json([
          [[10, null, 1, 1000, 1000, 1000, 125, 3]],
          [],
          {
            [`neuroglancer-description:v1:${encodeURIComponent(description)}`]:
              [10],
            ends: [10],
          },
        ]),
      );
    const fixture = new CatmaidIntegrationFixture(config, fetchApi);
    await fixture.seed("singleton", {
      Aroot: { radius: 125, confidence: 50, description, isTrueEnd: true },
    });
    expect(fixture.initial[0]).toMatchObject({
      radius: 125,
      confidence: 50,
      description,
      isTrueEnd: true,
    });
    expect(fetchApi.mock.calls.slice(1, 3).map(([url]) => String(url))).toEqual(
      [
        "http://127.0.0.1:8000/19/treenodes/10/confidence",
        "http://127.0.0.1:8000/19/label/treenode/10/update",
      ],
    );
  });

  it("enumerates newly assigned skeletons instead of retaining the seed ID list", async () => {
    const fetchApi = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([80, 90]))
      .mockResolvedValueOnce(
        Response.json([[[800, null, 1, 1, 2, 3, 0, 0]], [], {}]),
      )
      .mockResolvedValueOnce(
        Response.json([[[900, null, 1, 4, 5, 6, 10, 5]], [], {}]),
      );
    const fixture = new CatmaidIntegrationFixture(config, fetchApi);
    expect(
      (await fixture.snapshot()).map(({ id, skeletonId }) => [id, skeletonId]),
    ).toEqual([
      [800, 80],
      [900, 90],
    ]);
  });

  it("starts empty creation scenarios without import or create requests", async () => {
    const fetchApi = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    const fixture = new CatmaidIntegrationFixture(config, fetchApi);
    await fixture.seed("empty");
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fixture.initial).toEqual([]);
  });
});
