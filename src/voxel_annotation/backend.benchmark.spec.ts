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

import { describe, it, expect, vi } from "vitest";
import { DataType } from "#src/util/data_type.js";
import { vec3 } from "#src/util/geom.js";
import { VoxelEditController } from "#src/voxel_annotation/backend.js";
import { BrushShape, VoxelOperationType } from "#src/voxel_annotation/base.js";

const mockChunkData = new BigUint64Array(32 * 32 * 32); // 32^3 block
const mockSource = {
  rpcId: 100,
  spec: {
    rank: 3,
    chunkDataSize: new Uint32Array([32, 32, 32]),
    lowerVoxelBound: new Float32Array([0, 0, 0]),
    upperVoxelBound: new Float32Array([1000, 1000, 1000]),
    dataType: DataType.UINT64,
    fillValue: 0n,
  },
  chunks: new Map(),
  getChunk: function () {
    return {
      chunkGridPosition: new Float32Array([0, 0, 0]),
      chunkDataSize: this.spec.chunkDataSize,
      data: mockChunkData,
      state: 2,
    };
  },
  download: async () => {},
  computeChunkBounds: () => {},
};

const mockRpc = {
  get: (id: number) => {
    if (id === 100) return mockSource;
    if (id === 999) return { value: 0 };
    return null;
  },
  invoke: () => {},
  newId: () => 0,
  register: () => {},
  set: () => {},
  promiseInvoke: async () => {},
} as any;

describe("VoxelEditController Performance", () => {
  const controller = new VoxelEditController(mockRpc, {
    resolutions: [
      {
        lodIndex: 0,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        chunkSize: [32, 32, 32],
        sourceRpc: 100,
      },
    ],
    pendingOpCount: 999,
  });

  vi.spyOn(controller, "commitVoxels").mockImplementation(() => {});

  const runStroke = async (
    strokeLength: number,
    radius: number,
    useCache: boolean,
  ) => {
    (controller as any).brushCache.reset();

    const center = new Float32Array(3);
    const basis = { u: vec3.fromValues(1, 0, 0), v: vec3.fromValues(0, 1, 0) };

    for (let i = 0; i < strokeLength; i++) {
      if (!useCache) {
        (controller as any).brushCache.reset();
      }

      center[0] = i;
      center[1] = 0;
      center[2] = 0;

      await (controller as any).performBrush({
        type: VoxelOperationType.BRUSH,
        center: center,
        radius: radius,
        value: 1n,
        shape: BrushShape.SPHERE,
        basis: basis,
      });
    }
  };

  it("Benchmark: Sphere Brush - 20px stroke, radius 32", async () => {
    const STROKE_LENGTH = 20;
    const RADIUS = 32;

    await runStroke(10, RADIUS, true);

    const startNoCache = performance.now();
    await runStroke(STROKE_LENGTH, RADIUS, false);
    const endNoCache = performance.now();

    const startCache = performance.now();
    await runStroke(STROKE_LENGTH, RADIUS, true);
    const endCache = performance.now();

    const timeNoCache = endNoCache - startNoCache;
    const timeCache = endCache - startCache;
    const speedup = timeNoCache / timeCache;

    console.log(`
=================================================
 BRUSH OPTIMIZATION BENCHMARK
 Shape: SPHERE | Length: ${STROKE_LENGTH}px | Radius: ${RADIUS}
=================================================
 No Cache:   ${timeNoCache.toFixed(2)} ms
 With Cache: ${timeCache.toFixed(2)} ms
-------------------------------------------------
 SPEEDUP:    ${speedup.toFixed(2)}x FASTER
=================================================
    `);

    expect(timeCache).toBeLessThan(timeNoCache);
  });

  it("Benchmark: Disk Brush - 200px stroke, radius 64", async () => {
    const STROKE_LENGTH = 200;
    const RADIUS = 64;

    const runDisk = async (useCache: boolean) => {
      (controller as any).brushCache.reset();
      const center = new Float32Array(3);
      const basis = {
        u: vec3.fromValues(1, 0, 0),
        v: vec3.fromValues(0, 1, 0),
      };

      for (let i = 0; i < STROKE_LENGTH; i++) {
        if (!useCache) (controller as any).brushCache.reset();
        center[0] = i;
        center[1] = 0;
        center[2] = 0;
        await (controller as any).performBrush({
          type: VoxelOperationType.BRUSH,
          center: center,
          radius: RADIUS,
          value: 2n,
          shape: BrushShape.DISK,
          basis: basis,
        });
      }
    };

    const startNoCache = performance.now();
    await runDisk(false);
    const endNoCache = performance.now();

    const startCache = performance.now();
    await runDisk(true);
    const endCache = performance.now();

    const timeNoCache = endNoCache - startNoCache;
    const timeCache = endCache - startCache;
    const speedup = timeNoCache / timeCache;

    console.log(`
=================================================
 BRUSH OPTIMIZATION BENCHMARK
 Shape: DISK   | Length: ${STROKE_LENGTH}px | Radius: ${RADIUS}
=================================================
 No Cache:   ${timeNoCache.toFixed(2)} ms
 With Cache: ${timeCache.toFixed(2)} ms
-------------------------------------------------
 SPEEDUP:    ${speedup.toFixed(2)}x FASTER
=================================================
    `);

    expect(timeCache).toBeLessThan(timeNoCache);
  });
});

describe("performBrush Benchmark: Sync vs Async Path", () => {
  const controller = new VoxelEditController(mockRpc, {
    resolutions: [
      {
        lodIndex: 0,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        chunkSize: [32, 32, 32],
        sourceRpc: 100,
      },
    ],
    pendingOpCount: 999,
  });

  vi.spyOn(controller, "commitVoxels").mockImplementation(() => {});

  const RADIUS = 32;

  it("Compares Filter=undefined (Sync) vs Filter=42n (Async)", async () => {
    (controller as any).brushCache.reset();
    const startSync = performance.now();

    await (controller as any).performBrush({
      type: VoxelOperationType.BRUSH,
      center: new Float32Array([100, 100, 100]),
      radius: RADIUS,
      value: 1n,
      shape: BrushShape.SPHERE,
      basis: { u: vec3.fromValues(1, 0, 0), v: vec3.fromValues(0, 1, 0) },
      filterValue: undefined,
    });

    const endSync = performance.now();

    (controller as any).brushCache.reset();
    const startAsync = performance.now();

    await (controller as any).performBrush({
      type: VoxelOperationType.BRUSH,
      center: new Float32Array([200, 200, 200]),
      radius: RADIUS,
      value: 1n,
      shape: BrushShape.SPHERE,
      basis: { u: vec3.fromValues(1, 0, 0), v: vec3.fromValues(0, 1, 0) },
      filterValue: 42n,
    });

    const endAsync = performance.now();

    const timeSync = endSync - startSync;
    const timeAsync = endAsync - startAsync;

    console.log(`
=================================================
 BRUSH BENCHMARK (Radius ${RADIUS})
=================================================
 With Filter (Async Path): ${timeAsync.toFixed(2)} ms
 No Filter (Sync Path):   ${timeSync.toFixed(2)} ms
-------------------------------------------------
 SPEEDUP:           ${(timeAsync / timeSync).toFixed(2)}x FASTER
=================================================
    `);

    expect(timeAsync).toBeGreaterThan(timeSync);
  });
});
