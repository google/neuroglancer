/**
 * @license
 * Copyright 2025 Google Inc.
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

import { describe, bench, vi } from "vitest";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { DataType, DATA_TYPE_ARRAY_CONSTRUCTOR } from "#src/util/data_type.js";
import { vec3 } from "#src/util/geom.js";
import { VoxelEditController } from "#src/voxel_annotation/backend.js";
import {
  BrushShape,
  VoxelOperationType,
  makeVoxChunkKey,
} from "#src/voxel_annotation/base.js";

const NETWORK_LATENCY = 0;
class RealisticInMemorySource extends VolumeChunkSource {
  public storage = new Map<string, Uint32Array | BigUint64Array>();

  async download(chunk: VolumeChunk) {
    if (NETWORK_LATENCY)
      await new Promise((resolve) => setTimeout(resolve, NETWORK_LATENCY));

    if (!chunk.chunkDataSize) {
      this.computeChunkBounds(chunk);
    }

    const numElements = chunk.chunkDataSize!.reduce((a, b) => a * b, 1);
    const Ctor = DATA_TYPE_ARRAY_CONSTRUCTOR[this.spec.dataType];
    const key = chunk.chunkGridPosition.join(",");

    if (this.storage.has(key)) {
      chunk.data = new (Ctor as any)(this.storage.get(key)!);
    } else {
      chunk.data = new (Ctor as any)(numElements);
    }
  }

  async writeChunk(chunk: VolumeChunk) {
    if (NETWORK_LATENCY)
      await new Promise((resolve) => setTimeout(resolve, NETWORK_LATENCY));

    const key = chunk.chunkGridPosition.join(",");
    const Ctor = DATA_TYPE_ARRAY_CONSTRUCTOR[this.spec.dataType];
    if (chunk.data) {
      this.storage.set(key, new (Ctor as any)(chunk.data));
    }
  }
}

const createResConfig = (lod: number, chunkSize: number) => ({
  lodIndex: lod,
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  chunkSize: [chunkSize, chunkSize, chunkSize],
  sourceRpc: 100 + lod,
});

const CHUNK_SIZE = 64;

const spec = {
  rank: 3,
  chunkDataSize: new Uint32Array([CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE]),
  dataType: DataType.UINT64,
  lowerVoxelBound: new Float32Array([0, 0, 0]),
  upperVoxelBound: new Float32Array([10000, 10000, 10000]),
  baseVoxelOffset: new Float32Array([0, 0, 0]),
  fillValue: 0n,
};

const mockChunkQueueManager = { sources: new Set() };
const mockChunkManager = {
  queueManager: mockChunkQueueManager,
  memoize: { get: (_k: string, f: Function) => f() },
};

// Forward-declare so the rpcHandler closure can reference it before assignment.
let mockSource0: RealisticInMemorySource;

const rpcHandler = {
  get: (id: number) => {
    if (id === 0) return mockChunkManager;
    if (id === 100) return mockSource0;
    if (id === 999) return { value: 0 };
    return null;
  },
  invoke: () => {},
  newId: () => 0,
  register: () => {},
  set: () => {},
  promiseInvoke: async () => {},
} as any;

mockSource0 = new RealisticInMemorySource(rpcHandler, {
  spec,
  chunkManager: 0,
});

const controller = new VoxelEditController(rpcHandler, {
  resolutions: [createResConfig(0, CHUNK_SIZE)],
  pendingOpCount: 999,
});

vi.spyOn(controller as any, "enqueueDownsample").mockImplementation(() => {});

// Pre-populate the downsample chunk with worst-case data once.
const _initChunk = mockSource0.getChunk(new Float32Array([0, 0, 0])) as VolumeChunk;
await mockSource0.download(_initChunk);
const _initData = _initChunk.data as BigUint64Array;
for (let i = 0; i < _initData.length; i++) {
  _initData[i] = BigInt(i % 5);
}

// --------------------------------------------------------------------------
// 1. SYSTEM OVERHEAD (Commit)
// --------------------------------------------------------------------------

describe("Commit", () => {
  const voxelsCounts = [1000, 10000, 100000];
  const numOfEdits = [1, 10, 50];

  for (const numOfEdit of numOfEdits) {
    for (const count of voxelsCounts) {
      // Pre-compute data at collection time, not during the bench run.
      const indices = new Uint32Array(count);
      const values = new BigUint64Array(count);
      for (let i = 0; i < count; i++) {
        indices[i] = i;
        values[i] = BigInt(i);
      }
      const edits = [{ key: "lod0#0,0,0", indices, values }];
      for (let i = 1; i < numOfEdit; i++)
        edits.push({ key: `lod0#0,0,${i}`, indices, values });

      bench(`voxels=${count} edits=${numOfEdit}`, async () => {
        (controller as any).pendingEdits.push(...edits);
        await (controller as any).flushPending();
      });
    }
  }
});

// --------------------------------------------------------------------------
// 2. DOWNSAMPLING
// --------------------------------------------------------------------------

describe("Downsample", () => {
  bench(`inputVoxels=${CHUNK_SIZE ** 3}`, async () => {
    await (controller as any).downsampleStep(makeVoxChunkKey("0,0,0", 0));
  });
});

// --------------------------------------------------------------------------
// 3. BRUSH STROKES
// --------------------------------------------------------------------------

const STROKE_LEN = 20;
const runStroke = async (
  shape: BrushShape,
  radius: number,
  useFilter: boolean,
) => {
  (controller as any).brushCache.reset();
  const center = new Float32Array(3);
  const basis = { u: vec3.fromValues(1, 0, 0), v: vec3.fromValues(0, 1, 0) };

  if (useFilter) {
    const chunk = mockSource0.getChunk(
      new Float32Array([0, 0, 0]),
    ) as VolumeChunk;
    if (!chunk.data) await mockSource0.download(chunk);
  }
  const filterVal = useFilter ? 999n : undefined;

  for (let i = 0; i < STROKE_LEN; i++) {
    center[0] = 30 + i;
    center[1] = 30;
    center[2] = 30;

    await (controller as any).performBrush({
      type: VoxelOperationType.BRUSH,
      center,
      radius,
      value: 1n,
      shape,
      basis,
      filterValue: filterVal,
    });
  }
};

describe("Brush SPHERE", () => {
  for (const r of [4, 8, 12, 16, 20, 24, 28, 32]) {
    bench(`r=${r} no filter`, async () => {
      await runStroke(BrushShape.SPHERE, r, false);
    });

    bench(`r=${r} with filter`, async () => {
      await runStroke(BrushShape.SPHERE, r, true);
    });
  }
});

describe("Brush DISK", () => {
  for (const r of [16, 24, 32, 40, 48, 56, 64]) {
    bench(`r=${r} no filter`, async () => {
      await runStroke(BrushShape.DISK, r, false);
    });

    bench(`r=${r} with filter`, async () => {
      await runStroke(BrushShape.DISK, r, true);
    });
  }
});

// --------------------------------------------------------------------------
// 4. FLOOD FILL
// --------------------------------------------------------------------------

describe("FloodFill", () => {
  for (const size of [1000, 5000, 10000, 25000, 50000]) {
    bench(`maxVoxels=${size}`, async () => {
      // Reset chunk data each iteration so the flood fill always starts clean.
      const chunk = mockSource0.getChunk(
        new Float32Array([0, 0, 0]),
      ) as VolumeChunk;
      (chunk.data as BigUint64Array).fill(0n);

      try {
        await (controller as any).performFloodFill({
          type: VoxelOperationType.FLOOD_FILL,
          seed: new Float32Array([32, 32, 32]),
          value: 1n,
          maxVoxels: size,
          basis: { u: vec3.fromValues(1, 0, 0), v: vec3.fromValues(0, 1, 0) },
        });
      } catch (e: any) {
        if (!e.message.includes("too many voxels")) throw e;
      }
    });
  }
});

// --------------------------------------------------------------------------
// 5. UNDO
// Each iteration performs the setup (pushing to the undo stack) and the undo
// itself, so reported timings include both. The setup cost is minimal
// compared to the undo write-back.
// --------------------------------------------------------------------------

describe("Undo (chunks)", () => {
  for (const count of [1, 10, 50, 100]) {
    bench(`chunks=${count}`, async () => {
      const changes = new Map();
      for (let i = 0; i < count; i++) {
        const chunk = mockSource0.getChunk(
          new Float32Array([i, 0, 0]),
        ) as VolumeChunk;
        if (!chunk.data) await mockSource0.download(chunk);
        changes.set(`lod0#${i},0,0`, {
          indices: new Uint32Array([0]),
          oldValues: new BigUint64Array([1n]),
          newValues: new BigUint64Array([2n]),
        });
      }
      (controller as any).undoStack.push({
        changes,
        timestamp: 0,
        description: "bench",
      });
      await controller.undo();
    });
  }
});

describe("Undo (voxels, 1 chunk)", () => {
  for (const count of [1000, 10000, 100000]) {
    const indices = new Uint32Array(count);
    const vals = new BigUint64Array(count).fill(1n);

    bench(`voxels=${count}`, async () => {
      const chunk = mockSource0.getChunk(
        new Float32Array([0, 0, 0]),
      ) as VolumeChunk;
      if (!chunk.data) await mockSource0.download(chunk);

      (controller as any).undoStack.push({
        changes: new Map([
          [`lod0#0,0,0`, { indices, oldValues: vals, newValues: vals }],
        ]),
        timestamp: 0,
        description: "bench",
      });
      await controller.undo();
    });
  }
});
