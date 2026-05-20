/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Pure-data helpers for hooking zarr-vectors skeleton chunks into the
 * existing neuroglancer skeleton shader machinery:
 *
 * - `buildVertexAttributeMap` constructs the
 *   `Map<name, VertexAttributeInfo>` the skeleton render layer uses to
 *   generate `prop_<name>()` shader macros.  Order matches the backend's
 *   `chunk.vertexAttributes` packing: synthesised `tangent` (vec3
 *   float32) first for streamline / polyline geometries, then user-
 *   declared attributes in declaration order.
 *
 * - `DEFAULT_STREAMLINE_FRAGMENT_MAIN` is the recommended default
 *   shader for streamline stores — maps the unit-sphere direction of
 *   the tangent to RGB (the standard tractography colour-by-direction
 *   convention).  Users paste it into the segmentation layer's
 *   skeleton-shader UI; a follow-up to slice 4d will auto-apply it at
 *   layer-mount time via a segmentation-layer hook.
 *
 * Lives in its own module (separate from `skeleton_frontend.ts`) so
 * unit tests can import it under Node without dragging in WebGL-coupled
 * symbols from `src/skeleton/frontend.ts`.
 */

import type { ZarrVectorsAttributeDtype } from "#src/datasource/zarr-vectors/base.js";
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import { DataType } from "#src/util/data_type.js";

/**
 * Map a zarr-vectors-declared attribute dtype to neuroglancer's
 * `DataType` enum.  These are the only dtypes the skeleton render
 * layer can sample per-vertex attributes for.
 */
const ATTR_DTYPE_TO_DATA_TYPE: Record<ZarrVectorsAttributeDtype, DataType> = {
  float32: DataType.FLOAT32,
  uint8: DataType.UINT8,
  uint16: DataType.UINT16,
  uint32: DataType.UINT32,
  int8: DataType.INT8,
  int16: DataType.INT16,
  int32: DataType.INT32,
};

/**
 * Build the `Map<name, VertexAttributeInfo>` the skeleton render layer
 * uses to set up texture bindings and generate `prop_<name>()` shader
 * macros.  See module docstring for the ordering contract with the
 * backend.
 */
export function buildVertexAttributeMap(parameters: {
  attributeNames: string[];
  attributeDtypes: ZarrVectorsAttributeDtype[];
  geometryKind: "streamline" | "polyline" | "skeleton";
}): Map<string, VertexAttributeInfo> {
  const map = new Map<string, VertexAttributeInfo>();
  if (
    parameters.geometryKind === "streamline" ||
    parameters.geometryKind === "polyline"
  ) {
    map.set("tangent", { dataType: DataType.FLOAT32, numComponents: 3 });
  }
  for (let i = 0; i < parameters.attributeNames.length; ++i) {
    map.set(parameters.attributeNames[i], {
      dataType: ATTR_DTYPE_TO_DATA_TYPE[parameters.attributeDtypes[i]],
      numComponents: 1,
    });
  }
  return map;
}

/**
 * Default skeleton-shader fragment-main text for **streamline** stores:
 * map the unit-sphere direction of the tangent at each vertex to an
 * RGB colour — the standard tractography "colour-by-direction"
 * convention.
 *
 * Uses the `prop_tangent()` macro that the existing skeleton render-
 * layer shader builder auto-generates from any per-vertex attribute
 * declared in the source's `vertexAttributes` map.
 * `buildVertexAttributeMap` places the synthesised tangent in that map
 * for streamline / polyline geometries, so the macro is always
 * resolvable when this shader runs.
 *
 * Until the segmentation-layer mount path grows a hook for per-source
 * default-shader injection, users plug this into the segmentation
 * layer's skeleton-shader UI box manually (or via the layer's URL JSON
 * state under the standard `skeletonShader` field).
 */
export const DEFAULT_STREAMLINE_FRAGMENT_MAIN = `void main() {
  vec3 d = prop_tangent();
  emitRGB(vec3(abs(d.x), abs(d.y), abs(d.z)));
}
`;
