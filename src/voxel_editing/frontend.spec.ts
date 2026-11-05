import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChunkState } from "#src/chunk_manager/base.js";
import { NullarySignal } from "#src/util/signal.js";
import { makeLodChunkKey } from "#src/voxel_editing/base.js";
import { VoxelEditingController } from "#src/voxel_editing/frontend.js";
import type { RPC } from "#src/worker_rpc.js";

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

// Preview source mock mirroring InMemoryVolumeChunkSource's stroke-seq tags:
// a tagged chunk exists, and invalidateChunks deletes it with its tag, like the
// real deleteChunk does.
function createPreviewSourceMock() {
  const previewSeqs = new Map<string, number>();
  const chunks = new Map<string, object>();
  return {
    previewSeqs,
    chunks,
    addChunk: (key: string) => chunks.set(key, {}),
    setPreviewSeq: (key: string, seq: number) => {
      chunks.set(key, {});
      previewSeqs.set(key, seq);
    },
    getPreviewSeq: (key: string) => previewSeqs.get(key) ?? 0,
    keysWithPreviewSeq: (seq: number) =>
      [...previewSeqs.entries()].filter(([, s]) => s === seq).map(([k]) => k),
    clearPreviewSeq: (key: string) => previewSeqs.delete(key),
    invalidateChunks: vi.fn((keys: string[]) => {
      for (const key of keys) {
        previewSeqs.delete(key);
        chunks.delete(key);
      }
    }),
  };
}

