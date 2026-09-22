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
import { DisplayContext } from "#src/display_context.js";
import { makeLayer } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import "#layer/segmentation";
import {
  type InlineSegmentPropertyMap,
  PreprocessedSegmentPropertyMap,
  SegmentPropertyMap,
} from "#src/segmentation_display_state/property_map.js";
import { packColor } from "#src/util/color.js";
import { DataType } from "#src/util/data_type.js";
import { vec3, vec4 } from "#src/util/geom.js";
import { Viewer } from "#src/viewer.js";
import { ShaderCompilationError } from "#src/webgl/shader.js";
import type { SegmentPropertyReference } from "#src/webgl/shader_ui_controls.js";
import { trivialColorShader } from "#src/webgl/trivial_shaders.js";

const setupSegmentationLayer = () => {
  const target = document.createElement("div");
  const display = new DisplayContext(target);
  const viewer = new Viewer(display);
  return makeLayer(viewer.layerSpecification, "test", { type: "segmentation" })
    .layer! as SegmentationUserLayer;
};

const setSegmentPropertyMap = (
  segmentationUserLayer: SegmentationUserLayer,
  inlineProperties: InlineSegmentPropertyMap,
) => {
  segmentationUserLayer.displayState.segmentPropertyMap.value =
    new PreprocessedSegmentPropertyMap(
      new SegmentPropertyMap({ inlineProperties }),
    );
};

const setSegmentPropertyControl = (
  segmentationUserLayer: SegmentationUserLayer,
  controlName: string,
  value: SegmentPropertyReference,
) => {
  const controlState =
    segmentationUserLayer.displayState.segmentColorShaderControlState.state.get(
      controlName,
    );
  expect(controlState).toBeDefined();
  controlState!.trackable.value = value;
};

const compareWithCPUHash = (
  segmentationUserLayer: SegmentationUserLayer,
  objectId: bigint,
) => {
  const outColor =
    segmentationUserLayer.displayState.getShaderBaseSegmentColor(objectId);
  const colorGroupState =
    segmentationUserLayer.displayState.segmentationColorGroupState.value;
  const outColorCPU = vec4.create();
  colorGroupState.segmentColorHash.compute(outColorCPU, objectId);
  expect(outColor).toBeDefined();
  expect(outColor!.length).toBe(4);
  for (let i = 0; i < 4; ++i) {
    expect(outColor![i]).toBeCloseTo(outColorCPU[i]);
  }
};

expect.extend({
  toBeCloseToFoo(received: number[] | Float32Array, expected: number[]) {
    if (received.length !== expected.length) {
      return {
        pass: false,
        message: () =>
          `Expected array length ${expected.length} but received ${received.length}`,
      };
    }
    for (let i = 0; i < received.length; ++i) {
      if (Math.abs(received[i] - expected[i]) > 1e-6) {
        return {
          pass: false,
          message: () =>
            `Expected element ${i} to be close to ${expected[i]} but received ${received[i]}`,
        };
      }
    }
    return {
      pass: true,
      message: () => "Arrays are close",
    };
  },
});

const expectColor = (
  color: vec4,
  expected: [number, number, number, number],
) => {
  expect(color).toBeDefined();
  expect(color!.length).toBe(4);
  expect([...color]).toEqual(expected.map((x) => expect.closeTo(x)));
};

