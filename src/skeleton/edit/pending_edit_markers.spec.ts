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

import {
  buildPendingEditMarkers,
  getPendingEditMarkerPrimitives,
} from "#src/skeleton/edit/pending_edit_markers.js";

describe("buildPendingEditMarkers", () => {
  it("draws only explicitly known merge endpoints and their requested connector", () => {
    const cues = buildPendingEditMarkers(
      [
        {
          intentId: 1,
          sequence: 1,
          direction: "execute",
          kind: "merge",
          lifecycle: "preparing",
          segmentIds: [11n, 17n],
          endpointNodeIds: [101n, 202n],
          lastKnownPositions: [
            { nodeId: 101n, position: new Float32Array([1, 2, 3]) },
            { nodeId: 202n, position: new Float32Array([4, 5, 6]) },
          ],
        },
      ],
      () => undefined,
    );

    expect(cues.map((cue: { type: string }) => cue.type)).toEqual([
      "marker",
      "marker",
      "connector",
    ]);
    expect(cues[2]).toMatchObject({
      type: "connector",
      fromNodeId: 101n,
      toNodeId: 202n,
    });
  });

  it("omits relationships whose endpoint positions are unavailable", () => {
    const cues = buildPendingEditMarkers(
      [
        {
          intentId: 2,
          sequence: 2,
          direction: "execute",
          kind: "split",
          lifecycle: "preparing",
          segmentIds: [11n],
          cutNodeId: 101n,
          cutParentNodeId: 99n,
          lastKnownPositions: [
            { nodeId: 101n, position: new Float32Array([1, 2, 3]) },
          ],
        },
      ],
      () => undefined,
    );

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({
      type: "marker",
      cueKind: "split",
      nodeId: 101n,
    });
  });

  it("draws a known split edge when the live parent position is available", () => {
    const cues = buildPendingEditMarkers(
      [
        {
          intentId: 5,
          sequence: 5,
          direction: "execute",
          kind: "split",
          lifecycle: "preparing",
          segmentIds: [11n],
          cutNodeId: 101n,
          cutParentNodeId: 99n,
          lastKnownPositions: [
            { nodeId: 101n, position: new Float32Array([1, 2, 3]) },
          ],
        },
      ],
      (nodeId) => (nodeId === 99n ? new Float32Array([4, 5, 6]) : undefined),
    );

    expect(cues.map((cue: { type: string }) => cue.type)).toEqual([
      "marker",
      "marker",
      "connector",
    ]);
    expect(cues[2]).toMatchObject({
      type: "connector",
      fromNodeId: 99n,
      toNodeId: 101n,
    });
  });

  it("prefers a live node position to a captured fallback", () => {
    const cues = buildPendingEditMarkers(
      [
        {
          intentId: 3,
          sequence: 3,
          direction: "undo",
          kind: "delete",
          lifecycle: "preparing",
          segmentIds: [11n],
          nodeId: 101n,
          lastKnownPositions: [
            { nodeId: 101n, position: new Float32Array([1, 2, 3]) },
          ],
        },
      ],
      () => new Float32Array([7, 8, 9]),
    );

    expect(cues[0]).toMatchObject({
      type: "marker",
      lifecycle: "preparing",
      position: new Float32Array([7, 8, 9]),
    });
  });

  it("marks a node being restored with one marker and no connector", () => {
    const cues = buildPendingEditMarkers(
      [
        {
          intentId: 4,
          sequence: 4,
          direction: "undo",
          kind: "restore",
          lifecycle: "preparing",
          segmentIds: [11n],
          nodeId: 101n,
          lastKnownPositions: [
            { nodeId: 101n, position: new Float32Array([1, 2, 3]) },
          ],
        },
      ],
      () => undefined,
    );

    expect(cues).toEqual([
      expect.objectContaining({
        type: "marker",
        cueKind: "restore",
        nodeId: 101n,
      }),
    ]);
  });
});

describe("getPendingEditMarkerPrimitives", () => {
  const ring = { diameter: 10, borderWidth: 3 };
  const position = new Float32Array([1, 2, 3]);

  function makeCue(kind: "delete" | "restore" | "reroot" | "split" | "merge") {
    return {
      type: "marker" as const,
      intentId: 1,
      cueKind: kind,
      lifecycle: "preparing" as const,
      nodeId: 101n,
      position,
    };
  }

  it("labels each queued edit's node with its kind: × delete, + restore, R reroot, S split, M merge", () => {
    const primitives = getPendingEditMarkerPrimitives(
      (["delete", "restore", "reroot", "split", "merge"] as const).map(makeCue),
      ring,
      (modelPosition) => Float32Array.from(modelPosition),
    );

    expect(
      primitives.map((primitive) =>
        primitive.kind === "preparationMarker" ? primitive.label : undefined,
      ),
    ).toEqual(["×", "+", "R", "S", "M"]);
  });

  it("draws a queued edit's ring outside the node's selection ring", () => {
    const [marker] = getPendingEditMarkerPrimitives(
      [makeCue("delete")],
      ring,
      (modelPosition) => Float32Array.from(modelPosition),
    );

    expect(marker).toMatchObject({ kind: "preparationMarker" });
    if (marker.kind !== "preparationMarker") return;
    expect(marker.ring.diameter).toBeGreaterThan(ring.diameter);
  });

  it("omits a cue whose node has no position in the current view", () => {
    expect(
      getPendingEditMarkerPrimitives(
        [makeCue("delete")],
        ring,
        () => undefined,
      ),
    ).toEqual([]);
  });
});
