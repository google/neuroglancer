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
import "#src/layer/annotation/index.js";
import "#src/layer/image/index.js";
import "#src/sliceview/uncompressed_chunk_format.js";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisplayContext } from "#src/display_context.js";
import { Viewer } from "#src/viewer.js";
import { mswFixture } from "#tests/fixtures/msw";

const msw = mswFixture();

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

// A 50% white point at the center of the view.
const translucentPoint = {
  type: "annotation",
  name: "point",
  source: "local://annotations",
  annotations: [{ type: "point", id: "a", point: [8, 8, 8] }],
  shader: `void main() {
  setPointMarkerSize(20.0);
  setPointMarkerColor(vec4(1.0, 1.0, 1.0, 0.5));
}`,
};

// A white 16^3 image volume with 50% opacity, centered in the view.
const translucentImage = {
  type: "image",
  name: "image",
  source: `precomputed://${location.origin}/transparent-test`,
  opacity: 0.5,
  shader: "void main() { emitGrayscale(1.0); }",
};

async function serveImage() {
  (await msw()).use(
    http.get("*/transparent-test/info", () =>
      HttpResponse.json({
        type: "image",
        data_type: "uint8",
        num_channels: 1,
        scales: [
          {
            key: "1",
            size: [16, 16, 16],
            resolution: [1, 1, 1],
            voxel_offset: [0, 0, 0],
            chunk_sizes: [[16, 16, 16]],
            encoding: "raw",
          },
        ],
      }),
    ),
    http.get(
      "*/transparent-test/1/*",
      () => new HttpResponse(new Uint8Array(16 ** 3).fill(255)),
    ),
    http.get(
      "*/transparent-test/*",
      () => new HttpResponse(null, { status: 404 }),
    ),
  );
}

// Draws a 128x128 viewer and returns the RGBA value of each canvas pixel.
async function draw(
  layout: string,
  layers: object[],
  transparentBackground: boolean,
) {
  const container = document.createElement("div");
  container.style.width = "128px";
  container.style.height = "128px";
  document.body.appendChild(container);
  disposers.push(() => container.remove());
  const display = new DisplayContext(container);
  disposers.push(() => display.dispose());
  const viewer = new Viewer(display, { showUIControls: false });
  disposers.push(() => viewer.dispose());
  viewer.state.restoreState({
    dimensions: { x: [1e-9, "m"], y: [1e-9, "m"], z: [1e-9, "m"] },
    position: [8, 8, 8],
    crossSectionScale: 0.25,
    layout,
    showAxisLines: false,
    showScaleBar: false,
    showDefaultAnnotations: false,
    layers,
  });
  viewer.uiConfiguration.transparentBackground.value = transparentBackground;
  await vi.waitFor(
    () => {
      display.draw();
      expect(viewer.isReady()).toBe(true);
    },
    { timeout: 5000 },
  );
  // `isReady` processes pending chunk updates, so draw again to show them.
  display.draw();
  const { gl, canvas } = display;
  const { width, height } = canvas;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const at = (x: number, y: number) =>
    Array.from(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
  return {
    center: at(width >> 1, height >> 1),
    // Inside the panel, outside the content.
    empty: at(width >> 3, height >> 1),
    // Pixels whose color exceeds their alpha, which a premultiplied canvas cannot show correctly.
    invalidPixels: () => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        if (pixels[i] > a || pixels[i + 1] > a || pixels[i + 2] > a) ++count;
      }
      return count;
    },
  };
}

// Allows for rounding of 0.5 to 127 or 128.
const half = () => expect.toBeOneOf([127, 128]);

describe("DisplayContext.transparentBackground", () => {
  it("is off by default, so the canvas is opaque", async () => {
    const { center, empty } = await draw("xy", [translucentPoint], false);
    expect(center[3]).toBe(255);
    expect(empty).toEqual([128, 128, 128, 255]);
  });

  it("leaves empty areas of a cross-section transparent", async () => {
    const result = await draw("xy", [translucentPoint], true);
    expect(result.empty).toEqual([0, 0, 0, 0]);
    expect(result.invalidPixels()).toBe(0);
  });

  it("keeps the alpha of a translucent annotation", async () => {
    const { center } = await draw("xy", [translucentPoint], true);
    expect(center).toEqual([half(), half(), half(), half()]);
  });

  it("keeps the alpha of a translucent image", async () => {
    await serveImage();
    const result = await draw("xy", [translucentImage], true);
    expect(result.center).toEqual([half(), half(), half(), half()]);
    expect(result.invalidPixels()).toBe(0);
  });

  it("leaves the 3D panel opaque", async () => {
    const { center, empty } = await draw("3d", [translucentPoint], true);
    expect(center[3]).toBe(255);
    expect(empty[3]).toBe(255);
  });
});
