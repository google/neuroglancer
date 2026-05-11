import { describe, expect, it, vi } from "vitest";

import { resolveSpatiallyIndexedSkeletonSegmentPick } from "#src/skeleton/picking.js";
import { spatiallyIndexedSkeletonTextureAttributeSpecs } from "#src/skeleton/spatial_attribute_layout.js";
import { Uint64Set } from "#src/uint64_set.js";
import { DataType } from "#src/util/data_type.js";

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

const { SpatiallyIndexedSkeletonLayer, getSpatialSkeletonCellKeyPrefix } =
  await import("#src/skeleton/frontend.js");

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

describe("spatiallyIndexedSkeletonTextureAttributeSpecs", () => {
  it("keeps the browse path upload layout to position plus segment", () => {
    expect(spatiallyIndexedSkeletonTextureAttributeSpecs).toEqual([
      { name: "position", dataType: DataType.FLOAT32, numComponents: 3 },
      { name: "segment", dataType: DataType.UINT32, numComponents: 1 },
    ]);
  });
});

describe("SpatiallyIndexedSkeletonLayer targeted source invalidation", () => {
  it("computes absolute half-open cell prefixes without lower-bound offsets", () => {
    expect(
      getSpatialSkeletonCellKeyPrefix(
        new Float32Array([100, 200, 300]),
        new Float32Array([100, 100, 100]),
      ),
    ).toBe("1,2,3:");
    expect(
      getSpatialSkeletonCellKeyPrefix(
        new Float32Array([99.999, 199.999, 299.999]),
        new Float32Array([100, 100, 100]),
      ),
    ).toBe("0,1,2:");
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
    expect([...invalidateCacheKeyPrefixes.mock.calls[0][0]]).toEqual([
      "1,2,3:",
    ]);
    expect(source2d.invalidateCacheKeyPrefixes).toHaveBeenCalledTimes(1);
    expect([...source2d.invalidateCacheKeyPrefixes.mock.calls[0][0]]).toEqual([
      "2,4,6:",
      "3,4,6:",
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
