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

import { Uint64Set } from "#src/uint64_set.js";
import { getContrastRatio } from "#src/util/color.js";
import { vec3 } from "#src/util/geom.js";

if (!("WebGL2RenderingContext" in globalThis)) {
  Object.defineProperty(globalThis, "WebGL2RenderingContext", {
    value: new Proxy(class WebGL2RenderingContext {} as any, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        return 0;
      },
    }),
    configurable: true,
  });
}

const {
  SpatiallyIndexedSkeletonLayer,
  getSpatialSkeletonCellKeyPrefix,
  resolveSpatiallyIndexedSkeletonSegmentPick,
} = await import("#src/skeleton/frontend.js");

describe("resolveSpatiallyIndexedSkeletonSegmentPick", () => {
  it("returns the node segment id for direct node picks", () => {
    const chunk = {
      indices: new Uint32Array([0, 1, 1, 2]),
      numVertices: 3,
    };
    const segmentIds = new Uint32Array([11, 13, 17]);

    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 1, "node"),
    ).toBe(13);
  });

  it("returns the first valid endpoint segment id for direct edge picks", () => {
    const chunk = {
      indices: new Uint32Array([0, 1, 1, 2]),
      numVertices: 3,
    };
    const segmentIds = new Uint32Array([0, 19, 23]);

    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 0, "edge"),
    ).toBe(19);
    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 1, "edge"),
    ).toBe(19);
  });

  it("returns undefined for out-of-range direct picks", () => {
    const chunk = {
      indices: new Uint32Array([0, 1]),
      numVertices: 2,
    };
    const segmentIds = new Uint32Array([5, 7]);

    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 4, "node"),
    ).toBeUndefined();
    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 2, "edge"),
    ).toBeUndefined();
  });
});

describe("SpatiallyIndexedSkeletonLayer browse node picks", () => {
  it("resolves browse node picks with node id and source state", () => {
    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const segmentIds = new Uint32Array([11, 17]);
    const vertexBytes = new Uint8Array(
      positions.byteLength + segmentIds.byteLength,
    );
    vertexBytes.set(new Uint8Array(positions.buffer), 0);
    vertexBytes.set(new Uint8Array(segmentIds.buffer), positions.byteLength);
    const chunk = {
      vertexAttributes: vertexBytes,
      vertexAttributeOffsets: new Uint32Array([0, positions.byteLength]),
      numVertices: 2,
      indices: new Uint32Array([0, 1]),
      nodeIds: new Int32Array([101, 202]),
      nodeSourceStates: [
        { revisionToken: "2026-03-29T11:50:00Z" },
        { revisionToken: "2026-03-29T11:51:00Z" },
      ],
    };
    const layer = Object.create(SpatiallyIndexedSkeletonLayer.prototype);

    expect((layer as any).resolveNodePickFromChunk(chunk, 1)).toEqual({
      nodeId: 202,
      segmentId: 17,
      position: new Float32Array([4, 5, 6]),
      sourceState: { revisionToken: "2026-03-29T11:51:00Z" },
    });
  });
});

