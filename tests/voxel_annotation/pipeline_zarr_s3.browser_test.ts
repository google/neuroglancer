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

import "#src/datasource/zarr/register_default.js";
import "#src/kvstore/s3/register_frontend.js";
import "#src/sliceview/uncompressed_chunk_format.js";
import "#src/layer/segmentation/index.js";
import "#src/layer/image/index.js";

import { http, HttpResponse } from "msw";
import { test, beforeEach, afterEach } from "vitest";
import { DisplayContext } from "#src/display_context.js";
import { makeLayer } from "#src/layer/index.js";
import type {
  VoxelEditingContext,
  UserLayerWithVoxelEditing,
} from "#src/layer/vox/index.js";
import { vec3 } from "#src/util/geom.js";
import { Viewer } from "#src/viewer.js";
import { mswFixture } from "#tests/fixtures/msw";

const msw = mswFixture();
let viewer: Viewer | undefined;
const storage = new Map<string, ArrayBuffer>();
const baseUrl = "http://localhost:9000";

beforeEach(async () => {
  storage.clear();
  const display = new DisplayContext(document.createElement("div"));
  viewer = new Viewer(display, {
    showLayerDialog: false,
    resetStateWhenEmpty: false,
  });

  (await msw()).use(
    http.put(`${baseUrl}/*`, async ({ request }) => {
      const parsed = parseBucketKey(request.url);
      if (!parsed) return new HttpResponse(null, { status: 400 });
      const storageKey = `${parsed.bucket}/${parsed.key}`;
      const buffer = await request.arrayBuffer();
      storage.set(storageKey, buffer);
      return new HttpResponse(null, { status: 200 });
    }),
    http.get(`${baseUrl}/*`, ({ request }) => {
      const parsed = parseBucketKey(request.url);
      const storageKey = parsed ? `${parsed.bucket}/${parsed.key}` : "";
      const data = storage.get(storageKey);
      if (!data) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(data);
    }),
    http.head(`${baseUrl}/*`, ({ request }) => {
      const parsed = parseBucketKey(request.url);
      const storageKey = parsed ? `${parsed.bucket}/${parsed.key}` : "";
      const data = storage.get(storageKey);
      if (!data) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(null, {
        status: 200,
        headers: {
          "Content-Length": data.byteLength.toString(),
        },
      });
    }),
  );
});

afterEach(() => {
  if (viewer) {
    viewer.dispose();
    viewer = undefined;
  }
});

async function poll(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeout = 5000,
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timeout polling condition: " + what);
}

function parseBucketKey(
  urlStr: string,
): { bucket: string; key: string } | null {
  const url = new URL(urlStr);
  const path = url.pathname.slice(1);
  const parts = path.split("/");
  if (parts.length < 2) return null;
  return { bucket: parts[0], key: parts.slice(1).join("/") };
}

async function waitForEditingContext() {
  if (!viewer) throw new Error("Viewer not initialized");
  await poll(() => {
    const userLayer = viewer!.layerManager.managedLayers[0]
      ?.layer as UserLayerWithVoxelEditing;
    return userLayer?.editingContexts?.size > 0;
  }, "Wait for Editing Context");
  const userLayer = viewer.layerManager.managedLayers[0]
    .layer as UserLayerWithVoxelEditing;
  const context = userLayer.editingContexts.values().next()
    .value as VoxelEditingContext;
  (context as any).hasUserConfirmedWriting = true;
  return { userLayer, context };
}

test("Pipeline: Zarr V2 (UINT8) Undo/Redo with Brush", async () => {
  const BUCKET = "test-v2-uint8";
  const zarray = JSON.stringify({
    zarr_format: 2,
    shape: [64, 64, 64],
    chunks: [32, 32, 32],
    dtype: "|u1",
    fill_value: 0,
    order: "C",
    dimension_separator: ".",
    compressor: null,
  });
  storage.set(
    `${BUCKET}/data.zarr/.zarray`,
    <ArrayBuffer>new TextEncoder().encode(zarray).buffer,
  );
  storage.set(
    `${BUCKET}/data.zarr/.zgroup`,
    <ArrayBuffer>new TextEncoder().encode("{}").buffer,
  );

  const layer = makeLayer(viewer!.layerSpecification, "volume", {
    type: "image",
    source: {
      url: `s3+http://localhost:9000/${BUCKET}/data.zarr`,
      subsources: { default: { enabled: true, writable: true } },
      enableDefaultSubsources: false,
    },
  });
  viewer!.layerSpecification.add(layer);

  const { context } = await waitForEditingContext();

  const center = new Float32Array([16, 16, 16]);
  await context.paintBrushWithShape(center, 5, 100n, 0 /* DISK */, {
    u: new Float32Array([1, 0, 0]),
    v: new Float32Array([0, 1, 0]),
  });

  const chunkKey = `${BUCKET}/data.zarr/0.0.0`;

  await poll(() => {
    const data = storage.get(chunkKey);
    if (!data) return false;
    const arr = new Uint8Array(data);
    return arr.some((v) => v === 100);
  }, "Verify painted chunk");

  await context.undo();
  await poll(() => {
    const data = storage.get(chunkKey);
    if (!data) return true;
    return new Uint8Array(data).every((v) => v === 0);
  }, "Verify undo");

  await context.redo();
  await poll(() => {
    const data = storage.get(chunkKey);
    if (!data) return false;
    return new Uint8Array(data).some((v) => v === 100);
  }, "Verify redo");
});

