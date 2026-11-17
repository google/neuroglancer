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
import { mat4 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import { drawQuads } from "#src/webgl/quad.js";
import {
  glsl_raycastFragmentSetup,
  initializeRaycastPrimitiveShader,
} from "#src/webgl/raycast_primitive.js";
import { defineRaycastSphereShader } from "#src/webgl/raycast_sphere.js";
import { defineRaycastConeShader } from "#src/webgl/raycast_truncated_cone.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import { webglTest } from "#src/webgl/testing.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

interface Camera {
  readonly viewportPixels: number;
  readonly projection: mat4;
}

// At the origin, looking down -z, so a z of -1 is one unit ahead.
function makeCamera(options: {
  viewportPixels: number;
  fieldOfViewDegrees: number;
  far?: number;
}): Camera {
  const { viewportPixels, fieldOfViewDegrees, far = 20 } = options;
  return {
    viewportPixels,
    projection: mat4.perspective(
      mat4.create(),
      (fieldOfViewDegrees * Math.PI) / 180,
      1,
      0.1,
      far,
    ),
  };
}

// Measures the quad the vertex stage emitted.
const SHADE_WHOLE_QUAD = "out_color = vec4(1.0);\n";
// Measures the primitive's surface, because a miss discards.
const SHADE_SURFACE = `${glsl_raycastFragmentSetup}out_color = vec4(1.0);\n`;
// Green marks a hit, because a red fraction of zero looks like an unwritten pixel.
const SHADE_AXIAL_FRACTION = `${glsl_raycastFragmentSetup}out_color = vec4(raycastConeAxialFraction, 1.0, 0.0, 1.0);\n`;

type Point = readonly [number, number, number];
// A string is a GLSL expression.
type Radius = number | string;

interface ConeSpec {
  readonly endpointA: Point;
  readonly endpointB: Point;
  readonly radiusA: Radius;
  readonly radiusB: Radius;
  readonly clipRadiusA?: Radius;
  readonly clipRadiusB?: Radius;
}

interface SphereSpec {
  readonly center: Point;
  readonly radius: Radius;
}

function glslPoint(point: Point): string {
  return `vec3(${point.map((value) => value.toFixed(4)).join(", ")})`;
}

function glslRadius(radius: Radius): string {
  return typeof radius === "number" ? radius.toFixed(5) : radius;
}

function render(
  gl: GL,
  camera: Camera,
  definePrimitive: (builder: ShaderBuilder) => void,
  emitPrimitive: string,
  fragmentMain: string,
): Uint8Array {
  const { viewportPixels, projection } = camera;
  const builder = new ShaderBuilder(gl);
  builder.addOutputBuffer("vec4", "out_color", 0);
  defineVertexId(builder);
  definePrimitive(builder);
  builder.setVertexMain(emitPrimitive);
  builder.setFragmentMain(fragmentMain);
  const shader = builder.build();
  const vertexIdHelper = VertexIdHelper.get(gl);
  try {
    shader.bind();
    vertexIdHelper.enable();
    initializeRaycastPrimitiveShader(shader, projection, {
      width: viewportPixels,
      height: viewportPixels,
    });
    gl.viewport(0, 0, viewportPixels, viewportPixels);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
    drawQuads(gl, 1, 1);
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

function drawCone(
  gl: GL,
  camera: Camera,
  spec: ConeSpec,
  fragmentMain: string,
): Uint8Array {
  const { clipRadiusA = 0, clipRadiusB = 0 } = spec;
  return render(
    gl,
    camera,
    defineRaycastConeShader,
    `emitRaycastCone(${glslPoint(spec.endpointA)}, ${glslPoint(spec.endpointB)},
                     ${glslRadius(spec.radiusA)}, ${glslRadius(spec.radiusB)},
                     ${glslRadius(clipRadiusA)}, ${glslRadius(clipRadiusB)});`,
    fragmentMain,
  );
}

function drawSphere(
  gl: GL,
  camera: Camera,
  spec: SphereSpec,
  fragmentMain: string,
): Uint8Array {
  return render(
    gl,
    camera,
    defineRaycastSphereShader,
    `emitRaycastSphere(${glslPoint(spec.center)}, ${glslRadius(spec.radius)});`,
    fragmentMain,
  );
}

function buildWithEmitHelper(
  gl: GL,
  definePrimitive: (builder: ShaderBuilder) => void,
  emitPrimitive: string,
  emitHelperBody: string,
): void {
  const builder = new ShaderBuilder(gl);
  builder.addOutputBuffer("vec4", "out_color", 0);
  definePrimitive(builder);
  builder.setVertexMain(emitPrimitive);
  builder.addFragmentCode(`void emitShaded() {\n${emitHelperBody}}\n`);
  builder.setFragmentMain(`${glsl_raycastFragmentSetup}emitShaded();\n`);
  builder.build().dispose();
}

function coveredFraction(pixels: Uint8Array): number {
  const pixelCount = pixels.length / 4;
  let covered = 0;
  for (let i = 0; i < pixelCount; ++i) {
    if (pixels[i * 4] !== 0) ++covered;
  }
  return covered / pixelCount;
}

// readPixels returns rows bottom up, so index 0 is the lowest drawn row.
function coveredWidthByRow(pixels: Uint8Array): number[] {
  const widths: number[] = [];
  const viewportPixels = Math.sqrt(pixels.length / 4);
  for (let row = 0; row < viewportPixels; ++row) {
    let width = 0;
    for (let column = 0; column < viewportPixels; ++column) {
      if (pixels[(row * viewportPixels + column) * 4 + 1] !== 0) ++width;
    }
    if (width > 0) widths.push(width);
  }
  return widths;
}

// Red of the first shaded pixel in each row, bottom up. Values run 0 to 255.
function axialFractionByRow(pixels: Uint8Array): number[] {
  const fractions: number[] = [];
  const viewportPixels = Math.sqrt(pixels.length / 4);
  for (let row = 0; row < viewportPixels; ++row) {
    for (let column = 0; column < viewportPixels; ++column) {
      const offset = (row * viewportPixels + column) * 4;
      if (pixels[offset + 1] !== 0) {
        fractions.push(pixels[offset]);
        break;
      }
    }
  }
  return fractions;
}

describe("raycast cone", () => {
  it("lets a function outside main read its depth, lighting and axial fraction", () => {
    webglTest((gl) => {
      expect(() =>
        buildWithEmitHelper(
          gl,
          defineRaycastConeShader,
          "emitRaycastCone(vec3(0.0), vec3(0.0, 1.0, 0.0), 0.1, 0.2, 0.0, 0.0);",
          `  out_color = vec4(raycastLightingFactor, raycastSurfaceDepth,
                    raycastConeAxialFraction, 1.0);\n`,
        ),
      ).not.toThrow();
    });
  });

  it("bounds a visible cone closely around its surface", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const spec: ConeSpec = {
        endpointA: [0, -0.3, -1],
        endpointB: [0, 0.3, -1],
        radiusA: 0.05,
        radiusB: 0.05,
      };
      const quad = coveredFraction(
        drawCone(gl, camera, spec, SHADE_WHOLE_QUAD),
      );
      const surface = coveredFraction(
        drawCone(gl, camera, spec, SHADE_SURFACE),
      );
      expect(surface).toBeGreaterThan(0);
      // Measured at 1.30, from the one pixel margin and the box corners.
      expect(quad / surface).toBeLessThan(1.5);
    });
  });

  it("culls a cone behind the camera", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const pixels = drawCone(
        gl,
        camera,
        {
          endpointA: [0, -0.3, 1],
          endpointB: [0, 0.3, 1],
          radiusA: 0.05,
          radiusB: 0.05,
        },
        SHADE_WHOLE_QUAD,
      );
      expect(coveredFraction(pixels)).toBe(0);
    });
  });

  it("culls a cone that wraps the camera", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      // The axis passes 0.2 ahead and the radius is 0.5, so the camera is inside.
      const pixels = drawCone(
        gl,
        camera,
        {
          endpointA: [-1, 0, -0.2],
          endpointB: [1, 0, -0.2],
          radiusA: 0.5,
          radiusB: 0.5,
        },
        SHADE_WHOLE_QUAD,
      );
      expect(coveredFraction(pixels)).toBe(0);
    });
  });

  it("culls a cone with no radius", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const pixels = drawCone(
        gl,
        camera,
        {
          endpointA: [0, -0.3, -1],
          endpointB: [0, 0.3, -1],
          radiusA: 0,
          radiusB: 0,
        },
        SHADE_WHOLE_QUAD,
      );
      expect(coveredFraction(pixels)).toBe(0);
    });
  });

  it("keeps a segment whose far endpoint has passed behind the camera", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const endpointA: Point = [-0.3, -0.2, -1];
      const endpointB: Point = [0.5, 0.4, 1];
      // Endpoint B is behind the camera, so its own pixel radius is zero.
      expect(
        coveredFraction(
          drawCone(
            gl,
            camera,
            {
              endpointA,
              endpointB,
              radiusA: 0,
              radiusB: `getRaycastRadiusForPixels(${glslPoint(endpointB)}, 1.0)`,
            },
            SHADE_WHOLE_QUAD,
          ),
        ),
      ).toBe(0);

      // The segment helper makes it borrow endpoint A's radius instead.
      const radii = `getRaycastSegmentRadiiForPixels(${glslPoint(endpointA)}, ${glslPoint(endpointB)}, 1.0)`;
      const borrowed = coveredFraction(
        drawCone(
          gl,
          camera,
          {
            endpointA,
            endpointB,
            radiusA: `${radii}.x`,
            radiusB: `${radii}.y`,
          },
          SHADE_WHOLE_QUAD,
        ),
      );
      expect(borrowed).toBeGreaterThan(0.25);
      expect(borrowed).toBeLessThan(1);
    });
  });

  it("draws a constant width when both end radii match", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const widths = coveredWidthByRow(
        drawCone(
          gl,
          camera,
          {
            endpointA: [0, -0.3, -1],
            endpointB: [0, 0.3, -1],
            radiusA: 0.05,
            radiusB: 0.05,
          },
          SHADE_SURFACE,
        ),
      );
      expect(widths.length).toBeGreaterThan(8);
      // One pixel covers where the silhouette falls between sample points.
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    });
  });

  it("draws the far side through an open end when facing the camera", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const shaded = coveredFraction(
        drawCone(
          gl,
          camera,
          {
            endpointA: [-0.05, 0, -0.6],
            endpointB: [0.15, 0, -1.6],
            radiusA: 0.2,
            radiusB: 0.2,
          },
          SHADE_SURFACE,
        ),
      );
      expect(shaded).toBeGreaterThan(0.01);
    });
  });

  it("tapers the width between two different end radii", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      // Endpoint A is the lower end, so the width grows from bottom to top. These
      // radii are wide enough that whole-pixel rasterisation does not dominate.
      const widths = coveredWidthByRow(
        drawCone(
          gl,
          camera,
          {
            endpointA: [0, -0.3, -1],
            endpointB: [0, 0.3, -1],
            radiusA: 0.03,
            radiusB: 0.12,
          },
          SHADE_SURFACE,
        ),
      );
      expect(widths.length).toBeGreaterThan(16);
      // The ends are open, so the rim projects as an ellipse and closes the
      // silhouette over the last few rows. Leave those out.
      const interior = widths.slice(
        Math.round(widths.length * 0.15),
        Math.round(widths.length * 0.85),
      );
      // Radius runs 0.0435 to 0.1065 across this slice, a ratio of 2.45.
      expect(interior.at(-1)! / interior[0]).toBeGreaterThan(1.8);
      expect(interior.at(-1)! / interior[0]).toBeLessThan(3.2);
      for (let i = 1; i < interior.length; ++i) {
        expect(interior[i]).toBeGreaterThanOrEqual(interior[i - 1] - 1);
      }
    });
  });

  it("draws a segment at the radius its pixel width asks for", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const endpointA: Point = [0, -0.3, -1];
      const endpointB: Point = [0, 0.3, -1];
      const radii = `getRaycastSegmentRadiiForPixels(${glslPoint(endpointA)}, ${glslPoint(endpointB)}, 6.0)`;
      const widths = coveredWidthByRow(
        drawCone(
          gl,
          camera,
          {
            endpointA,
            endpointB,
            radiusA: `${radii}.x`,
            radiusB: `${radii}.y`,
          },
          SHADE_SURFACE,
        ),
      );
      expect(widths.length).toBeGreaterThan(8);
      // Both ends sit at the same depth, so both ask for 6 device pixels. That is
      // a 12 pixel width, plus or minus a pixel of rasterisation.
      expect(Math.max(...widths)).toBeGreaterThan(10);
      expect(Math.max(...widths)).toBeLessThan(14);
    });
  });

  it("reports the axial fraction from 0 at endpoint A to 1 at endpoint B", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      // Endpoint A is the lower end, so the fraction rises with the row.
      const fractions = axialFractionByRow(
        drawCone(
          gl,
          camera,
          {
            endpointA: [0, -0.3, -1],
            endpointB: [0, 0.3, -1],
            radiusA: 0.05,
            radiusB: 0.05,
          },
          SHADE_AXIAL_FRACTION,
        ),
      );
      expect(fractions.length).toBeGreaterThan(8);
      expect(fractions[0]).toBeLessThan(16);
      expect(fractions.at(-1)!).toBeGreaterThan(239);
      for (let i = 1; i < fractions.length; ++i) {
        expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
      }
    });
  });

  it("clips the surface around an endpoint", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      // The surface sits one radius from the axis, so a clip radius of 0.15 reaches
      // sqrt(0.15^2 - 0.05^2) = 0.1414 along a 0.6 long axis. That is the lowest
      // 23.6 percent of it, or 60 as a 0 to 255 value.
      const clipped = axialFractionByRow(
        drawCone(
          gl,
          camera,
          {
            endpointA: [0, -0.3, -1],
            endpointB: [0, 0.3, -1],
            radiusA: 0.05,
            radiusB: 0.05,
            clipRadiusA: 0.15,
          },
          SHADE_AXIAL_FRACTION,
        ),
      );
      expect(clipped.length).toBeGreaterThan(8);
      expect(clipped[0]).toBeGreaterThan(45);
      expect(clipped[0]).toBeLessThan(78);
      expect(clipped.at(-1)!).toBeGreaterThan(239);
    });
  });

  it("draws the same surface under a depth range wide enough to flatten the projection", () => {
    webglTest((gl) => {
      // Past a far of about 4e6 at a near of 0.1, float32 rounds the far plane out
      // of reach of the inverse projection.
      const spec: ConeSpec = {
        endpointA: [0, -0.3, -1],
        endpointB: [0, 0.3, -1],
        radiusA: 0.05,
        radiusB: 0.05,
      };
      const shaded = (far: number) =>
        coveredFraction(
          drawCone(
            gl,
            makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45, far }),
            spec,
            SHADE_SURFACE,
          ),
        );
      expect(shaded(4e9)).toBeGreaterThan(0);
      expect(shaded(4e9)).toBeCloseTo(shaded(20), 3);
    });
  });

  it("leaves the surface alone when the clip radius cannot reach it", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const spec: ConeSpec = {
        endpointA: [0, -0.3, -1],
        endpointB: [0, 0.3, -1],
        radiusA: 0.05,
        radiusB: 0.05,
      };
      // A clip radius of 0.04 cannot reach a surface 0.05 from the axis.
      expect(
        axialFractionByRow(
          drawCone(
            gl,
            camera,
            { ...spec, clipRadiusA: 0.04 },
            SHADE_AXIAL_FRACTION,
          ),
        ),
      ).toEqual(
        axialFractionByRow(drawCone(gl, camera, spec, SHADE_AXIAL_FRACTION)),
      );
    });
  });
});