describe("SpatiallyIndexedSkeletonLayer selected node outline color", () => {
  it("derives the selected-node outline color from the selected segment color", () => {
    const sourceColor = vec3.fromValues(1, 0, 0);
    const isSelected = vi.fn(() => true);
    const displayState = {
      segmentationColorGroupState: {
        value: {
          segmentStatedColors: new Map(),
          segmentDefaultColor: { value: sourceColor },
          segmentColorHash: { compute: vi.fn() },
        },
      },
      saturation: { value: 0 },
      hoverHighlight: { value: true },
      segmentSelectionState: { isSelected },
    };
    const getCachedNodeSnapshot = vi.fn(() => ({
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
    }));
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        selectedNodeId: { value: 101 },
        selectedNodeOutlineColor: vec3.create(),
        selectedNodeOutlineColorGeneration: 0,
        cachedSelectedNodeOutlineColorGeneration: -1,
        displayState,
        getCachedNodeSnapshot,
      },
    );

    const outlineColor = (layer as any).getSelectedNodeOutlineColor();
    const cachedOutlineColor = (layer as any).getSelectedNodeOutlineColor();

    expect(getCachedNodeSnapshot).toHaveBeenCalledWith(101);
    expect(getCachedNodeSnapshot).toHaveBeenCalledTimes(1);
    expect(isSelected).not.toHaveBeenCalled();
    expect(cachedOutlineColor).toBe(outlineColor);
    expect(outlineColor[0]).toBeCloseTo(1);
    expect(outlineColor[1]).toBeCloseTo(0.95);
    expect(outlineColor[2]).toBeCloseTo(0.35);
    expect(getContrastRatio(outlineColor, sourceColor)).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("recomputes the outline color when the selected node changes", () => {
    const computeSegmentColor = vi.fn((color: Float32Array) => {
      color[0] = 1;
      color[1] = 0;
      color[2] = 0;
      return color;
    });
    const selectedNodeId = { value: 101 };
    const displayState = {
      segmentationColorGroupState: {
        value: {
          segmentStatedColors: new Map(),
          segmentDefaultColor: { value: undefined },
          segmentColorHash: { compute: computeSegmentColor },
        },
      },
      saturation: { value: 1 },
      hoverHighlight: { value: false },
      segmentSelectionState: { isSelected: vi.fn(() => false) },
    };
    const getCachedNodeSnapshot = vi.fn((nodeId: number) => ({
      nodeId,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
    }));
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        selectedNodeId,
        selectedNodeOutlineColor: vec3.create(),
        selectedNodeOutlineColorGeneration: 0,
        cachedSelectedNodeOutlineColorGeneration: -1,
        displayState,
        getCachedNodeSnapshot,
      },
    );

    (layer as any).getSelectedNodeOutlineColor();
    selectedNodeId.value = 202;
    ++(layer as any).selectedNodeOutlineColorGeneration;
    (layer as any).getSelectedNodeOutlineColor();

    expect(getCachedNodeSnapshot).toHaveBeenCalledTimes(2);
    expect(computeSegmentColor).toHaveBeenCalledTimes(2);
  });

  it("invalidates the selected-node outline cache when the input generation changes", () => {
    const computeSegmentColor = vi.fn((color: Float32Array) => {
      color[0] = 1;
      color[1] = 0;
      color[2] = 0;
      return color;
    });
    const displayState = {
      segmentationColorGroupState: {
        value: {
          segmentStatedColors: new Map(),
          segmentDefaultColor: { value: undefined },
          segmentColorHash: { compute: computeSegmentColor },
        },
      },
      saturation: { value: 1 },
      hoverHighlight: { value: false },
      segmentSelectionState: { isSelected: vi.fn(() => false) },
    };
    const getCachedNodeSnapshot = vi.fn(() => ({
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
    }));
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        selectedNodeId: { value: 101 },
        selectedNodeOutlineColor: vec3.create(),
        selectedNodeOutlineColorGeneration: 0,
        cachedSelectedNodeOutlineColorGeneration: -1,
        displayState,
        getCachedNodeSnapshot,
      },
    );

    (layer as any).getSelectedNodeOutlineColor();
    ++(layer as any).selectedNodeOutlineColorGeneration;
    (layer as any).getSelectedNodeOutlineColor();

    expect(getCachedNodeSnapshot).toHaveBeenCalledTimes(2);
    expect(computeSegmentColor).toHaveBeenCalledTimes(2);
  });

  it("returns the fallback outline color for an invalid selected segment", () => {
    const computeSegmentColor = vi.fn();
    const displayState = {
      segmentationColorGroupState: {
        value: {
          segmentStatedColors: new Map(),
          segmentDefaultColor: { value: undefined },
          segmentColorHash: { compute: computeSegmentColor },
        },
      },
      saturation: { value: 1 },
      hoverHighlight: { value: false },
      segmentSelectionState: { isSelected: vi.fn(() => false) },
    };
    const getCachedNodeSnapshot = vi.fn(() => ({
      nodeId: 101,
      segmentId: 0,
      position: new Float32Array([1, 2, 3]),
    }));
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        selectedNodeId: { value: 101 },
        selectedNodeOutlineColor: vec3.create(),
        selectedNodeOutlineColorGeneration: 0,
        cachedSelectedNodeOutlineColorGeneration: -1,
        displayState,
        getCachedNodeSnapshot,
      },
    );

    const outlineColor = (layer as any).getSelectedNodeOutlineColor();
    const cachedOutlineColor = (layer as any).getSelectedNodeOutlineColor();

    expect(getCachedNodeSnapshot).toHaveBeenCalledWith(101);
    expect(getCachedNodeSnapshot).toHaveBeenCalledTimes(1);
    expect(computeSegmentColor).not.toHaveBeenCalled();
    expect(outlineColor[0]).toBeCloseTo(1);
    expect(outlineColor[1]).toBeCloseTo(0.95);
    expect(outlineColor[2]).toBeCloseTo(0.35);
    expect(cachedOutlineColor[0]).toBeCloseTo(1);
    expect(cachedOutlineColor[1]).toBeCloseTo(0.95);
    expect(cachedOutlineColor[2]).toBeCloseTo(0.35);
  });
});

