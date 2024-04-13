import { vec3 } from "gl-matrix";
import { describe, it, expect } from "vitest";
import { glsl_computeOITWeight } from "#src/perspective_view/panel.js";
import { glsl_emitRGBAVolumeRendering } from "#src/volume_rendering/volume_render_layer.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";

describe("volume rendering compositing", () => {
  const steps = [16, 22, 32, 37, 64, 100, 128, 256, 512, 551, 1024, 2048];
  const revealages = new Float32Array(steps.length);
  it("combines uniform colors the same regardless of sampling rate", () => {
    fragmentShaderTest(
      {
        inputSteps: "float",
      },
      {
        outputValue1: "float",
        outputValue2: "float",
        outputValue3: "float",
        outputValue4: "float",
        revealage: "float",
      },
      (tester) => {
        const { builder } = tester;
        builder.addFragmentCode(glsl_computeOITWeight);
        builder.addFragmentCode(`
vec4 color = vec4(0.1, 0.3, 0.5, 0.1);
float idealSamplingRate = 512.0;
float uGain = 0.01;
float uBrightnessFactor;
vec4 outputColor;
float depthAtRayPosition;
`);
        builder.addFragmentCode(glsl_emitRGBAVolumeRendering);
        builder.setFragmentMain(`
outputColor = vec4(0.0);
revealage = 1.0;
uBrightnessFactor = idealSamplingRate / inputSteps;
for (int i = 0; i < int(inputSteps); ++i) {
    depthAtRayPosition = mix(0.0, 1.0, float(i) / (inputSteps - 1.0));
    emitRGBA(color);
}
outputValue1 = outputColor.r;
outputValue2 = outputColor.g;
outputValue3 = outputColor.b;
outputValue4 = outputColor.a;
`);
        for (let i = 0; i < steps.length; ++i) {
          const inputSteps = steps[i];
          tester.execute({ inputSteps });
          const values = tester.values;
          const {
            revealage,
            outputValue1,
            outputValue2,
            outputValue3,
            outputValue4,
          } = values;
          const color = vec3.fromValues(
            outputValue1 / outputValue4,
            outputValue2 / outputValue4,
            outputValue3 / outputValue4,
          );
          expect(color[0]).toBeCloseTo(0.1, 5);
          expect(color[1]).toBeCloseTo(0.3, 5);
          expect(color[2]).toBeCloseTo(0.5, 5);
          revealages[i] = revealage;
        }
        for (let i = 1; i < revealages.length; ++i) {
          expect(revealages[i]).toBeCloseTo(revealages[i - 1], 2);
        }
      },
    );
  });
});
