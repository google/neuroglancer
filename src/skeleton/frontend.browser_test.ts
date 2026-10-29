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

import { describe, expect, it, vi } from "vitest";
import {
  PerspectiveViewSkeletonLayer,
  type SkeletonLayer,
  SkeletonRenderingOptions,
  SliceViewPanelSkeletonLayer,
} from "#src/skeleton/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import { VisibilityPriorityAggregator } from "#src/visibility_priority/frontend.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import { makeWatchableShaderError } from "#src/webgl/dynamic_shader.js";
import { drawLines, initializeLineShader } from "#src/webgl/lines.js";
import {
  FramebufferConfiguration,
  makeTextureBuffers,
} from "#src/webgl/offscreen.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";
import { webglTest } from "#src/webgl/testing.js";
import {
  computeTextureFormat,
  setOneDimensionalTextureData,
  TextureFormat,
} from "#src/webgl/texture_access.js";

function emitColor(builder: ShaderBuilder) {
  builder.addOutputBuffer("vec4", "outColor", 0);
  builder.addFragmentCode(`
void emit(vec4 color, highp uint pickId) {
  outColor = color;
}
`);
}

describe("skeleton edge RGBA", () => {
  it.each([true, false])(
    "applies opacity once with targetIsSliceView=%s",
    (targetIsSliceView) => {
      webglTest((gl) => {
        const resources = new RefCounted();
        try {
          const skeletonRenderingOptions = new SkeletonRenderingOptions();
          const base = Object.assign(new RefCounted(), {
            gl,
            displayState: {
              skeletonRenderingOptions,
              shaderError: makeWatchableShaderError(),
            },
            fallbackShaderParameters: new WatchableValue(
              skeletonRenderingOptions.shaderControlState.builderState.value,
            ),
            vertexAttributes: [
              {
                name: "",
                dataType: DataType.FLOAT32,
                numComponents: 3,
                webglDataType: gl.FLOAT,
                glslDataType: "vec3",
              },
            ],
            redrawNeeded: new NullarySignal(),
            visibility: new VisibilityPriorityAggregator(),
            draw: vi.fn<SkeletonLayer["draw"]>(),
          });
          const layer = resources.registerDisposer(
            targetIsSliceView
              ? new SliceViewPanelSkeletonLayer(
                  base as unknown as SkeletonLayer,
                )
              : new PerspectiveViewSkeletonLayer(
                  base as unknown as SkeletonLayer,
                ),
          );
          const renderContext = {
            emitColor: true,
            projectionParameters: {
              viewProjectionMat: mat4.create(),
              width: 9,
              height: 9,
            },
          } as Parameters<SliceViewPanelSkeletonLayer["draw"]>[0] &
            Parameters<PerspectiveViewSkeletonLayer["draw"]>[0];
          if (layer instanceof SliceViewPanelSkeletonLayer) {
            layer.draw(renderContext, {} as Parameters<typeof layer.draw>[1]);
          } else {
            layer.draw(renderContext, {} as Parameters<typeof layer.draw>[1]);
          }
          const renderHelper = base.draw.mock.calls[0][2];
          const framebuffer = resources.registerDisposer(
            new FramebufferConfiguration(gl, {
              colorBuffers: makeTextureBuffers(gl, 1),
            }),
          );
          const indexBuffer = resources.registerDisposer(
            GLBuffer.fromData(gl, new Uint32Array([0, 1])),
          );
          const texture = gl.createTexture();
          resources.registerDisposer(() => gl.deleteTexture(texture));
          gl.bindTexture(gl.TEXTURE_2D, texture);
          setOneDimensionalTextureData(
            gl,
            computeTextureFormat(new TextureFormat(), DataType.FLOAT32, 3),
            new Float32Array([-1, 0, 0, 1, 0, 0]),
          );

          for (const [shaderAlpha, layerAlpha] of [
            [1, 1],
            [0.5, 1],
            [1, 0.5],
            [0.5, 0.5],
          ]) {
            skeletonRenderingOptions.shader.value = `void main() {
  emitRGBA(vec4(1.0, 0.5, 0.25, ${shaderAlpha.toFixed(1)}));
}`;
            const result = renderHelper.edgeShaderGetter(emitColor);
            expect(result.fallback).toBe(false);
            const shader = result.shader!;
            expect(shader).not.toBeNull();
            shader.bind();
            renderHelper.beginLayer(gl, shader, renderContext, mat4.create());
            gl.uniform4f(shader.uniform("uColor"), 1, 1, 1, layerAlpha);
            gl.uniform1f(shader.uniform("uLineWidth"), 3);
            initializeLineShader(
              shader,
              renderContext.projectionParameters,
              targetIsSliceView ? 1 : 0,
            );
            const textureUnit = gl.getUniform(
              shader.program,
              shader.uniform("uVertexAttributeSampler0")!,
            ) as number;
            gl.activeTexture(gl.TEXTURE0 + textureUnit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            const attribute = shader.attribute("aVertexIndex");
            indexBuffer.bindToVertexAttribI(attribute, 2);
            gl.vertexAttribDivisor(attribute, 1);
            framebuffer.bind(9, 9);

            for (const blend of [false, true]) {
              gl.disable(gl.BLEND);
              gl.clearColor(0, 0, 0, 0);
              gl.clear(gl.COLOR_BUFFER_BIT);
              if (blend) {
                gl.enable(gl.BLEND);
                gl.blendFunc(
                  targetIsSliceView ? gl.SRC_ALPHA : gl.ONE,
                  gl.ONE_MINUS_SRC_ALPHA,
                );
              }
              drawLines(gl, 1, 1);
              const pixel = new Uint8Array(4);
              gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              const alpha = shaderAlpha * layerAlpha;
              const rgbScale = blend || !targetIsSliceView ? alpha : 1;
              for (const [index, color] of [1, 0.5, 0.25].entries()) {
                expect(
                  Math.abs(pixel[index] / 255 - color * rgbScale),
                ).toBeLessThan(2 / 255);
              }
              if (!blend) {
                expect(Math.abs(pixel[3] / 255 - alpha)).toBeLessThan(2 / 255);
              }
            }
            gl.vertexAttribDivisor(attribute, 0);
            gl.disableVertexAttribArray(attribute);
            renderHelper.endLayer(gl, shader);
          }
        } finally {
          resources.dispose();
        }
      });
    },
  );
});
