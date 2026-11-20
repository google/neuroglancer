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

import { describe, expect, it } from "vitest";
import type { GL } from "#src/webgl/context.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
} from "#src/webgl/lines.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import { webglTest } from "#src/webgl/testing.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

// Clip space x, y, z, w. Inside the depth range means |z| <= w.
type ClipPoint = readonly [number, number, number, number];

interface LineSpec {
  readonly viewportPixels: number;
  readonly endpointA: ClipPoint;
  readonly endpointB: ClipPoint;
  readonly widthInPixels: number;
  readonly clipRadiusAInPixels: number;
  readonly clipRadiusBInPixels: number;
}

function glslClipPoint(point: ClipPoint): string {
  return `vec4(${point.map((value) => value.toFixed(4)).join(", ")})`;
}

function drawLine(gl: GL, spec: LineSpec): Uint8Array {
  const builder = new ShaderBuilder(gl);
  builder.addOutputBuffer("vec4", "out_color", 0);
  defineVertexId(builder);
  defineLineShader(builder, { endpointClipping: true });
  builder.setVertexMain(
    `emitLine(${glslClipPoint(spec.endpointA)}, ${glslClipPoint(spec.endpointB)},
              ${spec.widthInPixels.toFixed(1)},
              ${spec.clipRadiusAInPixels.toFixed(1)}, ${spec.clipRadiusBInPixels.toFixed(1)});`,
  );
  builder.setFragmentMain("out_color = vec4(getLineAlpha());\n");
  const shader = builder.build();
  const vertexIdHelper = VertexIdHelper.get(gl);
  try {
    shader.bind();
    vertexIdHelper.enable();
    const { viewportPixels } = spec;
    initializeLineShader(
      shader,
      { width: viewportPixels, height: viewportPixels },
      /*featherWidthInPixels=*/ 0,
    );
    gl.viewport(0, 0, viewportPixels, viewportPixels);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
    drawLines(gl, 1, 1);
    const pixels = new Uint8Array(viewportPixels * viewportPixels * 4);
    gl.readPixels(
      0,
      0,
      viewportPixels,
      viewportPixels,
      WebGL2RenderingContext.RGBA,
      WebGL2RenderingContext.UNSIGNED_BYTE,
      pixels,
    );
    return pixels;
  } finally {
    vertexIdHelper.disable();
    shader.dispose();
  }
}

function coveredCount(pixels: Uint8Array): number {
  let covered = 0;
  for (let i = 0; i < pixels.length / 4; ++i) {
    if (pixels[i * 4] !== 0) ++covered;
  }
  return covered;
}

function isCovered(pixels: Uint8Array, x: number, y: number): boolean {
  const viewportPixels = Math.sqrt(pixels.length / 4);
  return pixels[(y * viewportPixels + x) * 4] !== 0;
}

describe("line endpoint clipping", () => {
  it("removes a disc at each endpoint, so a node drawn there has room", () => {
    webglTest((gl) => {
      // Endpoint A lands at x 16 and endpoint B at x 48. Pixel 47 is the last one
      // the line covers at B.
      const spec = {
        viewportPixels: 64,
        endpointA: [-0.5, 0, 0, 1],
        endpointB: [0.5, 0, 0, 1],
        widthInPixels: 6,
      } as const;
      const unclipped = drawLine(gl, {
        ...spec,
        clipRadiusAInPixels: 0,
        clipRadiusBInPixels: 0,
      });
      const clipped = drawLine(gl, {
        ...spec,
        clipRadiusAInPixels: 10,
        clipRadiusBInPixels: 10,
      });

      expect(coveredCount(clipped)).toBeGreaterThan(0);
      expect(coveredCount(clipped)).toBeLessThan(coveredCount(unclipped));
      expect(isCovered(unclipped, 16, 32)).toBe(true);
      expect(isCovered(clipped, 16, 32)).toBe(false);
      expect(isCovered(unclipped, 47, 32)).toBe(true);
      expect(isCovered(clipped, 47, 32)).toBe(false);
    });
  });

  it("clips at an endpoint inside the depth range but not at one outside it", () => {
    webglTest((gl) => {
      // A is at pixel 24 with the line trimmed to start at 32, so a 10 pixel
      // radius would reach 33. B is at pixel 56, the drawn end, so its disc takes 55.
      const spec = {
        viewportPixels: 64,
        endpointA: [-0.25, 0, -1.5, 1],
        endpointB: [0.75, 0, 0.5, 1],
        widthInPixels: 6,
      } as const;
      const unclipped = drawLine(gl, {
        ...spec,
        clipRadiusAInPixels: 0,
        clipRadiusBInPixels: 0,
      });
      const clipped = drawLine(gl, {
        ...spec,
        clipRadiusAInPixels: 10,
        clipRadiusBInPixels: 10,
      });

      expect(isCovered(unclipped, 33, 32)).toBe(true);
      expect(isCovered(clipped, 33, 32)).toBe(true);
      expect(isCovered(unclipped, 55, 32)).toBe(true);
      expect(isCovered(clipped, 55, 32)).toBe(false);
    });
  });

  it("clears each endpoint by its own radius, so different node sizes each have room", () => {
    webglTest((gl) => {
      // A lands at pixel 16 and B at pixel 48.
      const spec = {
        viewportPixels: 64,
        endpointA: [-0.5, 0, 0, 1],
        endpointB: [0.5, 0, 0, 1],
        widthInPixels: 6,
      } as const;
      const clipped = drawLine(gl, {
        ...spec,
        clipRadiusAInPixels: 10,
        clipRadiusBInPixels: 2,
      });

      expect(isCovered(clipped, 22, 32)).toBe(false);
      expect(isCovered(clipped, 42, 32)).toBe(true);
      expect(isCovered(clipped, 47, 32)).toBe(false);
    });
  });

  it("rejects endpoint clipping on a rounded line", () => {
    webglTest((gl) => {
      expect(() =>
        defineLineShader(new ShaderBuilder(gl), {
          rounded: true,
          endpointClipping: true,
        }),
      ).toThrow(/rounded/);
    });
  });
});