describe("getShaderBaseSegmentColor", () => {
  it("default shader, return hash", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    const objectId = 1n;
    compareWithCPUHash(segmentationUserLayer, objectId);
  });
  it("default shader, random segment id", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    const objectId = BigInt(Math.floor(Math.random() * 100000));
    compareWithCPUHash(segmentationUserLayer, objectId);
  });
  it("red shader", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
      return vec3(1.0, 0.0, 0.0);
  }`;
    const outColor =
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n);
    expectColor(outColor!, [1.0, 0.0, 0.0, 0.0]);
  });

  it.each([
    "highp vec3 segmentColor",
    "vec3 segmentColor ",
    "vec3\nsegmentColor\n",
  ])("supports %s declarations", (declaration) => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
${declaration}(vec3 color, bool hasProperties, bool isStated) {
  return vec3(1.0, 0.0, 0.0);
}`;

    const outColor =
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n);

    expectColor(outColor!, [1.0, 0.0, 0.0, 0.0]);
  });

  it("alpha shader", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
  vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
      return vec4(0.0, 0.0, 0.0, 0.5);
  }`;
    const outColor =
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n);
    expectColor(outColor!, [0.0, 0.0, 0.0, 0.5]);
  });

  it("preserves alpha from mapped segment colors", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.segmentStatedColors.value.set(
      1n,
      BigInt(packColor(vec4.fromValues(0.25, 0.5, 0.75, 0.5))),
    );

    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [0.25, 0.5, 0.75, 128 / 255],
    );
  });

  it("uses the representative color for equivalent segments", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    const { displayState } = segmentationUserLayer;
    displayState.segmentationGroupState.value.segmentEquivalences.link(1n, 2n);
    displayState.segmentStatedColors.value.set(
      1n,
      BigInt(packColor(vec3.fromValues(1.0, 0.0, 0.0))),
    );
    displayState.segmentStatedColors.value.set(
      2n,
      BigInt(packColor(vec3.fromValues(0.0, 1.0, 0.0))),
    );

    expectColor(
      displayState.getShaderBaseSegmentColor(2n)!,
      [1.0, 0.0, 0.0, 0.0],
    );

    displayState.baseSegmentColoring.value = true;
    expectColor(
      displayState.getShaderBaseSegmentColor(2n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
  });

  it("treats rgb mapped segment colors as having undefined alpha", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.segmentStatedColors.value.set(
      1n,
      BigInt(packColor(vec3.fromValues(1.0, 0.0, 0.0))),
    );
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
  vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
      return vec4(color.rgb, color.a < 0.0 ? 0.75 : 0.25);
  }`;

    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.75],
    );
  });

  it("gets multiple colors with a single framebuffer lookup", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    const { displayState } = segmentationUserLayer;
    displayState.segmentStatedColors.value.set(
      1n,
      BigInt(packColor(vec3.fromValues(1.0, 0.0, 0.0))),
    );
    displayState.segmentStatedColors.value.set(
      2n,
      BigInt(packColor(vec3.fromValues(0.0, 1.0, 0.0))),
    );
    displayState.segmentDefaultColor.value = vec3.fromValues(0.0, 0.0, 1.0);

    const colors = displayState.getShaderBaseSegmentColors([1n, 2n, 3n])!;
    expectColor(colors.subarray(0, 4) as vec4, [1.0, 0.0, 0.0, 0.0]);
    expectColor(colors.subarray(4, 8) as vec4, [0.0, 1.0, 0.0, 0.0]);
    expectColor(colors.subarray(8, 12) as vec4, [0.0, 0.0, 1.0, 0.0]);
  });

  it("rejects an undersized output color buffer", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    expect(() =>
      segmentationUserLayer.displayState.getShaderBaseSegmentColors(
        [1n, 2n],
        new Float32Array(7),
      ),
    ).toThrow(RangeError);
  });

  it("batches lookups that exceed the maximum framebuffer width", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    const { displayState } = segmentationUserLayer;
    displayState.segmentStatedColors.value.set(
      1n,
      BigInt(packColor(vec3.fromValues(1.0, 0.0, 0.0))),
    );
    const gl = segmentationUserLayer.manager.chunkManager.chunkQueueManager.gl;
    const ids = new Array<bigint>(gl.maxTextureSize + 1).fill(1n);

    const colors = displayState.getShaderBaseSegmentColors(ids)!;
    expectColor(colors.subarray(0, 4) as vec4, [1.0, 0.0, 0.0, 0.0]);
    expectColor(
      colors.subarray(colors.length - 4) as vec4,
      [1.0, 0.0, 0.0, 0.0],
    );
  });

  it("cleans up WebGL state owned by a framebuffer lookup", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    const { displayState } = segmentationUserLayer;
    displayState.fragmentSegmentColor.value = `
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
  return vec3(1.0, 0.0, 0.0);
}`;
    const gl = segmentationUserLayer.manager.chunkManager.chunkQueueManager.gl;
    const initialDrawFramebuffer = gl.getParameter(
      gl.DRAW_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const initialReadFramebuffer = gl.getParameter(
      gl.READ_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const initialViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const initialProgram = gl.getParameter(
      gl.CURRENT_PROGRAM,
    ) as WebGLProgram | null;
    const initialVertexArray = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    const initialArrayBuffer = gl.getParameter(
      gl.ARRAY_BUFFER_BINDING,
    ) as WebGLBuffer | null;
    const initialActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const initialTextureBindings = new Array<WebGLTexture | null>(
      gl.maxTextureImageUnits,
    );
    for (let i = 0; i < initialTextureBindings.length; ++i) {
      gl.activeTexture(gl.TEXTURE0 + i);
      initialTextureBindings[i] = gl.getParameter(
        gl.TEXTURE_BINDING_2D,
      ) as WebGLTexture | null;
    }

    const drawFramebuffer = gl.createFramebuffer();
    const readFramebuffer = gl.createFramebuffer();
    const vertexArray = gl.createVertexArray();
    const arrayBuffer = gl.createBuffer();
    const textures = Array.from({ length: gl.maxTextureImageUnits }, () =>
      gl.createTexture(),
    );
    const activeTexture = gl.TEXTURE0 + gl.maxTextureImageUnits - 1;
    const markerShader = trivialColorShader(gl);

    try {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFramebuffer);
      gl.viewport(7, 11, 13, 17);
      markerShader.bind();
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
      for (let i = 0; i < textures.length; ++i) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, textures[i]);
      }
      gl.activeTexture(activeTexture);

      expectColor(displayState.getShaderBaseSegmentColor(1n)!, [1, 0, 0, 0]);
      expect(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)).toBe(null);
      expect(gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)).toBe(null);
      expect(gl.getParameter(gl.CURRENT_PROGRAM)).toBe(null);
      expect(gl.getParameter(gl.VERTEX_ARRAY_BINDING)).toBe(null);
      expect(gl.getParameter(gl.ARRAY_BUFFER_BINDING)).toBe(null);
      expect(gl.getParameter(gl.ACTIVE_TEXTURE)).toBe(gl.TEXTURE0);
      expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(null);
      gl.activeTexture(gl.TEXTURE1);
      expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(textures[1]);
      gl.activeTexture(gl.TEXTURE0 + gl.tempTextureUnit);
      expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(null);
    } finally {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, initialDrawFramebuffer);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, initialReadFramebuffer);
      gl.viewport(
        initialViewport[0],
        initialViewport[1],
        initialViewport[2],
        initialViewport[3],
      );
      gl.useProgram(initialProgram);
      gl.bindVertexArray(initialVertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, initialArrayBuffer);
      for (let i = 0; i < initialTextureBindings.length; ++i) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, initialTextureBindings[i]);
      }
      gl.activeTexture(initialActiveTexture);
      gl.deleteFramebuffer(drawFramebuffer);
      gl.deleteFramebuffer(readFramebuffer);
      gl.deleteVertexArray(vertexArray);
      gl.deleteBuffer(arrayBuffer);
      for (const texture of textures) gl.deleteTexture(texture);
    }
  });

  it("does not apply hover highlighting to offscreen color lookups", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.segmentStatedColors.value.set(
      1n,
      BigInt(packColor(vec3.fromValues(1.0, 0.0, 0.0))),
    );
    segmentationUserLayer.displayState.segmentSelectionState.set(1n);

    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
  });

  it("uses the fallback shader if segment properties have not been loaded", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property redTag(type="tag")
          vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
              if (redTag) {
                  return vec3(1.0, 0.0, 0.0);
              }
              return vec3(0.0, 0.0, 0.0);
          }`;

    expect(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n),
    ).toBeDefined();
  });

  it("colors by string properties", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "color",
          type: "string",
          values: ["red", "green"],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property colorProperty(type="string")
  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
      if (!hasProperties) {
        return vec3(0.0, 0.0, 1.0);
      }
      if (colorProperty == "red") {
          return vec3(1.0, 0.0, 0.0);
      }
      if (colorProperty == "green") {
          return vec3(0.0, 1.0, 0.0);
      }
      return vec3(0.5, 0.5, 0.5);
  }`;
    setSegmentPropertyControl(segmentationUserLayer, "colorProperty", {
      type: "string",
      id: "color",
    });
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(3n)!,
      [0.0, 0.0, 1.0, 0.0],
    );
  });

  it("colors by string literals with ids greater than 255", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n]),
      properties: [
        {
          id: "color",
          type: "string",
          values: ["target"],
        },
      ],
    });
    const precedingLiterals = Array.from(
      { length: 256 },
      (_, index) => `"unused${index}"`,
    ).join(" ");
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property colorProperty(type="string")
  /* ${precedingLiterals} */
  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
      if (colorProperty == "target") {
          return vec3(1.0, 0.0, 0.0);
      }
      return vec3(0.0, 0.0, 1.0);
  }`;
    setSegmentPropertyControl(segmentationUserLayer, "colorProperty", {
      type: "string",
      id: "color",
    });
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
  });

  it("defaults invalid string property control state", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n]),
      properties: [
        {
          id: "color",
          type: "string",
          values: ["red"],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property colorProperty(type="string")
  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
      if (colorProperty == "red") {
          return vec3(0.0, 1.0, 0.0);
      }
      return vec3(0.5, 0.5, 0.5);
  }`;
    const controlState =
      segmentationUserLayer.displayState.segmentColorShaderControlState.state.get(
        "colorProperty",
      );
    expect(controlState).toBeDefined();
    controlState!.trackable.restoreState({ type: "string", id: "foo" });
    expect(controlState!.trackable.value).toEqual({
      type: "string",
      id: "color",
    });
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
  });

  it("handles unmatched string property value", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n]),
      properties: [
        {
          id: "color",
          type: "string",
          values: ["foo"],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property colorProperty(type="string")
  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
      if (colorProperty != "red") {
          return vec3(0.0, 1.0, 0.0);
      }
      return vec3(0.5, 0.5, 0.5);
  }`;
    setSegmentPropertyControl(segmentationUserLayer, "colorProperty", {
      type: "string",
      id: "color",
    });
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
  });

  it("colors by tag", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "tag1",
          type: "tags",
          tags: ["red", "blue"],
          tagDescriptions: ["red", "blue"],
          values: ["\u0000", "\u0001"],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property redTag(type="tag")
#uicontrol property blueTag(type="tag")
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (!hasProperties) {
      return vec3(0.0, 1.0, 0.0);
    }
    if (redTag) {
        return vec3(1.0, 0.0, 0.0);
    }
    if (blueTag) {
        return vec3(0.0, 0.0, 1.0);
    }
    return vec3(0.3, 0.6, 0.9);
}`;
    setSegmentPropertyControl(segmentationUserLayer, "redTag", {
      type: "tag",
      id: "red",
    });
    setSegmentPropertyControl(segmentationUserLayer, "blueTag", {
      type: "tag",
      id: "blue",
    });
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [0.0, 0.0, 1.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(3n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(0n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
  });

  it("colors by tag helper", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "tag1",
          type: "tags",
          tags: ["red", "blue"],
          tagDescriptions: ["red", "blue"],
          values: ["\u0000", "\u0001"],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (!hasProperties) {
      return vec3(0.0, 1.0, 0.0);
    }
    if (tag("red")) {
        return vec3(1.0, 0.0, 0.0);
    }
    if (tag("blue")) {
        return vec3(0.0, 0.0, 1.0);
    }
    return vec3(0.3, 0.6, 0.9);
}`;
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [0.0, 0.0, 1.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(3n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
  });

  it("reports shader error for missing tag helper", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n]),
      properties: [
        {
          id: "tag1",
          type: "tags",
          tags: ["red"],
          tagDescriptions: ["red"],
          values: ["\u0000"],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (tag("blue")) {
      return vec3(0.0, 0.0, 1.0);
    }
    float otherError = missingValue;
    return vec3(0.0, 0.0, 0.0);
}`;
    expect(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n),
    ).toBeDefined();
    const shaderError = segmentationUserLayer.displayState.shaderError.value;
    expect(shaderError).toBeInstanceOf(ShaderCompilationError);
    expect(shaderError!.message).toContain(
      `'tag("blue")' : tag does not exist`,
    );
    expect(shaderError!.message).not.toContain(
      `'' :  'tag("blue")' : tag does not exist`,
    );
    expect(shaderError!.message).not.toContain(
      "no matching overloaded function found",
    );
    expect(shaderError!.message).toContain("missingValue");
    expect(
      (shaderError as ShaderCompilationError).errorMessages.find((x) =>
        x.message.includes(`'tag("blue")' : tag does not exist`),
      )?.line,
    ).toBe(2);
    expect(
      (shaderError as ShaderCompilationError).errorMessages.find((x) =>
        x.message.includes("missingValue"),
      )?.line,
    ).toBe(5);
  });

  it("colors by numerical property uint8", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "prop1",
          type: "number",
          dataType: DataType.UINT8,
          values: new Uint8Array([0, 50]),
          description: "prop1",
          bounds: [0, 100],
        },
      ],
    });

    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property prop1Property(type="number")
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (prop1Property == 50u) {
      return vec3(1.0, 0.0, 0.0);
    }
    return vec3(0.0, 0.0, 0.0);
}`;
    setSegmentPropertyControl(segmentationUserLayer, "prop1Property", {
      type: "numerical",
      id: "prop1",
    });
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [0.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
  });

  it("preserves integer and zero numerical property values", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "score",
          type: "number",
          dataType: DataType.UINT32,
          description: undefined,
          values: Uint32Array.of(4_000_000_001, 0),
          bounds: [0, 4_000_000_001],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property scoreProperty(type="number")
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
  if (!hasProperties) return vec3(0.0, 0.0, 1.0);
  if (scoreProperty == 4000000001u) return vec3(1.0, 0.0, 0.0);
  if (scoreProperty == 0u) return vec3(0.0, 1.0, 0.0);
  return vec3(0.0, 0.0, 0.0);
}`;
    setSegmentPropertyControl(segmentationUserLayer, "scoreProperty", {
      type: "numerical",
      id: "score",
    });

    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
  });

  it("colors by numerical property helper", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "prop1",
          type: "number",
          dataType: DataType.UINT8,
          values: new Uint8Array([0, 50]),
          description: "prop1",
          bounds: [0, 100],
        },
      ],
    });

    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (prop("prop1") == 50u) {
      return vec3(1.0, 0.0, 0.0);
    }
    return vec3(0.0, 0.0, 0.0);
}`;
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [0.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
  });

  it("reports shader error for missing property helper", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n]),
      properties: [
        {
          id: "prop1",
          type: "number",
          dataType: DataType.UINT8,
          values: new Uint8Array([0]),
          description: "prop1",
          bounds: [0, 100],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (prop("prop2") == 50u) {
      return vec3(1.0, 0.0, 0.0);
    }
    float otherError = missingValue;
    return vec3(0.0, 0.0, 0.0);
}`;
    expect(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n),
    ).toBeDefined();
    const shaderError = segmentationUserLayer.displayState.shaderError.value;
    expect(shaderError).toBeInstanceOf(ShaderCompilationError);
    expect(shaderError!.message).toContain(
      `'prop("prop2")' : property does not exist`,
    );
    expect(shaderError!.message).not.toContain(
      `'' :  'prop("prop2")' : property does not exist`,
    );
    expect(shaderError!.message).not.toContain(
      "no matching overloaded function found",
    );
    expect(shaderError!.message).toContain("missingValue");
    expect(
      (shaderError as ShaderCompilationError).errorMessages.find((x) =>
        x.message.includes(`'prop("prop2")' : property does not exist`),
      )?.line,
    ).toBe(2);
    expect(
      (shaderError as ShaderCompilationError).errorMessages.find((x) =>
        x.message.includes("missingValue"),
      )?.line,
    ).toBe(5);
  });

  it("colors by string property helper", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "color",
          type: "string",
          values: ["red", "green"],
        },
      ],
    });
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
      if (!hasProperties) {
        return vec3(0.0, 0.0, 1.0);
      }
      if (prop("color") == "red") {
          return vec3(1.0, 0.0, 0.0);
      }
      if (prop("color") == "green") {
          return vec3(0.0, 1.0, 0.0);
      }
      return vec3(0.5, 0.5, 0.5);
  }`;
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(3n)!,
      [0.0, 0.0, 1.0, 0.0],
    );
  });

  it("colors by numerical property invlerp", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "prop1",
          type: "number",
          dataType: DataType.UINT8,
          values: new Uint8Array([0, 50]),
          description: "prop1",
          bounds: [0, 100],
        },
      ],
    });

    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol invlerp normalized(property="prop1", range=[0, 100])
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
  return vec3(normalized(), 0.0, 0.0);
}`;
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [0.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [0.5, 0.0, 0.0, 0.0],
    );
  });

  it("colors by numerical property float", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    setSegmentPropertyMap(segmentationUserLayer, {
      ids: new BigUint64Array([1n, 2n]),
      properties: [
        {
          id: "prop1",
          type: "number",
          dataType: DataType.FLOAT32,
          values: new Float32Array([0, 0.75]),
          description: "prop1",
          bounds: [0, 100],
        },
      ],
    });

    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
#uicontrol property prop1Property(type="number")
vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
  return vec3(prop1Property, 0.0, 0.0);
}`;
    setSegmentPropertyControl(segmentationUserLayer, "prop1Property", {
      type: "numerical",
      id: "prop1",
    });
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(1n)!,
      [0.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderBaseSegmentColor(2n)!,
      [0.75, 0.0, 0.0, 0.0],
    );
  });
});
