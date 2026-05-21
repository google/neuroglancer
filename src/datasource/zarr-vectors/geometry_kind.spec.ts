/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAMLINE_FRAGMENT_MAIN,
  KIND_CAPABILITIES,
  hasSynthesisedTangent,
  type ZarrVectorsGeometryKind,
} from "#src/datasource/zarr-vectors/geometry_kind.js";

const ALL_KINDS: readonly ZarrVectorsGeometryKind[] = [
  "streamline",
  "polyline",
  "skeleton",
  "graph",
];

describe("KIND_CAPABILITIES table invariants", () => {
  it("has an entry for every declared kind", () => {
    for (const kind of ALL_KINDS) {
      expect(KIND_CAPABILITIES[kind]).toBeDefined();
    }
  });

  it("at most one tangent algorithm is enabled per kind", () => {
    // Walk-order and edge-adjacency are mutually exclusive: a kind
    // picks one source-of-truth for tangents.  Both true would be
    // ambiguous; both false is fine (skeletons).
    for (const kind of ALL_KINDS) {
      const c = KIND_CAPABILITIES[kind];
      expect(
        c.hasWalkOrderTangent && c.hasEdgeAdjacencyTangent,
      ).toBe(false);
    }
  });

  it("streamline auto-applies the RGB-by-tangent default shader", () => {
    expect(KIND_CAPABILITIES.streamline.defaultFragmentMain).toBe(
      DEFAULT_STREAMLINE_FRAGMENT_MAIN,
    );
  });

  it("polyline / skeleton / graph have no auto-applied default shader", () => {
    expect(KIND_CAPABILITIES.polyline.defaultFragmentMain).toBeUndefined();
    expect(KIND_CAPABILITIES.skeleton.defaultFragmentMain).toBeUndefined();
    expect(KIND_CAPABILITIES.graph.defaultFragmentMain).toBeUndefined();
  });

  it("streamline / polyline / graph synthesise tangents; skeleton does not", () => {
    expect(hasSynthesisedTangent("streamline")).toBe(true);
    expect(hasSynthesisedTangent("polyline")).toBe(true);
    expect(hasSynthesisedTangent("graph")).toBe(true);
    expect(hasSynthesisedTangent("skeleton")).toBe(false);
  });

  it("streamline / polyline use walk-order; graph uses edge-adjacency", () => {
    expect(KIND_CAPABILITIES.streamline.hasWalkOrderTangent).toBe(true);
    expect(KIND_CAPABILITIES.polyline.hasWalkOrderTangent).toBe(true);
    expect(KIND_CAPABILITIES.graph.hasEdgeAdjacencyTangent).toBe(true);
    expect(KIND_CAPABILITIES.skeleton.hasWalkOrderTangent).toBe(false);
    expect(KIND_CAPABILITIES.skeleton.hasEdgeAdjacencyTangent).toBe(false);
  });
});
