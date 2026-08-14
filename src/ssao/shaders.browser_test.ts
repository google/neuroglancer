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

import { describe, it, expect } from "vitest";
import {
  defineBlurShader,
  defineGTAOShader,
  defineSSAOCompositeShader,
} from "#src/ssao/shaders.js";
import { mat4 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import {
  FramebufferConfiguration,
  OffscreenCopyHelper,
  TextureBuffer,
} from "#src/webgl/offscreen.js";
import { webglTest } from "#src/webgl/testing.js";

function makeTexture(
  gl: GL,
  internalFormat: number,
  format: number,
  type: number,
  data: ArrayBufferView,
  w = 1,
  h = 1,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function makeRgba8Output(gl: GL): FramebufferConfiguration<TextureBuffer> {
  return new FramebufferConfiguration(gl, {
    colorBuffers: [
      new TextureBuffer(
        gl,
        WebGL2RenderingContext.RGBA8,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
      ),
    ],
  });
}

function readRgba8(gl: GL): Uint8Array {
  const out = new Uint8Array(4);
  gl.readPixels(
    0,
    0,
    1,
    1,
    WebGL2RenderingContext.RGBA,
    WebGL2RenderingContext.UNSIGNED_BYTE,
    out,
  );
  return out;
}

// Runs the GTAO (SSAO) shader on a w × h depth grid with every pixel's normal facing
// the camera, and returns the RGBA bytes at (cx, cy). Used by tests that vary
// only the depth pattern.
function runGTAOAndReadCenter(
  gl: GL,
  w: number,
  h: number,
  cx: number,
  cy: number,
  depths: Float32Array,
): Uint8Array {
  const helper = OffscreenCopyHelper.get(gl, defineGTAOShader, 2);
  const depthTex = makeTexture(
    gl,
    WebGL2RenderingContext.R32F,
    WebGL2RenderingContext.RED,
    WebGL2RenderingContext.FLOAT,
    depths,
    w,
    h,
  );
  // Every pixel: packed view-space normal (0, 0, 1), i.e., facing the camera.
  const normals = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    normals[i * 4] = 128;
    normals[i * 4 + 1] = 128;
    normals[i * 4 + 2] = 255;
    normals[i * 4 + 3] = 255;
  }
  const normalTex = makeTexture(
    gl,
    WebGL2RenderingContext.RGBA8,
    WebGL2RenderingContext.RGBA,
    WebGL2RenderingContext.UNSIGNED_BYTE,
    normals,
    w,
    h,
  );
  const fbo = new FramebufferConfiguration(gl, {
    colorBuffers: [
      new TextureBuffer(
        gl,
        WebGL2RenderingContext.RGBA8,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
      ),
    ],
  });
  try {
    fbo.bind(w, h);
    helper.shader.bind();
    const proj = mat4.create();
    // Make a camera with 90 degree vertical FOV, square aspect, [0.1, 10] depth range.
    mat4.perspective(proj, Math.PI / 2, 1.0, 0.1, 10.0);
    const invProj = mat4.create();
    mat4.invert(invProj, proj);
    gl.uniformMatrix4fv(helper.shader.uniform("uProjection"), false, proj);
    gl.uniformMatrix4fv(
      helper.shader.uniform("uInvProjection"),
      false,
      invProj,
    );
    // 0.4 > 1/uResolution.y (i.e., 0.125), so the sub-pixel exit is skipped;
    // kernel reaches ~3 pixels from center.
    gl.uniform1f(helper.shader.uniform("uRadius"), 0.4);
    gl.uniform2f(helper.shader.uniform("uResolution"), w, h);
    helper.draw(depthTex, normalTex);
    const px = new Uint8Array(4);
    gl.readPixels(
      cx,
      cy,
      1,
      1,
      WebGL2RenderingContext.RGBA,
      WebGL2RenderingContext.UNSIGNED_BYTE,
      px,
    );
    return px;
  } finally {
    fbo.dispose();
    gl.deleteTexture(depthTex);
    gl.deleteTexture(normalTex);
  }
}

describe("SSAO shaders", () => {
  it("composite multiplies color by pow(ao, intensity)", () => {
    webglTest((gl) => {
      const helper = OffscreenCopyHelper.get(gl, defineSSAOCompositeShader, 3);
      // Color (~1.0, ~0.502, ~0.251, 1.0) from bytes (255, 128, 64, 255).
      const colorTex = makeTexture(
        gl,
        WebGL2RenderingContext.RGBA8,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([255, 128, 64, 255]),
      );
      // AO = 0.502 (byte 128). pow(0.502, 2.0) ≈ 0.252.
      const aoTex = makeTexture(
        gl,
        WebGL2RenderingContext.R8,
        WebGL2RenderingContext.RED,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([128]),
      );
      // Non-sentinel normal (packed +Z, "facing camera"): bytes (128, 128, 255).
      const normalTex = makeTexture(
        gl,
        WebGL2RenderingContext.RGBA8,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([128, 128, 255, 255]),
      );
      const fbo = makeRgba8Output(gl);
      try {
        fbo.bind(1, 1);
        helper.shader.bind();
        gl.uniform1f(helper.shader.uniform("uIntensity"), 2.0);
        helper.draw(colorTex, aoTex, normalTex);
        const out = readRgba8(gl);
        // Expected rgb * 0.252 ≈ (64, 32, 16); alpha unchanged.
        expect(out[0]).toBeGreaterThanOrEqual(63);
        expect(out[0]).toBeLessThanOrEqual(65);
        expect(out[1]).toBeGreaterThanOrEqual(31);
        expect(out[1]).toBeLessThanOrEqual(33);
        expect(out[2]).toBeGreaterThanOrEqual(15);
        expect(out[2]).toBeLessThanOrEqual(17);
        expect(out[3]).toBe(255);
      } finally {
        fbo.dispose();
        gl.deleteTexture(colorTex);
        gl.deleteTexture(aoTex);
        gl.deleteTexture(normalTex);
      }
    });
  });

  it("composite skips AO when NORMAL is the zero-RGB sentinel", () => {
    webglTest((gl) => {
      const helper = OffscreenCopyHelper.get(gl, defineSSAOCompositeShader, 3);
      const colorTex = makeTexture(
        gl,
        WebGL2RenderingContext.RGBA8,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([255, 128, 64, 255]),
      );
      // AO = 0.502 — would yield color * 0.252 if the multiply ran.
      const aoTex = makeTexture(
        gl,
        WebGL2RenderingContext.R8,
        WebGL2RenderingContext.RED,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([128]),
      );
      // Zero-RGB sentinel: composite should skip the AO multiply entirely.
      const normalTex = makeTexture(
        gl,
        WebGL2RenderingContext.RGBA8,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]),
      );
      const fbo = makeRgba8Output(gl);
      try {
        fbo.bind(1, 1);
        helper.shader.bind();
        gl.uniform1f(helper.shader.uniform("uIntensity"), 2.0);
        helper.draw(colorTex, aoTex, normalTex);
        const out = readRgba8(gl);
        // Color passes through unchanged.
        expect(out[0]).toBe(255);
        expect(out[1]).toBe(128);
        expect(out[2]).toBe(64);
        expect(out[3]).toBe(255);
      } finally {
        fbo.dispose();
        gl.deleteTexture(colorTex);
        gl.deleteTexture(aoTex);
        gl.deleteTexture(normalTex);
      }
    });
  });

  it("SSAO no-AO sentinel: cleared depth (=0) returns ao=1.0", () => {
    webglTest((gl) => {
      const helper = OffscreenCopyHelper.get(gl, defineGTAOShader, 2);
      // Cleared-background sentinel: shader bails before reading the normal.
      const depthTex = makeTexture(
        gl,
        WebGL2RenderingContext.R32F,
        WebGL2RenderingContext.RED,
        WebGL2RenderingContext.FLOAT,
        new Float32Array([0.0]),
      );
      const normalTex = makeTexture(
        gl,
        WebGL2RenderingContext.RGBA8,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]),
      );
      const fbo = makeRgba8Output(gl);
      try {
        fbo.bind(1, 1);
        helper.shader.bind();
        const id = mat4.create();
        gl.uniformMatrix4fv(helper.shader.uniform("uProjection"), false, id);
        gl.uniformMatrix4fv(helper.shader.uniform("uInvProjection"), false, id);
        gl.uniform1f(helper.shader.uniform("uRadius"), 0.05);
        gl.uniform2f(helper.shader.uniform("uResolution"), 1.0, 1.0);
        helper.draw(depthTex, normalTex);
        const out = readRgba8(gl);
        expect(out[0]).toBe(255);
        expect(out[1]).toBe(255);
        expect(out[2]).toBe(255);
      } finally {
        fbo.dispose();
        gl.deleteTexture(depthTex);
        gl.deleteTexture(normalTex);
      }
    });
  });

  it("SSAO no-AO sentinel: zero-RGB normal returns ao=1.0", () => {
    webglTest((gl) => {
      const helper = OffscreenCopyHelper.get(gl, defineGTAOShader, 2);
      // Non-cleared depth so the shader proceeds past the depth check, then
      // bails on dot(rawN, rawN) < SENTINEL_EPS.
      const depthTex = makeTexture(
        gl,
        WebGL2RenderingContext.R32F,
        WebGL2RenderingContext.RED,
        WebGL2RenderingContext.FLOAT,
        new Float32Array([0.5]),
      );
      const normalTex = makeTexture(
        gl,
        WebGL2RenderingContext.RGBA8,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]),
      );
      const fbo = makeRgba8Output(gl);
      try {
        fbo.bind(1, 1);
        helper.shader.bind();
        const id = mat4.create();
        gl.uniformMatrix4fv(helper.shader.uniform("uProjection"), false, id);
        gl.uniformMatrix4fv(helper.shader.uniform("uInvProjection"), false, id);
        gl.uniform1f(helper.shader.uniform("uRadius"), 0.05);
        gl.uniform2f(helper.shader.uniform("uResolution"), 1.0, 1.0);
        helper.draw(depthTex, normalTex);
        const out = readRgba8(gl);
        expect(out[0]).toBe(255);
        expect(out[1]).toBe(255);
        expect(out[2]).toBe(255);
      } finally {
        fbo.dispose();
        gl.deleteTexture(depthTex);
        gl.deleteTexture(normalTex);
      }
    });
  });

  it("SSAO produces lowish < ao < highish when neighbors occlude the center", () => {
    webglTest((gl) => {
      const w = 8;
      const h = 8;
      const cx = 4;
      const cy = 4;
      // Center at depthVal 0.4 (further from camera); surrounding pixels at
      // 0.7 (closer). The shader does fragZ = 1 - depthVal, so the center
      // is "lower" and its raised neighbors occlude it.
      const depths = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        depths[i] = 0.7;
      }
      depths[cy * w + cx] = 0.4;
      const px = runGTAOAndReadCenter(gl, w, h, cx, cy, depths);
      // Loose bounds: tight enough to catch regressions where the algorithm
      // pegs to either extreme (no AO or full black), wide enough to absorb
      // expected variation in noise, falloff curve, or sample count.
      expect(px[0]).toBeGreaterThan(64);
      expect(px[0]).toBeLessThan(192);
    });
  });

  it("SSAO produces ao ≈ 1 on a flat surface (no occluders)", () => {
    webglTest((gl) => {
      const w = 8;
      const h = 8;
      const cx = 4;
      const cy = 4;
      // All pixels at the same depth: no occlusion possible.
      const depths = new Float32Array(w * h).fill(0.5);
      const px = runGTAOAndReadCenter(gl, w, h, cx, cy, depths);
      // Every sample has sinH ≤ 0, total occlusion is 0, ao = 1.0. Allow
      // tiny slack for floating-point rounding.
      expect(px[0]).toBeGreaterThanOrEqual(250);
    });
  });

  it("blur is identity for constant input", () => {
    webglTest((gl) => {
      const helper = OffscreenCopyHelper.get(gl, defineBlurShader, 2);
      // Constant AO = 0.698 (byte 178).
      const aoTex = makeTexture(
        gl,
        WebGL2RenderingContext.R8,
        WebGL2RenderingContext.RED,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array([178]),
      );
      const depthTex = makeTexture(
        gl,
        WebGL2RenderingContext.R32F,
        WebGL2RenderingContext.RED,
        WebGL2RenderingContext.FLOAT,
        new Float32Array([0.5]),
      );
      const fbo = makeRgba8Output(gl);
      try {
        fbo.bind(1, 1);
        helper.shader.bind();
        gl.uniform2f(helper.shader.uniform("uDirection"), 1.0, 0.0);
        helper.draw(aoTex, depthTex);
        const out = readRgba8(gl);
        // All 5 taps hit the same texel at the same depth, so depthDiff=0
        // and every weight is 1; the bilateral average equals the input.
        expect(out[0]).toBeGreaterThanOrEqual(177);
        expect(out[0]).toBeLessThanOrEqual(179);
      } finally {
        fbo.dispose();
        gl.deleteTexture(aoTex);
        gl.deleteTexture(depthTex);
      }
    });
  });
});
