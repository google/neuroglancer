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

import type { ShaderProgram } from "#src/webgl/shader.js";

// Temporary diagnostic-build switches; neither is intended for production.
export const DEBUG_SKELETON_DRAW = true;
export const DEBUG_SKIP_3D_LINE_NODES = false;

export function shouldDrawSkeletonNodes(
  targetIsSliceView: boolean,
  linesAndPoints: boolean,
) {
  return !DEBUG_SKIP_3D_LINE_NODES || targetIsSliceView || linesAndPoints;
}

export interface SkeletonDrawContext {
  view: "2d" | "3d";
  pass: "color" | "color-and-picking" | "picking";
  emitter: string;
  objectId: string;
  objectAlpha: number;
  mode: "lines" | "lines-and-points";
  primitive: "edges" | "nodes";
}

type DiagnosticGL = Pick<
  WebGL2RenderingContext,
  | "NO_ERROR"
  | "CONTEXT_LOST_WEBGL"
  | "getError"
  | "isContextLost"
  | "getProgramInfoLog"
  | "getShaderInfoLog"
> & {
  getExtension(name: "WEBGL_debug_shaders"): WEBGL_debug_shaders | null;
};

type DiagnosticShader = Pick<
  ShaderProgram,
  | "program"
  | "vertexShader"
  | "fragmentShader"
  | "vertexSource"
  | "fragmentSource"
>;

function readErrors(gl: DiagnosticGL) {
  const errors: string[] = [];
  for (;;) {
    const error = gl.getError();
    if (error === gl.NO_ERROR) break;
    errors.push(`0x${error.toString(16)}`);
    if (error === gl.CONTEXT_LOST_WEBGL) break;
  }
  return errors;
}

export class SkeletonDrawDiagnostics {
  private reports = new WeakMap<WebGLProgram, Set<string>>();
  private debugShaders: WEBGL_debug_shaders | null;

  constructor(private gl: DiagnosticGL) {
    this.debugShaders = DEBUG_SKELETON_DRAW
      ? gl.getExtension("WEBGL_debug_shaders")
      : null;
  }

  draw(
    shader: DiagnosticShader,
    context: SkeletonDrawContext,
    draw: () => void,
  ) {
    if (!DEBUG_SKELETON_DRAW) {
      draw();
      return;
    }
    const { gl } = this;
    const errorsBeforeDraw = readErrors(gl);
    const contextLostBeforeDraw = gl.isContextLost();
    if (!contextLostBeforeDraw) draw();
    const errorsAfterDraw = readErrors(gl);
    const contextLost = gl.isContextLost();
    // ANGLE can append HLSL compilation errors only when the program is drawn.
    const programInfoLog = gl.getProgramInfoLog(shader.program);
    const vertexInfoLog = gl.getShaderInfoLog(shader.vertexShader);
    const fragmentInfoLog = gl.getShaderInfoLog(shader.fragmentShader);
    const failed =
      errorsBeforeDraw.length !== 0 ||
      errorsAfterDraw.length !== 0 ||
      contextLostBeforeDraw ||
      contextLost;
    if (!failed && !programInfoLog && !vertexInfoLog && !fragmentInfoLog)
      return;

    const status = {
      errorsBeforeDraw,
      errorsAfterDraw,
      contextLostBeforeDraw,
      contextLost,
      programInfoLog,
      vertexInfoLog,
      fragmentInfoLog,
    };
    const signature = JSON.stringify([
      context.view,
      context.pass,
      context.emitter,
      context.primitive,
      status,
    ]);
    let reports = this.reports.get(shader.program);
    if (reports === undefined) {
      reports = new Set();
      this.reports.set(shader.program, reports);
    }
    if (reports.has(signature)) return;
    reports.add(signature);

    const report = JSON.stringify(
      {
        ...context,
        ...status,
        vertexSource: shader.vertexSource,
        fragmentSource: shader.fragmentSource,
        translatedShaderStatus:
          this.debugShaders === null
            ? "extension-unavailable"
            : contextLost
              ? "context-lost"
              : "queried",
        translatedVertexSource:
          this.debugShaders !== null && !contextLost
            ? this.debugShaders.getTranslatedShaderSource(shader.vertexShader)
            : null,
        translatedFragmentSource:
          this.debugShaders !== null && !contextLost
            ? this.debugShaders.getTranslatedShaderSource(shader.fragmentShader)
            : null,
      },
      null,
      2,
    );
    if (failed) {
      console.error("Skeleton WebGL draw diagnostic", report);
    } else {
      console.warn("Skeleton WebGL draw diagnostic", report);
    }
  }
}