describe("raycast sphere", () => {
  it("lets a function outside main read its depth and lighting", () => {
    webglTest((gl) => {
      expect(() =>
        buildWithEmitHelper(
          gl,
          defineRaycastSphereShader,
          "emitRaycastSphere(vec3(0.0, 0.0, -1.0), 0.2);",
          "  out_color = vec4(vec3(raycastLightingFactor), raycastSurfaceDepth);\n",
        ),
      ).not.toThrow();
    });
  });

  it("bounds a sphere to the square around its silhouette", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      // A radius of 0.05 one unit ahead has a silhouette 0.12086 in NDC, so 3.87
      // pixels of a 64 pixel viewport. The square around that disc is 59.8 pixels,
      // or 0.0146 of the viewport, against 0.0115 for the disc itself.
      const pixels = drawSphere(
        gl,
        camera,
        { center: [0, 0, -1], radius: 0.05 },
        SHADE_WHOLE_QUAD,
      );
      expect(coveredFraction(pixels)).toBeGreaterThan(0.012);
      expect(coveredFraction(pixels)).toBeLessThan(0.017);
    });
  });

  it("culls a sphere behind the camera", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const pixels = drawSphere(
        gl,
        camera,
        { center: [0, 0, 1], radius: 0.05 },
        SHADE_WHOLE_QUAD,
      );
      expect(coveredFraction(pixels)).toBe(0);
    });
  });

  it("culls a sphere with no radius", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      const pixels = drawSphere(
        gl,
        camera,
        { center: [0, 0, -1], radius: 0 },
        SHADE_WHOLE_QUAD,
      );
      expect(coveredFraction(pixels)).toBe(0);
    });
  });

  it("bounds a sphere without clipping its surface", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      // A radius of 0.2 one unit ahead spans 15.5 pixels of a 64 pixel viewport,
      // so the plain r / d disc is 0.1831 of it. The true silhouette radius is
      // r / sqrt(d^2 - r^2), which is 4 percent more area, so the shaded surface
      // must exceed the plain disc rather than fall short of it.
      const shaded = coveredFraction(
        drawSphere(
          gl,
          camera,
          { center: [0, 0, -1], radius: 0.2 },
          SHADE_SURFACE,
        ),
      );
      expect(shaded).toBeGreaterThan(0.1831);
      expect(shaded).toBeLessThan(0.21);
    });
  });

  it("takes the whole viewport when the sphere crosses the eye plane", () => {
    webglTest((gl) => {
      const camera = makeCamera({ viewportPixels: 64, fieldOfViewDegrees: 45 });
      // Centred 0.3 ahead with a radius of 0.5, so the sphere spans the eye plane.
      const pixels = drawSphere(
        gl,
        camera,
        { center: [0, 0, -0.3], radius: 0.5 },
        SHADE_WHOLE_QUAD,
      );
      expect(coveredFraction(pixels)).toBe(1);
    });
  });
});
