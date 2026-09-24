import { describe, expect, it } from "vitest";
import {
  glsl_computeImprovedOITWeight,
  glsl_isBehindPreviousPeelDepth,
  perspectivePanelEmitDepthPeel,
  perspectivePanelEmitDepthPeelTail,
  perspectivePanelEmitImprovedOIT,
  perspectivePanelEmitOIT,
} from "#src/perspective_view/panel.js";
import type { GL } from "#src/webgl/context.js";
import {
  DepthTextureBuffer,
  FramebufferConfiguration,
  TextureBuffer,
} from "#src/webgl/offscreen.js";
import type { ShaderModule } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";
import { webglTest } from "#src/webgl/testing.js";

function compileEmitter(gl: GL, emitter: ShaderModule) {
  const builder = new ShaderBuilder(gl);
  emitter(builder);
  builder.setVertexMain("gl_Position = vec4(0.0);");
  builder.setFragmentMain("emit(vec4(0.2, 0.1, 0.05, 0.25), 0u);");
  builder.build().dispose();
}

describe("perspective panel transparency shaders", () => {
  it("supports a sampleable depth-stencil attachment", () => {
    webglTest((gl) => {
      const framebuffer = new FramebufferConfiguration(gl, {
        colorBuffers: [
          new TextureBuffer(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
        ],
        depthBuffer: new DepthTextureBuffer(
          gl,
          gl.DEPTH24_STENCIL8,
          gl.DEPTH_STENCIL,
          gl.UNSIGNED_INT_24_8,
        ),
      });
      framebuffer.bind(1, 1);
      framebuffer.dispose();
    });
  });

  it("compiles every OIT emitter", () => {
    webglTest((gl) => {
      for (const emitter of [
        perspectivePanelEmitOIT,
        perspectivePanelEmitImprovedOIT,
        perspectivePanelEmitDepthPeel,
        perspectivePanelEmitDepthPeelTail,
      ]) {
        compileEmitter(gl, emitter);
      }
    });
  });

  it("keeps improved OIT weights finite and bounded", () => {
    fragmentShaderTest(
      { alpha: "float", depth: "float" },
      { weight: "float" },
      (tester) => {
        tester.builder.addFragmentCode(glsl_computeImprovedOITWeight);
        tester.builder.setFragmentMain(
          "weight = computeOITWeight(alpha, depth);",
        );
        for (const [alpha, depth] of [
          [0, 0],
          [0, 1],
          [0.01, 0.5],
          [0.5, 0.5],
          [1, 1],
        ]) {
          tester.execute({ alpha, depth });
          expect(tester.values.weight).toBeGreaterThanOrEqual(1e-2);
          expect(tester.values.weight).toBeLessThanOrEqual(3e3);
        }
      },
    );
  });

  it("does not peel the same quantized depth twice", () => {
    fragmentShaderTest(
      { depth: "float", previousDepth: "float" },
      { isBehind: "bool" },
      (tester) => {
        tester.builder.addFragmentCode(glsl_isBehindPreviousPeelDepth);
        tester.builder.setFragmentMain(
          "isBehind = isBehindPreviousPeelDepth(depth, previousDepth);",
        );
        const depthBin = 1 / 16777215;
        tester.execute({ depth: 0.5 + depthBin, previousDepth: 0.5 });
        expect(tester.values.isBehind).toBe(false);
        tester.execute({ depth: 0.5 + 4 * depthBin, previousDepth: 0.5 });
        expect(tester.values.isBehind).toBe(true);
      },
    );
  });
});
