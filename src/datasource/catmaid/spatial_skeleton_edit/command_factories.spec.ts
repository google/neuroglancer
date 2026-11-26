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

import { describe, expect, it } from "vitest";

import type { CatmaidClient } from "#src/datasource/catmaid/api.js";
import {
  CatmaidSpatialSkeletonEditCommands,
  getCatmaidMergeQueueInputRequirements,
  getCatmaidQueueInputRequirements,
} from "#src/datasource/catmaid/spatial_skeleton_edit/command_factories.js";

function makeCommands() {
  return new CatmaidSpatialSkeletonEditCommands({
    getClient: () => ({}) as CatmaidClient,
  });
}

describe("CATMAID edit commands", () => {
  it("keeps the children an insert was created with when the caller's array changes later", () => {
    const childNodeIds = [2n];
    const command = makeCommands().insertNodesCommand.createCommand({
      skeletonId: 23n,
      parentNodeId: 1n,
      childNodeIds,
      positionInModelSpace: [1, 2, 3],
    });
    childNodeIds.push(3n);
    expect((command as any).payload.options.childNodeIds).toEqual([2n]);
  });

  it("rejects an insert with no children, a repeated child, or a child that is not an ID", () => {
    const commands = makeCommands();
    for (const children of [[], [2n, 2n], [NaN]]) {
      expect(() =>
        commands.insertNodesCommand.createCommand({
          skeletonId: 23n,
          parentNodeId: 1n,
          childNodeIds: children,
          positionInModelSpace: [1, 2, 3],
        }),
      ).toThrow(/invalid payload/);
    }
  });

  it("refuses a move whose node is malformed, naming the command", () => {
    expect(() =>
      makeCommands().moveNodesCommand.createCommand({
        node: {},
        nextPositionInModelSpace: new Float32Array([7, 8, 9]),
      }),
    ).toThrow("CATMAID move-node command received an invalid payload.");
  });
});

describe("CATMAID queue input requirements", () => {
  it("deduplicates required endpoints", () => {
    const endpoint = { segmentId: 7n, nodeId: 11n };
    expect(getCatmaidQueueInputRequirements(endpoint, endpoint)).toEqual({
      required: [endpoint],
    });
  });

  it("declares the Merge destination as loadable", () => {
    const source = { segmentId: 7n, nodeId: 11n };
    const target = { segmentId: 8n, nodeId: 12n };
    expect(getCatmaidMergeQueueInputRequirements(source, target)).toEqual({
      required: [source],
      loadable: [target],
    });
  });

  it("does not expose a duplicate required endpoint as loadable", () => {
    const endpoint = { segmentId: 7n, nodeId: 11n };
    expect(getCatmaidMergeQueueInputRequirements(endpoint, endpoint)).toEqual({
      required: [endpoint],
    });
  });
});
