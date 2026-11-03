/**
 * @license
 * Copyright 2026 Google Inc.
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

import "#src/datasource/precomputed/register_default.js";
import "#src/kvstore/http/register_frontend.js";
import "#src/layer/image/index.js";
import "#src/sliceview/uncompressed_chunk_format.js";
import { delay, http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkSource } from "#src/chunk_manager/frontend.js";
import { DisplayContext } from "#src/display_context.js";
import { Viewer } from "#src/viewer.js";
import { mswFixture } from "#tests/fixtures/msw";

const msw = mswFixture();

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

const SIZE = 16;
// Time the server takes to send a chunk after the source is refreshed.
const REFRESH_DOWNLOAD_DELAY_MS = 300;

describe("ChunkSource.invalidateCache", () => {
  it("keeps the displayed image until the refreshed data arrives", async () => {
    // A precomputed volume whose voxels all have `value`.
    let value = 255;
    let downloadDelay = 0;
    (await msw()).use(
      http.get("*/refresh-test/info", () =>
        HttpResponse.json({
          type: "image",
          data_type: "uint8",
          num_channels: 1,
          scales: [
            {
              key: "1",
              size: [SIZE, SIZE, SIZE],
              resolution: [1, 1, 1],
              voxel_offset: [0, 0, 0],
              chunk_sizes: [[SIZE, SIZE, SIZE]],
              encoding: "raw",
            },
          ],
        }),
      ),
      http.get(`*/refresh-test/1/*`, async () => {
        const data = new Uint8Array(SIZE ** 3).fill(value);
        await delay(downloadDelay);
        return new HttpResponse(data);
      }),
      http.get(
        "*/refresh-test/*",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const container = document.createElement("div");
    container.style.width = "64px";
    container.style.height = "64px";
    document.body.appendChild(container);
    disposers.push(() => container.remove());
    const display = new DisplayContext(container);
    disposers.push(() => display.dispose());
    const viewer = new Viewer(display, { showUIControls: false });
    disposers.push(() => viewer.dispose());
    viewer.state.restoreState({
      dimensions: { x: [1e-9, "m"], y: [1e-9, "m"], z: [1e-9, "m"] },
      position: [SIZE / 2, SIZE / 2, SIZE / 2],
      crossSectionScale: 0.1,
      layout: "xy",
      showAxisLines: false,
      showScaleBar: false,
      layers: [
        {
          type: "image",
          name: "image",
          source: `precomputed://${location.origin}/refresh-test`,
          shader:
            "void main() { emitGrayscale(toNormalized(getDataValue())); }",
        },
      ],
    });

    // Draws one frame, as the browser does, and returns the gray level at the center.
    const { gl, canvas } = display;
    const drawFrame = async () => {
      await new Promise(requestAnimationFrame);
      display.draw();
      const pixel = new Uint8Array(4);
      gl.readPixels(
        canvas.width >> 1,
        canvas.height >> 1,
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      return pixel[0];
    };

    await vi.waitFor(async () => expect(await drawFrame()).toBe(255), {
      timeout: 5000,
    });

    // The data changes, and the source is refreshed.
    value = 0;
    downloadDelay = REFRESH_DOWNLOAD_DELAY_MS;
    // Refresh every chunk source of the viewer, as the Python data source does for a new
    // generation of its data.
    const memoized = (viewer.chunkManager.memoize as any).map as Map<
      unknown,
      unknown
    >;
    for (const source of memoized.values()) {
      if (source instanceof ChunkSource) source.invalidateCache();
    }

    const frames: number[] = [];
    const start = performance.now();
    while (frames.at(-1) !== 0) {
      expect(performance.now() - start).toBeLessThan(5000);
      frames.push(await drawFrame());
    }
    // Every frame shows either the old or the new data, never the background.
    expect(frames.filter((gray) => gray !== 255 && gray !== 0)).toEqual([]);
  });
});
