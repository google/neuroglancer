import "#src/datasource/zarr/register_default.js";
import "#src/kvstore/s3/register_frontend.js";
import "#src/sliceview/uncompressed_chunk_format.js";
import "#src/layer/segmentation/index.js";

import { http, HttpResponse } from "msw";
import { test, beforeEach, afterEach } from "vitest";
import { DisplayContext } from "#src/display_context.js";
import { makeLayer } from "#src/layer/index.js";
import type {
  VoxelEditingContext,
  UserLayerWithVoxelEditing,
} from "#src/layer/vox/index.js";
import { Viewer } from "#src/viewer.js";
import { mswFixture } from "#tests/fixtures/msw";

const msw = mswFixture();
let viewer: Viewer | undefined;

beforeEach(() => {
  const display = new DisplayContext(document.createElement("div"));
  viewer = new Viewer(display, {
    showLayerDialog: false,
    resetStateWhenEmpty: false,
  });
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
  timeout = 20000,
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (viewer) {
    const layer = viewer.layerManager.managedLayers[0]?.layer;
    if (layer) {
      console.log(`[Debug] Layer messages:`, layer.messages);
      if (layer.dataSources.length > 0) {
        const ds = layer.dataSources[0];
        console.log(`[Debug] DataSource spec url:`, ds.spec.url);
        if (ds.loadState) {
          if (ds.loadState.error) {
            console.log(`[Debug] DataSource load error:`, ds.loadState.error);
          } else {
            console.log(
              `[Debug] DataSource loaded. Subsources:`,
              ds.loadState.subsources.length,
            );
            ds.loadState.subsources.forEach((sub, i) => {
              console.log(
                `[Debug] Subsource ${i} enabled=${sub.enabled} active=${!!sub.activated} messages=`,
                sub.messages,
              );
            });
          }
        } else {
          console.log(`[Debug] DataSource loadState is undefined (loading?)`);
        }
      }
    } else {
      console.log(`[Debug] No layer found in viewer`);
    }
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

test("Pipeline: Undo/Redo (Zarr V2)", async () => {
  const storage = new Map<string, ArrayBuffer>();
  const baseUrl = "http://localhost:9000";

  (await msw()).use(
    http.put(`${baseUrl}/*`, async ({ request }) => {
      const parsed = parseBucketKey(request.url);
      console.log(`[MSW] PUT ${request.url} -> ${parsed ? "OK" : "400"}`);
      if (!parsed) return new HttpResponse(null, { status: 400 });
      const storageKey = `${parsed.bucket}/${parsed.key}`;
      const buffer = await request.arrayBuffer();
      storage.set(storageKey, buffer);
      return new HttpResponse(null, { status: 200 });
    }),
    http.get(`${baseUrl}/*`, ({ request }) => {
      const parsed = parseBucketKey(request.url);
      const storageKey = parsed ? `${parsed.bucket}/${parsed.key}` : "";
      const exists = storage.has(storageKey);
      console.log(`[MSW] GET ${request.url} -> ${exists ? "200" : "404"}`);

      if (!parsed) return new HttpResponse(null, { status: 400 });
      const data = storage.get(storageKey);
      if (!data) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(data);
    }),
    http.head(`${baseUrl}/*`, ({ request }) => {
      const parsed = parseBucketKey(request.url);
      const storageKey = parsed ? `${parsed.bucket}/${parsed.key}` : "";
      const exists = storage.has(storageKey);
      console.log(`[MSW] HEAD ${request.url} -> ${exists ? "200" : "404"}`);

      if (!parsed) return new HttpResponse(null, { status: 400 });
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

  const BUCKET = "undo-redo-test";

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

  console.log(
    `[Test] Setup storage with .zarray at ${BUCKET}/data.zarr/.zarray`,
  );

  const sourceUrl = `s3+http://localhost:9000/${BUCKET}/data.zarr`;

  if (!viewer) throw new Error("Viewer not initialized");

  const layer = makeLayer(viewer.layerSpecification, "volume", {
    type: "segmentation",
    source: {
      url: sourceUrl,
      subsources: {
        default: { enabled: true, writable: true },
      },
      enableDefaultSubsources: false,
    },
  });

  viewer.layerSpecification.add(layer);

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

  await (context as any)._controller.undo();

  await poll(() => {
    const data = storage.get(chunkKey);
    if (!data) return true;
    const arr = new Uint8Array(data);
    return arr.every((v) => v === 0);
  }, "Verify undo");

  await (context as any)._controller.redo();

  await poll(() => {
    const data = storage.get(chunkKey);
    if (!data) return false;
    const arr = new Uint8Array(data);
    return arr.some((v) => v === 100);
  }, "Verify redo");
});
