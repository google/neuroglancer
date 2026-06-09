/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAMLINE_FRAGMENT_MAIN,
  buildVertexAttributeMap,
} from "#src/datasource/zarr-vectors/skeleton_shader_bridge.js";
import { DataType } from "#src/util/data_type.js";

describe("buildVertexAttributeMap — `prop_<name>()` shader bridge", () => {
  it("prepends a synthesised tangent vec3 for streamline geometry", () => {
    const map = buildVertexAttributeMap({
      attributeNames: [],
      attributeDtypes: [],
      geometryKind: "streamline",
    });
    expect(Array.from(map.keys())).toEqual(["tangent"]);
    const tangent = map.get("tangent")!;
    expect(tangent.dataType).toBe(DataType.FLOAT32);
    expect(tangent.numComponents).toBe(3);
  });

  it("prepends tangent for polyline geometry too", () => {
    const map = buildVertexAttributeMap({
      attributeNames: [],
      attributeDtypes: [],
      geometryKind: "polyline",
    });
    expect(Array.from(map.keys())).toEqual(["tangent"]);
  });

  it("prepends tangent for skeleton geometry (edge-adjacency tangent → prop_tangent())", () => {
    const map = buildVertexAttributeMap({
      attributeNames: [],
      attributeDtypes: [],
      geometryKind: "skeleton",
    });
    expect(Array.from(map.keys())).toEqual(["tangent"]);
  });

  it("prepends tangent for graph geometry (edge-adjacency tangent algorithm)", () => {
    const map = buildVertexAttributeMap({
      attributeNames: [],
      attributeDtypes: [],
      geometryKind: "graph",
    });
    expect(Array.from(map.keys())).toEqual(["tangent"]);
  });

  it("appends user-declared attributes after the tangent in declaration order", () => {
    const map = buildVertexAttributeMap({
      attributeNames: ["radius", "label"],
      attributeDtypes: ["float32", "uint16"],
      geometryKind: "streamline",
    });
    expect(Array.from(map.keys())).toEqual(["tangent", "radius", "label"]);
    expect(map.get("radius")).toEqual({
      dataType: DataType.FLOAT32,
      numComponents: 1,
    });
    expect(map.get("label")).toEqual({
      dataType: DataType.UINT16,
      numComponents: 1,
    });
  });

  it("maps every zarr-vectors attribute dtype to a neuroglancer DataType", () => {
    const map = buildVertexAttributeMap({
      attributeNames: ["a", "b", "c", "d", "e", "f", "g"],
      attributeDtypes: [
        "float32",
        "uint8",
        "uint16",
        "uint32",
        "int8",
        "int16",
        "int32",
      ],
      geometryKind: "skeleton",
    });
    expect(map.get("a")!.dataType).toBe(DataType.FLOAT32);
    expect(map.get("b")!.dataType).toBe(DataType.UINT8);
    expect(map.get("c")!.dataType).toBe(DataType.UINT16);
    expect(map.get("d")!.dataType).toBe(DataType.UINT32);
    expect(map.get("e")!.dataType).toBe(DataType.INT8);
    expect(map.get("f")!.dataType).toBe(DataType.INT16);
    expect(map.get("g")!.dataType).toBe(DataType.INT32);
  });

  it("ordering matches the backend's chunk.vertexAttributes packing convention", () => {
    // The backend (skeleton_backend.ts) packs:
    //   [tangent? , user_attr_0, user_attr_1, ...]
    // The frontend map produces:
    //   [tangent? , user_attr_0, user_attr_1, ...]
    // — same order, so the shader's `prop_<name>()` macros bind to the
    // right texture sampler.  Verify ordering invariant across all
    // geometry kinds.
    const cases: Array<{
      kind: "streamline" | "polyline" | "skeleton" | "graph";
      expectedKeys: string[];
    }> = [
      { kind: "streamline", expectedKeys: ["tangent", "u", "v"] },
      { kind: "polyline", expectedKeys: ["tangent", "u", "v"] },
      { kind: "skeleton", expectedKeys: ["tangent", "u", "v"] },
      { kind: "graph", expectedKeys: ["tangent", "u", "v"] },
    ];
    for (const { kind, expectedKeys } of cases) {
      const map = buildVertexAttributeMap({
        attributeNames: ["u", "v"],
        attributeDtypes: ["float32", "uint8"],
        geometryKind: kind,
      });
      expect(Array.from(map.keys())).toEqual(expectedKeys);
    }
  });
});

describe("DEFAULT_STREAMLINE_FRAGMENT_MAIN", () => {
  it("references prop_tangent() (the shader-bridge name buildVertexAttributeMap produces)", () => {
    expect(DEFAULT_STREAMLINE_FRAGMENT_MAIN).toContain("prop_tangent()");
  });

  it("maps direction components to [0, 1] via abs() (standard tractography colour-by-direction)", () => {
    // |d| ∈ [0, 1] for a unit-tangent → safe to feed into emitRGB.
    expect(DEFAULT_STREAMLINE_FRAGMENT_MAIN).toMatch(/abs\(/);
    expect(DEFAULT_STREAMLINE_FRAGMENT_MAIN).toContain("emitRGB");
  });

  it("has a void-main GLSL entry point", () => {
    expect(DEFAULT_STREAMLINE_FRAGMENT_MAIN).toMatch(/^void main\(\) \{/);
  });
});
