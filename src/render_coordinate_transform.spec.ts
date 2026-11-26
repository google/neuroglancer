import { describe, expect, it } from "vitest";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
} from "#src/coordinate_transform.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import {
  get3dModelToDisplaySpaceMatrix,
  getRenderLayerTransform,
} from "#src/render_coordinate_transform.js";
import { mat4 } from "#src/util/geom.js";

function makeSpace(names: string[]) {
  return makeCoordinateSpace({
    names,
    units: names.map(() => "m"),
    scales: new Float64Array(names.length).fill(1),
  });
}

function makeLayerTransform(options: {
  globalNames: string[];
  localNames: string[];
  layerNames: string[];
}): RenderLayerTransform {
  const transform = getRenderLayerTransform(
    makeSpace(options.globalNames),
    makeSpace(options.localNames),
    makeIdentityTransform(makeSpace(options.layerNames)),
    undefined,
  );
  if (transform.error !== undefined) throw new Error(transform.error);
  return transform;
}

function makeDisplayDimensionRenderInfo(
  globalNames: string[],
  displayNames: string[],
): DisplayDimensionRenderInfo {
  const displayDimensionIndices = new Int32Array(3).fill(-1);
  displayNames.forEach((name, displayDim) => {
    displayDimensionIndices[displayDim] = globalNames.indexOf(name);
  });
  return {
    globalRank: globalNames.length,
    globalDimensionNames: globalNames,
    displayRank: displayNames.length,
    displayDimensionIndices,
    voxelPhysicalScales: new Float64Array(3).fill(1),
    displayDimensionUnits: ["m", "m", "m"],
    displayDimensionScales: new Float64Array(3).fill(1),
    canonicalVoxelPhysicalSize: 1,
    canonicalVoxelFactors: new Float64Array(3).fill(1),
  };
}

describe("get3dModelToDisplaySpaceMatrix", () => {
  it("names the display dimension that the layer does not have", () => {
    const transform = makeLayerTransform({
      globalNames: ["g", "y", "z", "b"],
      localNames: [],
      layerNames: ["g", "y", "z"],
    });
    const displayInfo = makeDisplayDimensionRenderInfo(
      ["g", "y", "z", "b"],
      ["g", "y", "b"],
    );
    expect(() =>
      get3dModelToDisplaySpaceMatrix(mat4.create(), displayInfo, transform),
    ).toThrow(
      "Display dimension b is not a dimension of this layer (g,\u00a0y,\u00a0z). " +
        "Choose display dimensions from the layer's dimensions.",
    );
  });

  it("says three display dimensions are needed when fewer are set", () => {
    const transform = makeLayerTransform({
      globalNames: ["x", "y"],
      localNames: ["c'"],
      layerNames: ["x", "y", "c'"],
    });
    const displayInfo = makeDisplayDimensionRenderInfo(["x", "y"], ["x", "y"]);
    expect(() =>
      get3dModelToDisplaySpaceMatrix(mat4.create(), displayInfo, transform),
    ).toThrow(
      "This layer needs 3 display dimensions, but there are 2 (x,\u00a0y)",
    );
  });

  it("names the display dimension that the layer does not have even when fewer than three are displayed", () => {
    const transform = makeLayerTransform({
      globalNames: ["g", "y", "z", "b"],
      localNames: [],
      layerNames: ["g", "y", "z"],
    });
    const displayInfo = makeDisplayDimensionRenderInfo(
      ["g", "y", "z", "b"],
      ["g", "b"],
    );
    expect(() =>
      get3dModelToDisplaySpaceMatrix(mat4.create(), displayInfo, transform),
    ).toThrow("Display dimension b is not a dimension of this layer");
  });
});
