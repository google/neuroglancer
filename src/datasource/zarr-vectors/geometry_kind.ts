/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Canonical zarr-vectors geometry-kind union and per-kind capability
 * table.  Centralises the decisions that were previously scattered
 * through `skeleton_chunk.ts`, `skeleton_shader_bridge.ts`, and
 * `skeleton_frontend.ts` as ad-hoc `geometryKind === "streamline" ||
 * "polyline"` checks.  Adding a new kind (e.g. a future mesh
 * geometry that fits the same chunk layout) is a one-line edit to
 * the {@link KIND_CAPABILITIES} table.
 *
 * Naming note: the type is `ZarrVectorsGeometryKind` despite the
 * `skeleton_*` filenames that surround it.  Those filenames mirror the
 * `SkeletonChunk` data structure they back; the geometry kinds they
 * support are not strictly skeletons (graphs and streamlines also
 * route through the same chunk machinery).
 */

/**
 * Default skeleton-shader fragment-main text for **streamline** stores:
 * map the unit-sphere direction of the tangent at each vertex to an
 * RGB colour — the standard tractography "colour-by-direction"
 * convention.  Hosts of the `prop_tangent()` macro consume the
 * synthesised per-vertex tangent attribute the chunk decoder produces
 * for kinds where {@link hasSynthesisedTangent} is true.
 *
 * Defined here (rather than `skeleton_shader_bridge.ts`) so the
 * capability table below can reference it without introducing a
 * value-level import cycle.  `skeleton_shader_bridge.ts` re-exports
 * for callers that imported it from there before the refactor.
 */
export const DEFAULT_STREAMLINE_FRAGMENT_MAIN = `void main() {
  vec3 d = prop_tangent();
  emitRGB(vec3(abs(d.x), abs(d.y), abs(d.z)));
}
`;

/**
 * The geometry-type strings zarr-vectors emits in its
 * `zarr_vectors.geometry_types` root attribute that route through the
 * spatially-indexed-skeleton render path.  Other kinds (notably
 * `"point_cloud"` and `"mesh"`) are handled elsewhere.
 */
export type ZarrVectorsGeometryKind =
  | "streamline"
  | "polyline"
  | "skeleton"
  | "graph";

/** Per-kind metadata consumed by the chunk decoder, shader bridge, and
 *  frontend chunk-source classes. */
export interface GeometryKindCapabilities {
  /**
   * Whether the chunk decoder should synthesise a per-vertex
   * `tangent` (vec3) by walking the fragment index in implicit-
   * sequential order.  True only for `streamline` and `polyline`
   * geometries — those have a well-defined walk direction at every
   * vertex, including endpoints, which we need so that cross-chunk
   * ghost-tangent signs match up across bridge edges (see
   * `appendGhostVertices`).
   */
  readonly hasWalkOrderTangent: boolean;
  /**
   * Whether the chunk decoder should synthesise per-vertex tangents
   * from the edge adjacency (degree-2 vertices get the central
   * difference; degree-1 endpoints get the direction to their lone
   * neighbour; branch points pick the central difference of the
   * first two listed neighbours).  True for `graph`: the on-disk
   * `links/0/<chunk>` array carries the full edge structure and
   * walk-order is undefined, but most non-branch vertices still
   * have a meaningful direction.  Skeletons could opt in similarly
   * but currently don't, preserving prior "no tangents for
   * skeletons" behaviour until a use case shows up.
   */
  readonly hasEdgeAdjacencyTangent: boolean;
  /**
   * Renderer's default shader text (paste-in for users); `undefined`
   * falls back to the neuroglancer-built-in segment-coloured default.
   * Only streamlines auto-apply the RGB-by-tangent default; for
   * polylines, skeletons, and graphs we leave a sensible blank so the
   * user can paste `prop_tangent()` if they want directional colour.
   */
  readonly defaultFragmentMain: string | undefined;
}

export const KIND_CAPABILITIES: Record<
  ZarrVectorsGeometryKind,
  GeometryKindCapabilities
> = {
  streamline: {
    hasWalkOrderTangent: true,
    hasEdgeAdjacencyTangent: false,
    defaultFragmentMain: DEFAULT_STREAMLINE_FRAGMENT_MAIN,
  },
  polyline: {
    hasWalkOrderTangent: true,
    hasEdgeAdjacencyTangent: false,
    defaultFragmentMain: undefined,
  },
  skeleton: {
    // Synthesise per-vertex tangents from edge adjacency so shaders can
    // `prop_tangent()` (colour-by-direction).  Branch points get the
    // central difference of their first two neighbours; the default
    // shader stays segment-coloured (tangent is opt-in, not auto-applied).
    hasWalkOrderTangent: false,
    hasEdgeAdjacencyTangent: true,
    defaultFragmentMain: undefined,
  },
  graph: {
    hasWalkOrderTangent: false,
    hasEdgeAdjacencyTangent: true,
    defaultFragmentMain: undefined,
  },
};

/** True iff the geometry has *any* synthesised per-vertex tangent
 *  (regardless of which algorithm produced it).  Drives whether the
 *  shader bridge exposes `prop_tangent()`. */
export function hasSynthesisedTangent(kind: ZarrVectorsGeometryKind): boolean {
  const caps = KIND_CAPABILITIES[kind];
  return caps.hasWalkOrderTangent || caps.hasEdgeAdjacencyTangent;
}
