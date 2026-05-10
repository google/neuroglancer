import { describe, expect, it, vi } from "vitest";

import { ChunkState } from "#src/chunk_manager/base.js";
import {
  cancelStaleSpatiallyIndexedSkeletonDownloads,
  getSpatiallyIndexedSkeleton3dRenderPriority,
  getSpatiallyIndexedSkeletonChunkPriority,
  markSpatiallyIndexedSkeletonChunkRequested,
  SPATIALLY_INDEXED_SKELETON_3D_PRIORITY_BOOST,
  SpatiallyIndexedSkeletonChunkRequestOwner,
} from "#src/skeleton/backend.js";
import {
  BASE_PRIORITY,
  SCALE_PRIORITY_MULTIPLIER,
} from "#src/sliceview/backend.js";

describe("skeleton/backend chunk priority", () => {
  it("uses the standard chunk-origin distance rule for 3d chunks", () => {
    expect(
      getSpatiallyIndexedSkeletonChunkPriority(
        Float32Array.of(3, 4, 0),
        Float32Array.of(2, 5, 1),
        Float32Array.of(1, 0, 0),
      ),
    ).toBeCloseTo(-Math.sqrt(17));
  });

  it("prioritizes chunks nearer the view center ahead of farther chunks", () => {
    const localCenter = Float32Array.of(10, 20, 30);
    const chunkSize = Float32Array.of(4, 4, 8);
    const nearChunk = Float32Array.of(2, 5, 4);
    const farChunk = Float32Array.of(5, 1, 0);

    expect(
      getSpatiallyIndexedSkeletonChunkPriority(
        localCenter,
        chunkSize,
        nearChunk,
      ),
    ).toBeGreaterThan(
      getSpatiallyIndexedSkeletonChunkPriority(
        localCenter,
        chunkSize,
        farChunk,
      ),
    );
  });

  it("uses a boost tied to the shared volumetric base priority", () => {
    expect(SPATIALLY_INDEXED_SKELETON_3D_PRIORITY_BOOST).toBe(-BASE_PRIORITY);
  });

  it("boosts 3d spatial skeleton chunks above equivalent volume-rendering chunks", () => {
    const basePriority = BASE_PRIORITY;
    const scaleIndex = 2;
    const localCenter = Float32Array.of(10, 20, 30);
    const chunkSize = Float32Array.of(4, 4, 8);
    const positionInChunks = Float32Array.of(2, 5, 4);
    const distancePriority = getSpatiallyIndexedSkeletonChunkPriority(
      localCenter,
      chunkSize,
      positionInChunks,
    );
    const equivalentVolumeRenderingPriority =
      basePriority + SCALE_PRIORITY_MULTIPLIER * scaleIndex + distancePriority;
    const skeletonPriority = getSpatiallyIndexedSkeleton3dRenderPriority(
      basePriority,
      scaleIndex,
      localCenter,
      chunkSize,
      positionInChunks,
    );

    expect(skeletonPriority).toBeGreaterThan(
      equivalentVolumeRenderingPriority,
    );
    expect(
      skeletonPriority - equivalentVolumeRenderingPriority,
    ).toBeCloseTo(SPATIALLY_INDEXED_SKELETON_3D_PRIORITY_BOOST);
  });

  it("keeps 3d spatial skeleton chunks ordered by distance after applying the boost", () => {
    const basePriority = BASE_PRIORITY;
    const scaleIndex = 1;
    const localCenter = Float32Array.of(10, 20, 30);
    const chunkSize = Float32Array.of(4, 4, 8);
    const nearChunk = Float32Array.of(2, 5, 4);
    const farChunk = Float32Array.of(5, 1, 0);

    expect(
      getSpatiallyIndexedSkeleton3dRenderPriority(
        basePriority,
        scaleIndex,
        localCenter,
        chunkSize,
        nearChunk,
      ),
    ).toBeGreaterThan(
      getSpatiallyIndexedSkeleton3dRenderPriority(
        basePriority,
        scaleIndex,
        localCenter,
        chunkSize,
        farChunk,
      ),
    );
  });
});

