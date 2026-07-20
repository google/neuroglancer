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

  it("returns undefined if segment properties have not been loaded and shader uses properties", () => {
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
    ).toBeUndefined();
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
    ).toBeUndefined();
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
    ).toBeUndefined();
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
