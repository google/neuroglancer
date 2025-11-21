import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { DataType } from "#src/util/data_type.js";

class MockChunk {
  data: any = null;
  chunkDataSize: Uint32Array;
  chunkGridPosition: Float32Array;
  state = 0;

  constructor(
    public source: any,
    x: any,
  ) {
    this.chunkGridPosition = x.chunkGridPosition;
    this.chunkDataSize = source.spec.chunkDataSize;
  }

  initializeVolumeChunk() {}
  dispose() {}

  updateFromCpuData = vi.fn();
}

vi.mock("#src/sliceview/volume/registry.js", () => ({
  getChunkFormatHandler: () => ({
    chunkFormat: {
      dataType: 0,
    },
    getChunk: (source: any, x: any) => {
      return new MockChunk(source, x);
    },
    dispose: () => {},
  }),
}));

describe("InMemoryVolumeChunkSource", () => {
  let InMemoryVolumeChunkSource: any;
  let chunkManagerMock: any;
  let glMock: any;
  let visibleChunksChangedMock: any;

  beforeAll(async () => {
    if (typeof WebGL2RenderingContext === "undefined") {
      global.WebGL2RenderingContext = class {
        static VERTEX_SHADER = 35633;
        static FRAGMENT_SHADER = 35632;
        static ARRAY_BUFFER = 34962;
        static STATIC_DRAW = 35044;
        static TEXTURE_2D = 3553;
        static TEXTURE_3D = 32879;
      } as any;
    }
    if (typeof WebGLTexture === "undefined") {
      global.WebGLTexture = class {} as any;
    }

    const mod = await import("#src/sliceview/volume/frontend.js");
    InMemoryVolumeChunkSource = mod.InMemoryVolumeChunkSource;
  });

  beforeEach(() => {
    glMock = { name: "mockGL" };
    visibleChunksChangedMock = { dispatch: vi.fn() };
    chunkManagerMock = {
      chunkQueueManager: {
        gl: glMock,
        visibleChunksChanged: visibleChunksChangedMock,
        sources: { add: () => {}, delete: () => {} },
      },
      rpc: {
        newId: () => 0,
        invoke: () => {},
        register: () => {},
        delete: () => {},
        get: () => {},
        set: () => {},
      },
    };
  });

  const createSource = (dataType: DataType) => {
    const spec: any = {
      rank: 3,
      chunkDataSize: Uint32Array.from([2, 2, 2]),
      dataType,
      upperVoxelBound: Float32Array.from([10, 10, 10]),
      lowerVoxelBound: Float32Array.from([0, 0, 0]),
      baseVoxelOffset: Float32Array.from([0, 0, 0]),
    };
    return new InMemoryVolumeChunkSource(chunkManagerMock, { spec });
  };

  it("Lazy Creation: creates a chunk if it does not exist", () => {
    const source = createSource(DataType.UINT64);
    const edits = new Map();
    edits.set("0,0,0", { indices: [0], value: 123n });

    expect(source.chunks.size).toBe(0);
    source.applyLocalEdits(edits);
    expect(source.chunks.size).toBe(1);
    expect(source.chunks.has("0,0,0")).toBe(true);
  });

  it("Lazy Allocation: allocates data buffer if null", () => {
    const source = createSource(DataType.UINT64);
    const edits = new Map();
    edits.set("0,0,0", { indices: [0], value: 123n });

    source.applyLocalEdits(edits);
    const chunk = source.chunks.get("0,0,0") as unknown as MockChunk;
    expect(chunk.data).toBeInstanceOf(BigUint64Array);
    expect(chunk.data).toHaveLength(8); // 2*2*2
    expect(chunk.data[0]).toBe(123n);
  });

  it("Data Type Handling: UINT32", () => {
    const source = createSource(DataType.UINT32);
    const edits = new Map();
    edits.set("0,0,0", { indices: [1], value: 456n });

    source.applyLocalEdits(edits);
    const chunk = source.chunks.get("0,0,0") as unknown as MockChunk;
    expect(chunk.data).toBeInstanceOf(Uint32Array);
    expect(chunk.data[1]).toBe(456);
  });

  it("Data Type Handling: UINT8", () => {
    const source = createSource(DataType.UINT8);
    const edits = new Map();
    edits.set("0,0,0", { indices: [2], value: 255n });

    source.applyLocalEdits(edits);
    const chunk = source.chunks.get("0,0,0") as unknown as MockChunk;
    expect(chunk.data).toBeInstanceOf(Uint8Array);
    expect(chunk.data[2]).toBe(255);
  });

  it("GPU Trigger: calls updateFromCpuData and dispatches change", () => {
    const source = createSource(DataType.UINT64);
    const edits = new Map();
    edits.set("0,0,0", { indices: [0], value: 123n });

    source.applyLocalEdits(edits);
    const chunk = source.chunks.get("0,0,0") as unknown as MockChunk;

    expect(chunk.updateFromCpuData).toHaveBeenCalledWith(glMock);
    expect(visibleChunksChangedMock.dispatch).toHaveBeenCalled();
  });

  it("Updates existing chunk data", () => {
    const source = createSource(DataType.UINT64);
    source.applyLocalEdits(new Map([["0,0,0", { indices: [0], value: 123n }]]));

    const chunk = source.chunks.get("0,0,0") as unknown as MockChunk;
    chunk.updateFromCpuData.mockClear();
    visibleChunksChangedMock.dispatch.mockClear();

    source.applyLocalEdits(new Map([["0,0,0", { indices: [0], value: 456n }]]));

    expect(chunk.data[0]).toBe(456n);
    expect(chunk.updateFromCpuData).toHaveBeenCalledWith(glMock);
    expect(visibleChunksChangedMock.dispatch).toHaveBeenCalled();
  });
});
