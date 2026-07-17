import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChunkState } from "#src/chunk_manager/base.js";
import { NullarySignal } from "#src/util/signal.js";
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

// Real chunk source mock: `fireFreshChunk` replaces the chunk with a new
// object in GPU_MEMORY state, like applyChunkUpdate does for an `update.new`
// followed by its GPU promotion.
function createRealSourceMock() {
  return {
    rpcId: 1,
    spec: { chunkDataSize: new Uint32Array([2, 2, 2]) },
    chunks: new Map<string, { state: ChunkState }>(),
    invalidateChunks: vi.fn(),
    fireFreshChunk(key: string, state = ChunkState.GPU_MEMORY) {
      this.chunks.set(key, { state });
    },
  };
}

// Overlay source mock mirroring InMemoryVolumeChunkSource's stroke-seq tags:
// invalidateChunks purges the tag, like the real deleteChunk does.
function createOverlaySourceMock() {
  const overlaySeqs = new Map<string, number>();
  return {
    overlaySeqs,
    setOverlaySeq: (key: string, seq: number) => overlaySeqs.set(key, seq),
    getOverlaySeq: (key: string) => overlaySeqs.get(key) ?? 0,
    keysWithOverlaySeq: (seq: number) =>
      [...overlaySeqs.entries()].filter(([, s]) => s === seq).map(([k]) => k),
    invalidateChunks: vi.fn((keys: string[]) => {
      for (const key of keys) overlaySeqs.delete(key);
    }),
  };
}

describe("VoxelEditController.callChunkReload: overlay swap observation", () => {
  let realSources: ReturnType<typeof createRealSourceMock>[];
  let overlaySources: ReturnType<typeof createOverlaySourceMock>[];
  let visibleChunksChanged: NullarySignal;
  let controller: VoxelEditController;

  beforeEach(() => {
    vi.clearAllMocks();
    realSources = [createRealSourceMock(), createRealSourceMock()];
    overlaySources = [createOverlaySourceMock(), createOverlaySourceMock()];
    visibleChunksChanged = new NullarySignal();
    const makeMultiscale = (sources: unknown[]) => ({
      rank: 3,
      chunkManager: { chunkQueueManager: { visibleChunksChanged } },
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

  it("allocates monotonically increasing stroke seqs", () => {
    expect(controller.beginStroke()).toBe(1);
    expect(controller.beginStroke()).toBe(2);
    expect(controller.beginStroke()).toBe(3);
  });

  it("clears the overlay once the refetched chunk replaces the stale one on the GPU", () => {
    const seq = controller.beginStroke();
    overlaySources[0].setOverlaySeq("0,0,0", seq);
    // The stale chunk is on display when the reload arrives.
    realSources[0].fireFreshChunk("0,0,0");

    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: seq });

    expect(realSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"], {
      lazy: true,
    });

    // Signal fires while the stale chunk is still displayed: no clear.
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();

    // The refetched chunk (a new object) reaches the GPU.
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("waits until the refetched chunk actually reaches the GPU", () => {
    const seq = controller.beginStroke();
    overlaySources[0].setOverlaySeq("0,0,0", seq);

    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: seq });

    // Refetched data arrived in system memory only: keep the overlay.
    realSources[0].fireFreshChunk("0,0,0", ChunkState.SYSTEM_MEMORY);
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();

    // Promotion to the GPU resolves the swap.
    realSources[0].chunks.get("0,0,0")!.state = ChunkState.GPU_MEMORY;
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("skips the clear when the write does not cover the last stroke", () => {
    controller.beginStroke(); // seq 1, written
    const seq2 = controller.beginStroke(); // seq 2, dispatched but unwritten
    overlaySources[0].setOverlaySeq("0,0,0", seq2);

    // The reload for stroke 1's flush only covers seq 1 < 2.
    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 1 });
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();

    // Stroke 2's own flush covers seq 2: its reload performs the clear.
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 2 });
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("reads the tag at swap time: a stroke touching the chunk after arming blocks the clear", () => {
    const seq1 = controller.beginStroke();
    overlaySources[0].setOverlaySeq("0,0,0", seq1);

    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: seq1 });

    // A new stroke's preview touches the chunk before the refetch lands:
    // the arriving data cannot contain it.
    const seq2 = controller.beginStroke();
    overlaySources[0].setOverlaySeq("0,0,0", seq2);
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();

    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();
  });

  it("skips the clear when a reload carries no coverage but a stroke tagged the chunk", () => {
    // e.g. an undo/redo reload: without echoed coverage it must not clear an
    // overlay that a dispatched-but-unwritten stroke still owns.
    overlaySources[0].setOverlaySeq("0,0,0", controller.beginStroke());

    controller.callChunkReload([makeVoxChunkKey("0,0,0", 0)], false);
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();

    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();
  });

  it("clears without coverage info when no stroke ever tagged the chunk", () => {
    controller.callChunkReload([makeVoxChunkKey("0,0,0", 0)], false);
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("guards downsampled-parent reloads with the origin chunk's coverage", () => {
    controller.beginStroke(); // seq 1, written
    const seq2 = controller.beginStroke(); // seq 2, unwritten
    overlaySources[0].setOverlaySeq("1,2,3", seq2);

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
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();

    // Cascade re-run after stroke 2's flush covers seq 2.
    controller.callChunkReload(
      [parentKey],
      false,
      { [parentKey]: originKey },
      { [parentKey]: 2 },
    );
    realSources[1].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["1,2,3"]);
  });

  it("a newer reload overwrites the pending swap for the same chunk", () => {
    // Two reloads arm before any refetch arrives (covered 1 then 2, tag at
    // 2): only the newest entry remains, so the single arrival clears once,
    // with the newest coverage.
    controller.beginStroke();
    const seq2 = controller.beginStroke();
    overlaySources[0].setOverlaySeq("0,0,0", seq2);

    const voxKey = makeVoxChunkKey("0,0,0", 0);
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 1 });
    controller.callChunkReload([voxKey], false, undefined, { [voxKey]: 2 });

    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    visibleChunksChanged.dispatch();
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledTimes(1);
    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("rollbackStroke drops exactly the overlay chunks tagged by that stroke", () => {
    const seq1 = controller.beginStroke();
    overlaySources[0].setOverlaySeq("0,0,0", seq1);
    const seq2 = controller.beginStroke();
    overlaySources[0].setOverlaySeq("1,0,0", seq2);
    overlaySources[0].setOverlaySeq("2,0,0", seq2);

    controller.rollbackStroke(seq2);

    expect(overlaySources[0].invalidateChunks).toHaveBeenCalledTimes(1);
    const [rolledBack] = overlaySources[0].invalidateChunks.mock.calls[0];
    expect([...rolledBack].sort()).toEqual(["1,0,0", "2,0,0"]);
    // The other stroke's chunk is untouched and still tagged.
    expect(overlaySources[0].getOverlaySeq("0,0,0")).toBe(seq1);
  });

  it("rollbackStroke with no tagged chunks is a no-op", () => {
    const seq = controller.beginStroke();
    controller.rollbackStroke(seq);
    expect(overlaySources[0].invalidateChunks).not.toHaveBeenCalled();
  });
});
