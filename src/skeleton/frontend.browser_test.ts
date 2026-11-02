import { describe, expect, it, vi } from "vitest";
import { DisplayContext } from "#src/display_context.js";
import { makeLayer } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import "#layer/segmentation";
import {
  PerspectiveViewSkeletonLayer,
  type SkeletonLayer,
  SliceViewPanelSkeletonLayer,
} from "#src/skeleton/frontend.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import { Viewer } from "#src/viewer.js";
import { VisibilityPriorityAggregator } from "#src/visibility_priority/frontend.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import { drawLines, initializeLineShader } from "#src/webgl/lines.js";
import {
  FramebufferConfiguration,
  makeTextureBuffers,
} from "#src/webgl/offscreen.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";
import { setControlsInShader } from "#src/webgl/shader_ui_controls.js";
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

function makeSkeletonShaderTest(
  resources: RefCounted,
  targetIsSliceView: boolean,
) {
  const display = resources.registerDisposer(
    new DisplayContext(document.createElement("div")),
  );
  const viewer = resources.registerDisposer(new Viewer(display));
  const managedLayer = resources.registerDisposer(
    makeLayer(viewer.layerSpecification, "test", { type: "segmentation" }),
  );
  const { displayState } = managedLayer.layer! as SegmentationUserLayer;
  const gl = viewer.chunkManager.chunkQueueManager.gl;
  const base = Object.assign(new RefCounted(), {
    gl,
    displayState,
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
  const skeletonLayer = base as unknown as SkeletonLayer;
  const layer = resources.registerDisposer(
    targetIsSliceView
      ? new SliceViewPanelSkeletonLayer(skeletonLayer)
      : new PerspectiveViewSkeletonLayer(skeletonLayer),
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
  return {
    displayState,
    gl,
    renderHelper: base.draw.mock.calls[0][2],
    renderContext,
    skeletonLayer,
  };
}

describe.each([true, false])(
  "skeleton control namespaces with targetIsSliceView=%s",
  (targetIsSliceView) => {
    it("keeps same-named segment and skeleton controls independent", () => {
      const resources = new RefCounted();
      try {
        const { displayState, gl, renderHelper } = makeSkeletonShaderTest(
          resources,
          targetIsSliceView,
        );
        displayState.fragmentSegmentColor.value = `
#uicontrol float gain slider(min=0, max=1, default=0.25)
#uicontrol float unused slider(min=0, max=1, default=0.5)
#uicontrol bool enabled checkbox(default=true)
#uicontrol int choice select(options={"First": 0, "Second": 1}, default=0)
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
  if (false) { color *= unused; }
  return enabled ? vec3(gain + float(choice)) : color;
}`;
        const skeletonState =
          displayState.skeletonRenderingOptions.shaderControlState;
        displayState.skeletonRenderingOptions.shader.value = `
#uicontrol float gain slider(min=0, max=1, default=0.75)
#uicontrol float unused slider(min=0, max=1, default=0.5)
#uicontrol bool enabled checkbox(default=true)
#uicontrol int choice select(options={"First": 0, "Second": 1}, default=1)
void main() {
  emitRGB(enabled ? segmentColor().rgb * gain + vec3(unused + float(choice)) : vec3(0.0));
}`;
        const segmentState = displayState.segmentColorShaderControlState;
        for (const getShader of [
          renderHelper.edgeShaderGetter,
          renderHelper.nodeShaderGetter,
        ]) {
          segmentState.state.get("enabled")!.trackable.value = true;
          const result = getShader(emitColor);
          expect(result.fallback).toBe(false);
          expect(result.shader).not.toBeNull();
          const shader = result.shader!;
          shader.bind();
          for (const [segmentGain, skeletonGain] of [
            [0.25, 0.75],
            [0.5, 0.125],
          ]) {
            segmentState.state.get("gain")!.trackable.value = segmentGain;
            skeletonState.state.get("gain")!.trackable.value = skeletonGain;
            setControlsInShader(
              gl,
              shader,
              skeletonState,
              result.parameters.skeletonShaderBuilderState.parseResult,
            );
            displayState.segmentationColorUserShader.enable(
              gl,
              shader,
              result.parameters.segmentColorShaderBuilderState,
              { fallback: result.fallback, binding: resources },
              result.parameters.segmentColorParameters,
            );
            expect(
              gl.getUniform(
                shader.program,
                shader.uniform("u_shaderControl_gain")!,
              ),
            ).toBeCloseTo(skeletonGain);
            expect(
              gl.getUniform(
                shader.program,
                shader.uniform("u_segmentColorShaderControl_gain")!,
              ),
            ).toBeCloseTo(segmentGain);
            expect(
              gl.getUniform(
                shader.program,
                shader.uniform("u_shaderControl_choice")!,
              ),
            ).toBe(1);
            expect(
              gl.getUniform(
                shader.program,
                shader.uniform("u_segmentColorShaderControl_choice")!,
              ),
            ).toBe(0);
          }
          skeletonState.activeControls.trackShader(
            {
              ...result,
              parameters: result.parameters.skeletonShaderBuilderState,
            },
            resources,
          );
          expect(skeletonState.activeControls.hint.value).toEqual(
            new Set(["gain", "unused", "enabled", "choice"]),
          );
          expect(segmentState.activeControls.hint.value).toEqual(
            new Set(["gain", "enabled", "choice"]),
          );
          segmentState.state.get("enabled")!.trackable.value = false;
          const disabledResult = getShader(emitColor);
          expect(disabledResult.fallback).toBe(false);
          const disabledShader = disabledResult.shader!;
          disabledShader.bind();
          displayState.segmentationColorUserShader.enable(
            gl,
            disabledShader,
            disabledResult.parameters.segmentColorShaderBuilderState,
            { fallback: disabledResult.fallback, binding: resources },
            disabledResult.parameters.segmentColorParameters,
          );
          skeletonState.activeControls.trackShader(
            {
              ...disabledResult,
              parameters: disabledResult.parameters.skeletonShaderBuilderState,
            },
            resources,
          );
          expect(segmentState.activeControls.hint.value).toEqual(
            new Set(["enabled"]),
          );
          expect(skeletonState.activeControls.hint.value).toEqual(
            new Set(["gain", "unused", "enabled", "choice"]),
          );
        }
      } finally {
        resources.dispose();
      }
    });
  },
);

describe.each([true, false])(
  "skeleton edge alpha with targetIsSliceView=%s",
  (targetIsSliceView) => {
    it.each([false, true])(
      "inherits segment alpha only with emitDefault=%s",
      (useDefaultColor) => {
        const resources = new RefCounted();
        try {
          const {
            displayState,
            gl,
            renderHelper,
            renderContext,
            skeletonLayer,
          } = makeSkeletonShaderTest(resources, targetIsSliceView);
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
          displayState.skeletonRenderingOptions.shader.value = useDefaultColor
            ? "void main() { emitDefault(); }"
            : "void main() { emitRGB(vec3(1.0, 0.5, 0.25)); }";

          for (const segmentAlpha of [0, 0.25, 1]) {
            displayState.fragmentSegmentColor.value = `
vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
  return vec4(0.25, 0.5, 1.0, ${segmentAlpha.toFixed(2)});
}`;
            for (const layerAlpha of [1, 0.5]) {
              displayState.objectAlpha.value = layerAlpha;
              const result = renderHelper.edgeShaderGetter(emitColor);
              expect(result.fallback).toBe(false);
              const shader = result.shader!;
              expect(shader).not.toBeNull();
              shader.bind();
              renderHelper.beginLayer(gl, shader, renderContext, mat4.create());
              displayState.segmentationColorUserShader.enable(
                gl,
                shader,
                result.parameters.segmentColorShaderBuilderState,
                { fallback: result.fallback, binding: resources },
                result.parameters.segmentColorParameters,
              );
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
              gl.disable(gl.BLEND);
              gl.clearColor(0, 0, 0, 0);
              gl.clear(gl.COLOR_BUFFER_BIT);
              drawLines(gl, 1, 1);
              const pixel = new Uint8Array(4);
              gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              const alpha = layerAlpha * (useDefaultColor ? segmentAlpha : 1);
              expect(Math.abs(pixel[3] / 255 - alpha)).toBeLessThan(2 / 255);
              const color = useDefaultColor ? [0.25, 0.5, 1] : [1, 0.5, 0.25];
              const rgbScale = targetIsSliceView ? 1 : alpha;
              for (const [component, value] of color.entries()) {
                expect(
                  Math.abs(pixel[component] / 255 - value * rgbScale),
                ).toBeLessThan(2 / 255);
              }
              gl.vertexAttribDivisor(attribute, 0);
              gl.disableVertexAttribArray(attribute);
              renderHelper.endLayer(gl, shader, skeletonLayer.displayState);
            }
          }
        } finally {
          resources.dispose();
        }
      },
    );
  },
);