describe("SpatiallyIndexedSkeletonLayer targeted source invalidation", () => {
  it("computes absolute half-open cell prefixes without lower-bound offsets", () => {
    expect(
      getSpatialSkeletonCellKeyPrefix(
        new Float32Array([100, 200, 300]),
        new Float32Array([100, 100, 100]),
      ),
    ).toBe("1,2,3");
    expect(
      getSpatialSkeletonCellKeyPrefix(
        new Float32Array([99.999, 199.999, 299.999]),
        new Float32Array([100, 100, 100]),
      ),
    ).toBe("0,1,2");
  });

  it("dedupes cell prefixes per unique source entry", () => {
    const invalidateCacheKeyPrefixes = vi.fn();
    const source = {
      spec: {
        chunkDataSize: new Float32Array([100, 100, 100]),
        lowerChunkBound: new Float32Array([10, 20, 30]),
      },
      invalidateCacheKeyPrefixes,
    };
    const source2d = {
      spec: {
        chunkDataSize: new Float32Array([50, 50, 50]),
      },
      invalidateCacheKeyPrefixes: vi.fn(),
    };
    const redrawNeeded = { dispatch: vi.fn() };
    const layer = {
      sources: [{ chunkSource: source }, { chunkSource: source }],
      sources2d: [{ chunkSource: source2d }],
      redrawNeeded,
    };

    const invalidated =
      SpatiallyIndexedSkeletonLayer.prototype.invalidateSourceCellsForPositions.call(
        layer,
        [
          new Float32Array([100, 200, 300]),
          new Float32Array([199.999, 200, 300]),
          new Float32Array([100, 200, 300]),
        ],
      );

    expect(invalidated).toBe(true);
    expect(invalidateCacheKeyPrefixes).toHaveBeenCalledTimes(1);
    expect([...invalidateCacheKeyPrefixes.mock.calls[0][0]]).toEqual(["1,2,3"]);
    expect(source2d.invalidateCacheKeyPrefixes).toHaveBeenCalledTimes(1);
    expect([...source2d.invalidateCacheKeyPrefixes.mock.calls[0][0]]).toEqual([
      "2,4,6",
      "3,4,6",
    ]);
    expect(redrawNeeded.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("SpatiallyIndexedSkeletonLayer browse exclusions", () => {
  it("includes suppressed browse segments even when no overlay segment is loaded", () => {
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        suppressedBrowseSegmentIds: new Set<number>(),
        browseExcludedSegments: new Uint64Set(),
        browseExcludedSegmentsKey: undefined,
        redrawNeeded: { dispatch: vi.fn() },
        getLoadedOverlaySegmentIds: () => [],
      },
    );

    expect(layer.suppressBrowseSegment(29)).toBe(true);
    expect(layer.redrawNeeded.dispatch).toHaveBeenCalledTimes(1);

    const excludedSegments = (layer as any).getBrowsePassExcludedSegments();
    expect(excludedSegments).toBeInstanceOf(Uint64Set);
    expect([...excludedSegments]).toEqual([29n]);
  });
});