test("Pipeline: Zarr V3 (UINT64) Brush", async () => {
  const BUCKET = "test-v3-uint64";
  const zarrJson = JSON.stringify({
    zarr_format: 3,
    node_type: "array",
    shape: [64, 64, 64],
    data_type: "uint64",
    chunk_grid: {
      name: "regular",
      configuration: { chunk_shape: [32, 32, 32] },
    },
    chunk_key_encoding: {
      name: "default",
      configuration: { separator: "/" },
    },
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: 0,
    attributes: {},
  });

  storage.set(
    `${BUCKET}/data.zarr/zarr.json`,
    <ArrayBuffer>new TextEncoder().encode(zarrJson).buffer,
  );

  const layer = makeLayer(viewer!.layerSpecification, "volume", {
    type: "segmentation",
    source: {
      url: `s3+http://localhost:9000/${BUCKET}/data.zarr|zarr3:`,
      subsources: { default: { enabled: true, writable: true } },
      enableDefaultSubsources: false,
    },
  });
  viewer!.layerSpecification.add(layer);

  const { context } = await waitForEditingContext();

  const center = new Float32Array([16, 16, 16]);
  const paintVal = 123456789n;
  await context.paintBrushWithShape(center, 2, paintVal, 0 /* DISK */, {
    u: new Float32Array([1, 0, 0]),
    v: new Float32Array([0, 1, 0]),
  });

  const chunkKey = `${BUCKET}/data.zarr/c/0/0/0`;

  await poll(() => {
    const data = storage.get(chunkKey);
    if (!data) return false;
    const arr = new BigUint64Array(data);
    return arr.some((v) => v === paintVal);
  }, "Verify painted chunk (UINT64)");
});

test("Pipeline: Zarr V2 (UINT32) with Slash Separator", async () => {
  const BUCKET = "test-v2-sep";
  const zarray = JSON.stringify({
    zarr_format: 2,
    shape: [64, 64, 64],
    chunks: [32, 32, 32],
    dtype: "<u4",
    fill_value: 0,
    order: "C",
    dimension_separator: "/",
    compressor: null,
  });
  storage.set(
    `${BUCKET}/data.zarr/.zarray`,
    <ArrayBuffer>new TextEncoder().encode(zarray).buffer,
  );
  storage.set(
    `${BUCKET}/data.zarr/.zgroup`,
    <ArrayBuffer>new TextEncoder().encode("{}").buffer,
  );

  const layer = makeLayer(viewer!.layerSpecification, "volume", {
    type: "segmentation",
    source: {
      url: `s3+http://localhost:9000/${BUCKET}/data.zarr`,
      subsources: { default: { enabled: true, writable: true } },
      enableDefaultSubsources: false,
    },
  });
  viewer!.layerSpecification.add(layer);

  const { context } = await waitForEditingContext();

  const center = new Float32Array([10, 10, 10]);
  const paintVal = 42n;
  await context.paintBrushWithShape(center, 2, paintVal, 0 /* DISK */, {
    u: new Float32Array([1, 0, 0]),
    v: new Float32Array([0, 1, 0]),
  });

  const chunkKey = `${BUCKET}/data.zarr/0/0/0`;

  await poll(() => {
    const data = storage.get(chunkKey);
    if (!data) return false;
    const arr = new Uint32Array(data);
    return arr.some((v) => v === 42);
  }, "Verify painted chunk with slash separator");
});

test("Pipeline: Flood Fill (Zarr V2 UINT8 on img layer)", async () => {
  const BUCKET = "test-flood-fill";
  const CHUNK_SIZE = 32;
  const zarray = JSON.stringify({
    zarr_format: 2,
    shape: [64, 64, 64],
    chunks: [CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE],
    dtype: "|u1",
    fill_value: 0,
    order: "C",
    dimension_separator: ".",
    compressor: null,
  });
  storage.set(
    `${BUCKET}/data.zarr/.zarray`,
    <ArrayBuffer>new TextEncoder().encode(zarray).buffer,
  );
  storage.set(
    `${BUCKET}/data.zarr/.zgroup`,
    <ArrayBuffer>new TextEncoder().encode("{}").buffer,
  );

  const chunkData = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
  // Create a hollow box from 5,5,0 to 25,25,0 in z=0 slice
  for (let y = 5; y <= 25; y++) {
    for (let x = 5; x <= 25; x++) {
      if (x === 5 || x === 25 || y === 5 || y === 25) {
        const index = 0 * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x;
        chunkData[index] = 255;
      }
    }
  }
  const chunkKey = `${BUCKET}/data.zarr/0.0.0`;
  storage.set(chunkKey, chunkData.buffer);

  const layer = makeLayer(viewer!.layerSpecification, "volume", {
    type: "image",
    source: {
      url: `s3+http://localhost:9000/${BUCKET}/data.zarr`,
      subsources: { default: { enabled: true, writable: true } },
      enableDefaultSubsources: false,
    },
  });
  viewer!.layerSpecification.add(layer);

  const { context } = await waitForEditingContext();

  const seed = new Float32Array([15, 15, 0]);
  const fillValue = 128n;
  const maxVoxels = 1000;
  const planeNormal = vec3.fromValues(0, 0, 1);

  await poll(
    async () => {
      try {
        await context.floodFillPlane2D(seed, fillValue, maxVoxels, planeNormal);
        return true;
      } catch (e: any) {
        if (e.message.includes("unloaded")) {
          return false;
        }
        throw e;
      }
    },
    "Execute flood fill",
    5000,
  );

  await poll(() => {
    const data = storage.get(chunkKey);
    if (!data) return false;
    const arr = new Uint8Array(data);
    const insideIndex = 0 * CHUNK_SIZE * CHUNK_SIZE + 15 * CHUNK_SIZE + 15;
    const outsideIndex = 0 * CHUNK_SIZE * CHUNK_SIZE + 2 * CHUNK_SIZE + 2;
    return arr[insideIndex] === 128 && arr[outsideIndex] === 0;
  }, "Verify flood fill result");
});
