import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RPC } from "#src/worker_rpc.js";
import { makeVoxChunkKey } from "#src/voxel_annotation/base.js";
import { VoxelEditController } from "#src/voxel_annotation/frontend.js";

const mockRpc = {
  get: vi.fn(),
  invoke: vi.fn(),
  newId: () => 0,
  register: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
} as unknown as RPC;

const mockChunkQueueManager = {
  flushPendingChunkUpdates: vi.fn(),
};

// Real chunk source mock: captures the one-shot fresh-chunk listeners so tests
// can simulate the refetched chunk reaching the GPU at a chosen moment.
function createRealSourceMock() {
  const freshChunkListeners = new Map<string, (() => void)[]>();
  return {
    rpcId: 1,
    spec: { chunkDataSize: new Uint32Array([2, 2, 2]) },
    chunkManager: { chunkQueueManager: mockChunkQueueManager },
    invalidateChunks: vi.fn(),
    onNextFreshChunk: vi.fn((key: string, listener: () => void) => {
      const entry = freshChunkListeners.get(key);
      if (entry === undefined) freshChunkListeners.set(key, [listener]);
      else entry.push(listener);
    }),
    // Simulates the fresh chunk arriving on the GPU: fires and drops the
    // armed listeners, like ChunkQueueManager.applyChunkUpdate does.
    fireFreshChunk(key: string) {
      const listeners = freshChunkListeners.get(key) ?? [];
      freshChunkListeners.delete(key);
      for (const listener of listeners) listener();
    },
  };
}

function createOverlaySourceMock() {
  return {
    invalidateChunks: vi.fn(),
  };
}

describe("VoxelEditController.callChunkReload: overlay clear coverage guard", () => {
  let realSources: ReturnType<typeof createRealSourceMock>[];
  let overlaySources: ReturnType<typeof createOverlaySourceMock>[];
  let controller: VoxelEditController;

  beforeEach(() => {
    vi.clearAllMocks();
    realSources = [createRealSourceMock(), createRealSourceMock()];
    overlaySources = [createOverlaySourceMock(), createOverlaySourceMock()];
    const makeMultiscale = (sources: unknown[]) => ({
      rank: 3,
      getSources: () => [
        sources.map((chunkSource) => ({
          chunkSource,
          chunkToMultiscaleTransform: Float32Array.of(
            ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          ),
        })),
      ],
    });
    const host = {
      rpc: mockRpc,
      primarySource: makeMultiscale(realSources),
      previewSource: makeMultiscale(overlaySources),
    };
    controller = new VoxelEditController(host as any);
  });

  it("clears the overlay when the write covers the last dispatched stroke", () => {
    // Stroke previewed on "0,0,0" then dispatched as seq 1.
    controller.notePreviewTouched(["0,0,0"]);
    expect(controller.takeDispatchSeq()).toBe(1);

    // Backend flushes seq 1 and reloads with coveredSeqs = 1.
    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 1 });

    expect(realSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"], {
      lazy: true,
    });
    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();

    realSources[0].fireFreshChunk("0,0,0");
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("skips the clear while a stroke is in progress on the chunk", () => {
    controller.notePreviewTouched(["0,0,0"]);
    controller.takeDispatchSeq(); // seq 1 dispatched

    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 1 });

    // A second stroke is being painted over the same chunk (previewed, not
    // yet dispatched) when the refetch arrives.
    controller.notePreviewTouched(["0,0,0"]);
    realSources[0].fireFreshChunk("0,0,0");

    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();
  });

  it("skips the clear when the write does not cover the last dispatched stroke", () => {
    // Stroke 1 previewed and dispatched (seq 1); stroke 2 touches the same
    // chunk and is dispatched (seq 2) before stroke 1's write lands.
    controller.notePreviewTouched(["0,0,0"]);
    controller.takeDispatchSeq();
    controller.notePreviewTouched(["0,0,0"]);
    controller.takeDispatchSeq();

    // The reload for stroke 1's flush only covers seq 1 < 2.
    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 1 });
    realSources[0].fireFreshChunk("0,0,0");
    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();

    // Stroke 2's own flush covers seq 2: its reload performs the clear.
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 2 });
    realSources[0].fireFreshChunk("0,0,0");
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("skips the clear when a reload carries no coverage but a dispatch touched the chunk", () => {
    // e.g. an undo/redo reload: without echoed coverage it must not clear an
    // overlay that a dispatched-but-unwritten stroke still owns.
    controller.notePreviewTouched(["0,0,0"]);
    controller.takeDispatchSeq();

    controller.callChunkReload([makeVoxChunkKey("0,0,0", 0)], false);
    realSources[0].fireFreshChunk("0,0,0");

    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();
  });

  it("clears without coverage info when no dispatch ever touched the chunk", () => {
    controller.callChunkReload([makeVoxChunkKey("0,0,0", 0)], false);
    realSources[0].fireFreshChunk("0,0,0");
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("guards downsampled-parent reloads with the origin chunk's coverage", () => {
    controller.notePreviewTouched(["1,2,3"]);
    controller.takeDispatchSeq(); // seq 1
    controller.notePreviewTouched(["1,2,3"]);
    controller.takeDispatchSeq(); // seq 2, not yet written

    const parentKey = makeVoxChunkKey("0,0,0", 1);
    const originKey = makeVoxChunkKey("1,2,3", 0);

    // Cascade reload from stroke 1's flush: parent data only covers seq 1.
    controller.callChunkReload(
      [parentKey],
      false,
      { [parentKey]: originKey },
      { [parentKey]: 1 },
    );
    expect(realSources[1].invalidateChunks).toHaveBeenCalledWith(["0,0,0"], {
      lazy: true,
    });
    realSources[1].fireFreshChunk("0,0,0");
    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();

    // Cascade re-run after stroke 2's flush covers seq 2.
    controller.callChunkReload(
      [parentKey],
      false,
      { [parentKey]: originKey },
      { [parentKey]: 2 },
    );
    realSources[1].fireFreshChunk("0,0,0");
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["1,2,3"]);
  });

  it("stale listeners from an earlier flush self-neutralize on a single arrival", () => {
    // Two reloads armed on the same key before any refetch arrives (covered 1
    // then 2). Both listeners fire on the single arrival: the stale one skips
    // (covered 1 < required 2), the up-to-date one clears.
    controller.notePreviewTouched(["0,0,0"]);
    controller.takeDispatchSeq();
    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 1 });

    controller.notePreviewTouched(["0,0,0"]);
    controller.takeDispatchSeq();
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 2 });

    realSources[0].fireFreshChunk("0,0,0");
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledTimes(1);
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("drains the pending chunk-update queue before arming any listener", () => {
    // A refetch predating the write may already sit in the frontend update
    // queue when the reload RPC arrives; it must be applied before the new
    // listener exists, so it can only reach older (coverage-guarded)
    // listeners.
    controller.callChunkReload([makeVoxChunkKey("0,0,0", 0)], false);

    expect(mockChunkQueueManager.flushPendingChunkUpdates).toHaveBeenCalled();
    const flushOrder =
      mockChunkQueueManager.flushPendingChunkUpdates.mock
        .invocationCallOrder[0];
    const armOrder =
      realSources[0].onNextFreshChunk.mock.invocationCallOrder[0];
    expect(flushOrder).toBeLessThan(armOrder);
  });
});
