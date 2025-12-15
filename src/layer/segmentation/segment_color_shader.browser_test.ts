import { describe, it, expect } from "vitest";
import { DisplayContext } from "#src/display_context.js";
import { ManagedUserLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import {
  PreprocessedSegmentPropertyMap,
  SegmentPropertyMap,
} from "#src/segmentation_display_state/property_map.js";
import { vec4 } from "#src/util/geom.js";
import { Viewer } from "#src/viewer.js";

const setupSegmentationLayer = () => {
  const target = document.createElement("div");
  const display = new DisplayContext(target);
  const viewer = new Viewer(display);
  return new SegmentationUserLayer(
    new ManagedUserLayer("test", viewer.layerSpecification),
  );
};

const compareWithCPUHash = (
  segmentationUserLayer: SegmentationUserLayer,
  objectId: bigint,
) => {
  const outColor =
    segmentationUserLayer.displayState.getShaderSegmentColor(objectId);
  const colorGroupState =
    segmentationUserLayer.displayState.segmentationColorGroupState.value;
  const outColorCPU = vec4.create();
  colorGroupState.segmentColorHash.compute(outColorCPU, objectId);
  expect(outColor).toBeDefined();
  expect(outColor!.length).toBe(4);
  // console.log("comparing colors", outColor!.join(','), outColorCPU.join(','));
  for (let i = 0; i < 4; ++i) {
    expect(outColor![i]).toBeCloseTo(outColorCPU[i]);
  }
};

const expectColor = (
  color: vec4,
  expected: [number, number, number, number],
) => {
  expect(color).toBeDefined();
  expect(color!.length).toBe(4);

  console.log("color", color.join(","), "expected", expected.join(","));

  for (let i = 0; i < 4; ++i) {
    expect(color[i]).toBeCloseTo(expected[i]);
  }

  for (let i = 0; i < 4; ++i) {
    expect(color[i]).toBeCloseTo(expected[i]);
  }
};

describe("getShaderSegmentColor", () => {
  it("only segment id, return hash", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    const objectId = 1n;
    compareWithCPUHash(segmentationUserLayer, objectId);
  });
  it("random value hash", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    const objectId = BigInt(Math.floor(Math.random() * 100000));
    compareWithCPUHash(segmentationUserLayer, objectId);
  });
  it("return red", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
  vec3 segmentColor(vec3 color, bool hasProperties) {
      return vec3(1.0, 0.0, 0.0);
  }`;
    const outColor =
      segmentationUserLayer.displayState.getShaderSegmentColor(1n);
    expectColor(outColor!, [1.0, 0.0, 0.0, 0.0]);
  });

  it("use default shader if segment properties have not been loaded and shader uses properties", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
          vec3 segmentColor(vec3 color, bool hasProperties) {
              if (tag("red")) {
                  return vec3(1.0, 0.0, 0.0);
              }
              return vec3(0.0, 0.0, 0.0);
          }`;

    compareWithCPUHash(segmentationUserLayer, 1n);
  });

  it("colors by tag", () => {
    const segmentationUserLayer = setupSegmentationLayer();
    segmentationUserLayer.displayState.segmentPropertyMap.value =
      new PreprocessedSegmentPropertyMap(
        new SegmentPropertyMap({
          inlineProperties: {
            ids: new BigUint64Array([1n, 2n]),
            properties: [
              {
                id: "tag1",
                type: "tags",
                tags: ["red", "blue"],
                tagDescriptions: ["red", "blue"],
                values: ["\u0000", "\u0001"], // segment 1 has tag "red", segment 2 has tag "blue"
              },
            ],
          },
        }),
      );
    segmentationUserLayer.displayState.fragmentSegmentColor.value = `
vec3 segmentColor(vec3 color, bool hasProperties) {
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
      segmentationUserLayer.displayState.getShaderSegmentColor(1n)!,
      [1.0, 0.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderSegmentColor(2n)!,
      [0.0, 0.0, 1.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderSegmentColor(3n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
    expectColor(
      segmentationUserLayer.displayState.getShaderSegmentColor(0n)!,
      [0.0, 1.0, 0.0, 0.0],
    );
  });
});
