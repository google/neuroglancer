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

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkeletonDrawContext } from "#src/skeleton/rendering_diagnostics.js";
import {
  shouldDrawSkeletonNodes,
  SkeletonDrawDiagnostics,
} from "#src/skeleton/rendering_diagnostics.js";

afterEach(() => vi.restoreAllMocks());

describe("diagnostic skeleton node selection", () => {
  it.each([
    [false, false, true],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ])(
    "slice view=%s, lines and points=%s draws nodes=%s",
    (slice, points, draw) => {
      expect(shouldDrawSkeletonNodes(slice, points)).toBe(draw);
    },
  );
});

function setup(debugShaders: WEBGL_debug_shaders | null = null) {
  const gl = {
    NO_ERROR: 0 as const,
    CONTEXT_LOST_WEBGL: 0x9242 as const,
    getError: vi.fn<() => number>().mockReturnValue(0),
    isContextLost: vi.fn<() => boolean>().mockReturnValue(false),
    getProgramInfoLog: vi.fn<() => string | null>().mockReturnValue(""),
    getShaderInfoLog: vi.fn<() => string | null>().mockReturnValue(""),
    getExtension: vi.fn().mockReturnValue(debugShaders),
  };
  const shader = {
    program: {},
    vertexShader: {},
    fragmentShader: {},
    vertexSource: "vertex source",
    fragmentSource: "fragment source",
  };
  const context: SkeletonDrawContext = {
    view: "3d",
    pass: "color",
    emitter: "perspectivePanelEmitOIT",
    objectId: "123",
    objectAlpha: 0.8,
    mode: "lines",
    primitive: "edges",
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const draw = vi.fn();
  const diagnostics = new SkeletonDrawDiagnostics(gl);
  return { gl, shader, context, error, warn, draw, diagnostics };
}

describe("SkeletonDrawDiagnostics", () => {
  it("checks logs after drawing and does not report successful draws", () => {
    const { gl, shader, context, error, warn, draw, diagnostics } = setup();
    draw.mockImplementation(() => {
      expect(gl.getProgramInfoLog).not.toHaveBeenCalled();
    });
    diagnostics.draw(shader, context, draw);
    expect(draw).toHaveBeenCalledOnce();
    expect(gl.getProgramInfoLog).toHaveBeenCalledWith(shader.program);
    expect(gl.getShaderInfoLog).toHaveBeenCalledWith(shader.vertexShader);
    expect(gl.getShaderInfoLog).toHaveBeenCalledWith(shader.fragmentShader);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("captures draw-time errors, shader sources, and pass details", () => {
    const { gl, shader, context, error, draw, diagnostics } = setup();
    draw.mockImplementation(() => {
      gl.getError.mockReturnValueOnce(0x502);
      gl.getProgramInfoLog.mockReturnValue("X3067: ambiguous function call");
    });
    diagnostics.draw(shader, context, draw);
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(error.mock.calls[0][1])).toEqual({
      ...context,
      errorsBeforeDraw: [],
      errorsAfterDraw: ["0x502"],
      contextLostBeforeDraw: false,
      contextLost: false,
      programInfoLog: "X3067: ambiguous function call",
      vertexInfoLog: "",
      fragmentInfoLog: "",
      vertexSource: shader.vertexSource,
      fragmentSource: shader.fragmentSource,
      translatedShaderStatus: "extension-unavailable",
      translatedVertexSource: null,
      translatedFragmentSource: null,
    });
  });

  it("captures translated sources after a failed draw when the extension is available", () => {
    const getTranslatedShaderSource = vi
      .fn()
      .mockReturnValueOnce("translated vertex")
      .mockReturnValueOnce("translated fragment");
    const { gl, shader, context, error, draw, diagnostics } = setup({
      getTranslatedShaderSource,
    });
    expect(gl.getExtension).toHaveBeenCalledWith("WEBGL_debug_shaders");
    draw.mockImplementation(() => gl.getError.mockReturnValueOnce(0x502));
    diagnostics.draw(shader, context, draw);
    expect(getTranslatedShaderSource.mock.calls).toEqual([
      [shader.vertexShader],
      [shader.fragmentShader],
    ]);
    expect(JSON.parse(error.mock.calls[0][1])).toMatchObject({
      translatedShaderStatus: "queried",
      translatedVertexSource: "translated vertex",
      translatedFragmentSource: "translated fragment",
    });
    diagnostics.draw(shader, context, draw);
    expect(getTranslatedShaderSource).toHaveBeenCalledTimes(2);
  });

  it("does not request translated sources for successful draws", () => {
    const getTranslatedShaderSource = vi.fn();
    const { shader, context, draw, diagnostics } = setup({
      getTranslatedShaderSource,
    });
    diagnostics.draw(shader, context, draw);
    expect(getTranslatedShaderSource).not.toHaveBeenCalled();
  });

  it("does not request translated sources after context loss", () => {
    const getTranslatedShaderSource = vi.fn();
    const { gl, shader, context, error, draw, diagnostics } = setup({
      getTranslatedShaderSource,
    });
    draw.mockImplementation(() => gl.isContextLost.mockReturnValue(true));
    diagnostics.draw(shader, context, draw);
    expect(getTranslatedShaderSource).not.toHaveBeenCalled();
    expect(JSON.parse(error.mock.calls[0][1])).toMatchObject({
      translatedShaderStatus: "context-lost",
      translatedVertexSource: null,
      translatedFragmentSource: null,
    });
  });

  it("distinguishes pre-existing errors from draw errors", () => {
    const { gl, shader, context, error, draw, diagnostics } = setup();
    gl.getError.mockReturnValueOnce(0x501).mockReturnValueOnce(0x502);
    diagnostics.draw(shader, context, draw);
    expect(JSON.parse(error.mock.calls[0][1])).toMatchObject({
      errorsBeforeDraw: ["0x501", "0x502"],
      errorsAfterDraw: [],
    });
  });

  it("retains GLSL when context loss makes driver logs unavailable", () => {
    const { gl, shader, context, error, draw, diagnostics } = setup();
    draw.mockImplementation(() => {
      gl.getError.mockReturnValueOnce(gl.CONTEXT_LOST_WEBGL);
      gl.isContextLost.mockReturnValue(true);
      gl.getProgramInfoLog.mockReturnValue(null);
      gl.getShaderInfoLog.mockReturnValue(null);
    });
    diagnostics.draw(shader, context, draw);
    expect(JSON.parse(error.mock.calls[0][1])).toMatchObject({
      errorsAfterDraw: ["0x9242"],
      contextLostBeforeDraw: false,
      contextLost: true,
      programInfoLog: null,
      vertexInfoLog: null,
      fragmentInfoLog: null,
      vertexSource: shader.vertexSource,
      fragmentSource: shader.fragmentSource,
    });
  });

  it("reports an already-lost context without issuing a draw", () => {
    const { gl, shader, context, error, draw, diagnostics } = setup();
    gl.isContextLost.mockReturnValue(true);
    diagnostics.draw(shader, context, draw);
    expect(draw).not.toHaveBeenCalled();
    expect(JSON.parse(error.mock.calls[0][1])).toMatchObject({
      contextLostBeforeDraw: true,
      contextLost: true,
    });
  });

  it("deduplicates reports without hiding failures in other passes", () => {
    const { gl, shader, context, error, draw, diagnostics } = setup();
    draw.mockImplementation(() => gl.getError.mockReturnValueOnce(0x502));
    diagnostics.draw(shader, context, draw);
    diagnostics.draw(shader, { ...context, objectId: "456" }, draw);
    expect(error).toHaveBeenCalledOnce();
    diagnostics.draw(shader, { ...context, pass: "picking" }, draw);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("reports log-only warnings but still reports a later draw failure", () => {
    const { gl, shader, context, error, warn, draw, diagnostics } = setup();
    gl.getShaderInfoLog.mockReturnValue("compiler warning");
    diagnostics.draw(shader, context, draw);
    diagnostics.draw(shader, context, draw);
    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    draw.mockImplementation(() => gl.getError.mockReturnValueOnce(0x502));
    diagnostics.draw(shader, context, draw);
    expect(error).toHaveBeenCalledOnce();
  });
});
