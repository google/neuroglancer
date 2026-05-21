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
 *   float32) first for any geometry kind with synthesised tangents (see
 *   {@link hasSynthesisedTangent}), then user-declared attributes in
 *   declaration order.
 *
 * - `DEFAULT_STREAMLINE_FRAGMENT_MAIN` lives in `geometry_kind.ts`
 *   alongside the per-kind capability table that references it.  This
 *   module re-exports it for callers that imported it from here before
 *   the refactor.
 *
 * Lives in its own module (separate from `skeleton_frontend.ts`) so
 * unit tests can import it under Node without dragging in WebGL-coupled
 * symbols from `src/skeleton/frontend.ts`.
 */

import type { ZarrVectorsAttributeDtype } from "#src/datasource/zarr-vectors/base.js";
import type { ZarrVectorsGeometryKind } from "#src/datasource/zarr-vectors/geometry_kind.js";
import { hasSynthesisedTangent } from "#src/datasource/zarr-vectors/geometry_kind.js";
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import { DataType } from "#src/util/data_type.js";

export { DEFAULT_STREAMLINE_FRAGMENT_MAIN } from "#src/datasource/zarr-vectors/geometry_kind.js";

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
  geometryKind: ZarrVectorsGeometryKind;
}): Map<string, VertexAttributeInfo> {
  const map = new Map<string, VertexAttributeInfo>();
  if (hasSynthesisedTangent(parameters.geometryKind)) {
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