describe("skeleton/backend stale LOD cancellation", () => {
  function makeChunk(state = ChunkState.DOWNLOADING) {
    return {
      state,
      requestGeneration: -1,
      requestOwners: SpatiallyIndexedSkeletonChunkRequestOwner.NONE,
      downloadAbortController: new AbortController(),
    } as any;
  }

  function makeSource(chunk: any) {
    return {
      chunks: new Map([["0,0,0:0", chunk]]),
    } as any;
  }

  function makeChunkManager() {
    return {
      queueManager: {
        updateChunkState: vi.fn(),
      },
    } as any;
  }

  it("tracks both owners within the same recompute generation", () => {
    const chunk = makeChunk();

    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      5,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_2D,
    );
    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      5,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D,
    );

    expect(chunk.requestGeneration).toBe(5);
    expect(chunk.requestOwners).toBe(
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_2D |
        SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D,
    );

    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      6,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D,
    );

    expect(chunk.requestGeneration).toBe(6);
    expect(chunk.requestOwners).toBe(
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D,
    );
  });

  it("aborts stale downloading chunks that were not requested this recompute", () => {
    const chunkManager = makeChunkManager();
    const chunk = makeChunk();
    const source = makeSource(chunk);

    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      4,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_2D,
    );

    cancelStaleSpatiallyIndexedSkeletonDownloads(chunkManager, [source], 5);

    expect(chunk.downloadAbortController).toBeUndefined();
    expect(chunkManager.queueManager.updateChunkState).toHaveBeenCalledWith(
      chunk,
      ChunkState.QUEUED,
    );
  });

  it("keeps downloads requested by 3D in the current recompute", () => {
    const chunkManager = makeChunkManager();
    const chunk = makeChunk();
    const source = makeSource(chunk);

    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      8,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D,
    );

    cancelStaleSpatiallyIndexedSkeletonDownloads(chunkManager, [source], 8);

    expect(chunk.downloadAbortController?.signal.aborted).toBe(false);
    expect(chunkManager.queueManager.updateChunkState).not.toHaveBeenCalled();
  });

  it("keeps downloads requested by 2D in the current recompute", () => {
    const chunkManager = makeChunkManager();
    const chunk = makeChunk();
    const source = makeSource(chunk);

    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      9,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_2D,
    );

    cancelStaleSpatiallyIndexedSkeletonDownloads(chunkManager, [source], 9);

    expect(chunk.downloadAbortController?.signal.aborted).toBe(false);
    expect(chunkManager.queueManager.updateChunkState).not.toHaveBeenCalled();
  });

  it("keeps shared downloads when both owners still request the chunk", () => {
    const chunkManager = makeChunkManager();
    const chunk = makeChunk();
    const source = makeSource(chunk);

    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      11,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_2D,
    );
    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      11,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_3D,
    );

    cancelStaleSpatiallyIndexedSkeletonDownloads(chunkManager, [source], 11);

    expect(chunk.downloadAbortController?.signal.aborted).toBe(false);
    expect(chunkManager.queueManager.updateChunkState).not.toHaveBeenCalled();
  });

  it("does not touch queued chunks that never started downloading", () => {
    const chunkManager = makeChunkManager();
    const chunk = makeChunk(ChunkState.QUEUED);
    const source = makeSource(chunk);

    markSpatiallyIndexedSkeletonChunkRequested(
      chunk,
      2,
      SpatiallyIndexedSkeletonChunkRequestOwner.VIEW_2D,
    );

    cancelStaleSpatiallyIndexedSkeletonDownloads(chunkManager, [source], 3);

    expect(chunk.downloadAbortController?.signal.aborted).toBe(false);
    expect(chunkManager.queueManager.updateChunkState).not.toHaveBeenCalled();
  });
});
