import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChunkSource } from "#src/chunk_manager/frontend.js";

describe("ChunkSource fresh-chunk listeners: receipt-seq causality", () => {
  let chunkQueueManager: { chunkUpdateReceiptSeq: number };
  let source: ChunkSource;

  beforeEach(() => {
    chunkQueueManager = { chunkUpdateReceiptSeq: 0 };
    source = new ChunkSource({ chunkQueueManager } as any);
  });

  it("fires a listener only for data received after it was armed", () => {
    // An update is received (and possibly still queued), then the listener is
    // armed: that update's data must not trigger it.
    const staleReceipt = ++chunkQueueManager.chunkUpdateReceiptSeq;
    const listener = vi.fn();
    source.onNextFreshChunk("0,0,0", listener);

    source.fireFreshChunkListeners("0,0,0", staleReceipt);
    expect(listener).not.toHaveBeenCalled();

    // A refetch received after arming fires it.
    const freshReceipt = ++chunkQueueManager.chunkUpdateReceiptSeq;
    source.fireFreshChunkListeners("0,0,0", freshReceipt);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("partitions listeners: pre-arming data fires old listeners, keeps new ones armed", () => {
    const oldListener = vi.fn();
    source.onNextFreshChunk("0,0,0", oldListener);

    // Data received between the two armings.
    const receipt = ++chunkQueueManager.chunkUpdateReceiptSeq;
    const newListener = vi.fn();
    source.onNextFreshChunk("0,0,0", newListener);

    source.fireFreshChunkListeners("0,0,0", receipt);
    expect(oldListener).toHaveBeenCalledTimes(1);
    expect(newListener).not.toHaveBeenCalled();

    // The kept listener fires on the next, newer arrival.
    const nextReceipt = ++chunkQueueManager.chunkUpdateReceiptSeq;
    source.fireFreshChunkListeners("0,0,0", nextReceipt);
    expect(newListener).toHaveBeenCalledTimes(1);
    expect(oldListener).toHaveBeenCalledTimes(1);
  });

  it("fired listeners are one-shot; keys with no remaining listeners are dropped", () => {
    const listener = vi.fn();
    source.onNextFreshChunk("0,0,0", listener);

    const receipt = ++chunkQueueManager.chunkUpdateReceiptSeq;
    source.fireFreshChunkListeners("0,0,0", receipt);
    source.fireFreshChunkListeners("0,0,0", receipt);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.freshChunkListeners?.has("0,0,0")).toBe(false);
  });

  it("deleteChunk drops the key's listeners and pending-GPU entry", () => {
    source.onNextFreshChunk("0,0,0", vi.fn());
    (source.pendingFreshChunkGpu ??= new Map()).set("0,0,0", 1);
    // A resident chunk below GPU_MEMORY state, so deleteChunk needs no GL.
    source.chunks.set("0,0,0", { state: 1, dispose: () => {} } as any);

    source.deleteChunk("0,0,0");

    expect(source.freshChunkListeners?.has("0,0,0")).toBe(false);
    expect(source.pendingFreshChunkGpu?.has("0,0,0")).toBe(false);
  });
});