describe("VoxelEditingController.callChunkReload: preview swap observation", () => {
  let realSources: ReturnType<typeof createRealSourceMock>[];
  let previewSources: ReturnType<typeof createPreviewSourceMock>[];
  let visibleChunksChanged: NullarySignal;
  let flushPendingChunkUpdates: ReturnType<typeof vi.fn>;
  let controller: VoxelEditingController;

  // With several resolutions, a preview also waits for the downsampling
  // cascade of its origin chunk to complete.
  const createController = (levels: number) => {
    realSources = Array.from({ length: levels }, createRealSourceMock);
    previewSources = Array.from({ length: levels }, createPreviewSourceMock);
    visibleChunksChanged = new NullarySignal();
    flushPendingChunkUpdates = vi.fn();
    const makeMultiscale = (sources: unknown[]) => ({
      rank: 3,
      chunkManager: {
        chunkQueueManager: { visibleChunksChanged, flushPendingChunkUpdates },
      },
      getSources: () => [
        sources.map((chunkSource) => ({
          chunkSource,
          chunkToMultiscaleTransform: Float32Array.of(
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
          ),
        })),
      ],
    });
    const host = {
      rpc: mockRpc,
      primarySource: makeMultiscale(realSources),
      previewSource: makeMultiscale(previewSources),
    };
    controller = new VoxelEditingController(host as any);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    createController(1);
  });

  it("allocates monotonically increasing stroke seqs", () => {
    expect(controller.beginStroke()).toBe(1);
    expect(controller.beginStroke()).toBe(2);
    expect(controller.beginStroke()).toBe(3);
  });

  it("clears the preview once the refetched chunk replaces the stale one on the GPU", () => {
    const seq = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq);
    // The stale chunk is on display when the reload arrives.
    realSources[0].fireFreshChunk("0,0,0");

    const lodChunkKey = makeLodChunkKey("0,0,0", 0);
    controller.callChunkReload([lodChunkKey], false, undefined, {
      [lodChunkKey]: seq,
    });

    expect(realSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"], {
      lazy: true,
    });

    // Signal fires while the stale chunk is still displayed: no clear.
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    // The refetched chunk (a new object) reaches the GPU.
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("waits until the refetched chunk actually reaches the GPU", () => {
    const seq = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq);

    const lodChunkKey = makeLodChunkKey("0,0,0", 0);
    controller.callChunkReload([lodChunkKey], false, undefined, {
      [lodChunkKey]: seq,
    });

    // Refetched data arrived in system memory only: keep the preview.
    realSources[0].fireFreshChunk("0,0,0", ChunkState.SYSTEM_MEMORY);
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    // Promotion to the GPU resolves the swap.
    realSources[0].chunks.get("0,0,0")!.state = ChunkState.GPU_MEMORY;
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("skips the clear when the write does not cover the last stroke", () => {
    controller.beginStroke(); // seq 1, written
    const seq2 = controller.beginStroke(); // seq 2, dispatched but unwritten
    previewSources[0].setPreviewSeq("0,0,0", seq2);

    // The reload for stroke 1's flush only covers seq 1 < 2.
    const lodChunkKey = makeLodChunkKey("0,0,0", 0);
    controller.callChunkReload([lodChunkKey], false, undefined, {
      [lodChunkKey]: 1,
    });
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    // Stroke 2's own flush covers seq 2: its reload performs the clear.
    controller.callChunkReload([lodChunkKey], false, undefined, {
      [lodChunkKey]: 2,
    });
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("reads the tag at swap time: a stroke touching the chunk after arming blocks the clear", () => {
    const seq1 = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq1);

    const lodChunkKey = makeLodChunkKey("0,0,0", 0);
    controller.callChunkReload([lodChunkKey], false, undefined, {
      [lodChunkKey]: seq1,
    });

    // A new stroke's preview touches the chunk before the refetch lands:
    // the arriving data cannot contain it.
    const seq2 = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq2);
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();

    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();
  });

  it("skips the clear when a reload carries no coverage but a stroke tagged the chunk", () => {
    // e.g. an undo/redo reload: without echoed coverage it must not clear an
    // preview that a dispatched-but-unwritten stroke still owns.
    previewSources[0].setPreviewSeq("0,0,0", controller.beginStroke());

    controller.callChunkReload([makeLodChunkKey("0,0,0", 0)], false);
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();

    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();
  });

  it("clears without coverage info when no stroke ever tagged the chunk", () => {
    previewSources[0].addChunk("0,0,0");
    controller.callChunkReload([makeLodChunkKey("0,0,0", 0)], false);
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("guards downsampled-parent reloads with the origin chunk's coverage", () => {
    createController(2);
    controller.beginStroke(); // seq 1, written
    const seq2 = controller.beginStroke(); // seq 2, unwritten
    previewSources[0].setPreviewSeq("1,2,3", seq2);

    const parentKey = makeLodChunkKey("0,0,0", 1);
    const originKey = makeLodChunkKey("1,2,3", 0);

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
    controller.handleCascadeDone(originKey, 1);
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    // Cascade re-run after stroke 2's flush covers seq 2.
    controller.callChunkReload(
      [parentKey],
      false,
      { [parentKey]: originKey },
      { [parentKey]: 2 },
    );
    realSources[1].fireFreshChunk("0,0,0");
    controller.handleCascadeDone(originKey, 2);
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["1,2,3"]);
  });

  it("a rollback reload clears the preview on first arrival regardless of tags", () => {
    // An undone stroke's tag can never be covered by a future write; the
    // rollback purges it so the swap resolves unconditionally.
    previewSources[0].setPreviewSeq("0,0,0", controller.beginStroke());

    const lodChunkKey = makeLodChunkKey("0,0,0", 0);
    controller.callChunkReload(
      [lodChunkKey],
      false,
      undefined,
      undefined,
      true,
    );

    // Not cleared before data arrives: the preview keeps showing the stroke.
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("a newer reload overwrites the pending swap for the same chunk", () => {
    // Two reloads arm before any refetch arrives (covered 1 then 2, tag at
    // 2): only the newest entry remains, so the single arrival clears once,
    // with the newest coverage.
    controller.beginStroke();
    const seq2 = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq2);

    const lodChunkKey = makeLodChunkKey("0,0,0", 0);
    controller.callChunkReload([lodChunkKey], false, undefined, {
      [lodChunkKey]: 1,
    });
    controller.callChunkReload([lodChunkKey], false, undefined, {
      [lodChunkKey]: 2,
    });

    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledTimes(1);
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("applies the chunk updates already received before recording the stale chunk", () => {
    const seq = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq);
    realSources[0].fireFreshChunk("0,0,0");
    // A refetch predating the write is still queued when the reload arrives:
    // it is applied before arming, so it cannot resolve the swap.
    flushPendingChunkUpdates.mockImplementation(() =>
      realSources[0].fireFreshChunk("0,0,0"),
    );

    const lodChunkKey = makeLodChunkKey("0,0,0", 0);
    controller.callChunkReload([lodChunkKey], false, undefined, {
      [lodChunkKey]: seq,
    });
    expect(flushPendingChunkUpdates).toHaveBeenCalled();
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("keeps the preview until the cascade is done, even once the displayed level is fresh", () => {
    // Zoomed in: LOD 0 is on screen, LOD 1 is held from an earlier view.
    createController(2);
    const seq = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq);
    realSources[0].fireFreshChunk("0,0,0");
    realSources[1].fireFreshChunk("0,0,0");

    const originKey = makeLodChunkKey("0,0,0", 0);
    const parentKey = makeLodChunkKey("0,0,0", 1);
    controller.callChunkReload([originKey], false, undefined, {
      [originKey]: seq,
    });
    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    // Zooming out now would show LOD 1 without the stroke.
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    controller.callChunkReload(
      [parentKey],
      false,
      { [parentKey]: originKey },
      { [parentKey]: seq },
    );
    controller.handleCascadeDone(originKey, seq);
    // The cascade wrote LOD 1, but its held copy is still the stale one.
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    realSources[1].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("keeps the preview while a finer held level is still stale", () => {
    createController(2);
    const seq = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq);
    realSources[0].fireFreshChunk("0,0,0");
    realSources[1].fireFreshChunk("0,0,0");

    const originKey = makeLodChunkKey("0,0,0", 0);
    const parentKey = makeLodChunkKey("0,0,0", 1);
    controller.callChunkReload([originKey], false, undefined, {
      [originKey]: seq,
    });
    controller.callChunkReload(
      [parentKey],
      false,
      { [parentKey]: originKey },
      { [parentKey]: seq },
    );
    controller.handleCascadeDone(originKey, seq);

    // The coarser parent arrives first: the stale LOD 0 is still on screen.
    realSources[1].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();

    realSources[0].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("is not held back by a level the frontend does not hold", () => {
    // Zoomed out: LOD 0 is not loaded, LOD 1 is what is on screen.
    createController(2);
    const seq = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq);
    realSources[1].fireFreshChunk("0,0,0");

    const originKey = makeLodChunkKey("0,0,0", 0);
    const parentKey = makeLodChunkKey("0,0,0", 1);
    controller.callChunkReload([originKey], false, undefined, {
      [originKey]: seq,
    });
    controller.callChunkReload(
      [parentKey],
      false,
      { [parentKey]: originKey },
      { [parentKey]: seq },
    );
    controller.handleCascadeDone(originKey, seq);

    realSources[1].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("clears every origin written into the same parent", () => {
    createController(2);
    const seq = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq);
    previewSources[0].setPreviewSeq("1,0,0", seq);
    realSources[1].fireFreshChunk("0,0,0");

    const parentKey = makeLodChunkKey("0,0,0", 1);
    for (const origin of ["0,0,0", "1,0,0"]) {
      controller.callChunkReload(
        [parentKey],
        false,
        { [parentKey]: makeLodChunkKey(origin, 0) },
        { [parentKey]: seq },
      );
      controller.handleCascadeDone(makeLodChunkKey(origin, 0), seq);
    }

    realSources[1].fireFreshChunk("0,0,0");
    visibleChunksChanged.dispatch();
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["0,0,0"]);
    expect(previewSources[0].invalidateChunks).toHaveBeenCalledWith(["1,0,0"]);
  });

  it("rollbackStroke drops exactly the preview chunks tagged by that stroke", () => {
    const seq1 = controller.beginStroke();
    previewSources[0].setPreviewSeq("0,0,0", seq1);
    const seq2 = controller.beginStroke();
    previewSources[0].setPreviewSeq("1,0,0", seq2);
    previewSources[0].setPreviewSeq("2,0,0", seq2);

    controller.rollbackStroke(seq2);

    expect(previewSources[0].invalidateChunks).toHaveBeenCalledTimes(1);
    const [rolledBack] = previewSources[0].invalidateChunks.mock.calls[0];
    expect([...rolledBack].sort()).toEqual(["1,0,0", "2,0,0"]);
    // The other stroke's chunk is untouched and still tagged.
    expect(previewSources[0].getPreviewSeq("0,0,0")).toBe(seq1);
  });

  it("rollbackStroke with no tagged chunks is a no-op", () => {
    const seq = controller.beginStroke();
    controller.rollbackStroke(seq);
    expect(previewSources[0].invalidateChunks).not.toHaveBeenCalled();
  });
});
