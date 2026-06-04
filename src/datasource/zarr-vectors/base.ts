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

import type {
  AnnotationPropertySpec,
  AnnotationType,
} from "#src/annotation/index.js";

/**
 * Numpy-style dtype string for a per-vertex attribute as written by
 * zarr-vectors.  Subset that maps directly onto neuroglancer
 * annotation property serializer types.
 */
export type ZarrVectorsAttributeDtype =
  | "float32"
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32";

/**
 * How the annotation renderer should combine spatial-index levels of a
 * multi-resolution pyramid.
 *
 * - "additive": levels are non-overlapping; renderer accumulates them
 *   into the buffer (precomputed annotations' classic behavior).  Each
 *   point lives at exactly one level.
 * - "replace": levels are complete representations at decreasing
 *   fidelity; renderer picks one level per zoom (image-style).  Right
 *   choice for metanode pyramids — drawing a metanode and its children
 *   simultaneously would double-count.
 */
export type ZarrVectorsPyramidMode = "additive" | "replace";

export class ZarrVectorsAnnotationSourceParameters {
  rank: number;
  type: AnnotationType;
  properties: AnnotationPropertySpec[];
  pyramidMode: ZarrVectorsPyramidMode;
  static RPC_ID = "zarr-vectors/AnnotationSource";
}

export class ZarrVectorsAnnotationSpatialIndexSourceParameters {
  // Pipeline URL of the level directory (ends with "/"), e.g.
  // ".../store.zvr/0/".
  baseUrl: string;
  rank: number;
  // Parallel arrays: attributeNames[i] is the directory name under
  // <baseUrl>/vertex_attributes/, and attributeDtypes[i] is the numpy dtype of
  // the chunk byte blob.  Index i in this list corresponds to property
  // index i on the parent AnnotationSource.
  attributeNames: string[];
  attributeDtypes: ZarrVectorsAttributeDtype[];
  static RPC_ID = "zarr-vectors/AnnotationSpatialIndexSource";
}

/**
 * How vertex-to-vertex edges are encoded inside a chunk.  Mirrors the
 * spec's root-level ``links_convention`` field.
 *
 * - "implicit_sequential": polyline / streamline — edges go vertex
 *   ``i`` → ``i+1`` inside each fragment; the chunk has no
 *   ``links/0/<chunk>`` array.
 * - "implicit_sequential_with_branches": skeleton — implicit sequential
 *   edges plus an explicit ``links/0/<chunk>`` array of branch edges.
 * - "explicit": all edges live in ``links/0/<chunk>`` (general graphs).
 */
export type ZarrVectorsLinksConvention =
  | "implicit_sequential"
  | "implicit_sequential_with_branches"
  | "explicit";

/**
 * Geometry kind for a zarr-vectors store that routes through the
 * spatially-indexed skeleton render path (streamlines, polylines,
 * skeletons, graphs).  Drives chunk-decoder behaviour (tangent
 * synthesis algorithm) and frontend defaults (shader text).  See
 * {@link KIND_CAPABILITIES} in `geometry_kind.ts` for the per-kind
 * capability table that downstream code should consult instead of
 * spreading `geometryKind === "..."` checks.
 *
 * Aliases the canonical {@link ZarrVectorsGeometryKind} declared in
 * `geometry_kind.ts` — the legacy name is retained because the
 * parameter-class field names propagate through the RPC layer.
 */
export type ZarrVectorsSkeletonGeometryKind =
  | "streamline"
  | "polyline"
  | "skeleton"
  | "graph";

/**
 * Integer dtype for ``links/0/<chunk>``.  Writers pick the narrowest
 * width that covers ``n_vertices_in_chunk`` (see spec §7.5); the
 * reader honours whatever was declared in ``.zattrs.dtype``.  Unused
 * for stores with ``links_convention = "implicit_sequential"``.
 */
export type ZarrVectorsLinkDtype =
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "int64";

/**
 * Parameters for the spatially-indexed skeleton chunk source (pass 1).
 * Mirrors :class:`SpatiallyIndexedSkeletonSourceBackend` semantics: the
 * source enumerates chunks visible to the camera and downloads each one
 * via the zarr-vectors chunk-download orchestrator.
 *
 * One instance per **resolution level** in the multiscale pyramid.
 * ``baseUrl`` ends with ``/`` and points at the level directory (e.g.
 * ``".../store.zvr/0/"``).
 */
export class ZarrVectorsSpatiallyIndexedSkeletonSourceParameters {
  baseUrl!: string;
  rank!: number;
  /** Parallel arrays describing per-vertex attribute discovery. */
  attributeNames!: string[];
  attributeDtypes!: ZarrVectorsAttributeDtype[];
  /** From the store's ``zarr_vectors.links_convention``. */
  linksConvention!: ZarrVectorsLinksConvention;
  /** Drives tangent precomputation for streamline/polyline shaders. */
  geometryKind!: ZarrVectorsSkeletonGeometryKind;
  /**
   * Declared ``links/0/.zattrs.dtype``.  Unused when
   * ``linksConvention === "implicit_sequential"`` — keep ``"int64"`` as
   * a defensive default in that case.
   */
  linkDtype!: ZarrVectorsLinkDtype;
  /**
   * Zero-based index of this level in the multiscale pyramid (finest = 0).
   * Read by neuroglancer's spatially-indexed skeleton render layer to
   * decide which source backs the user-selected `spatialSkeletonGridLevel`.
   * See [src/skeleton/source_selection.ts:51-57]
   * (#src/skeleton/source_selection.ts) for the consumer side.
   */
  gridIndex!: number;
  static RPC_ID = "zarr-vectors/SpatiallyIndexedSkeletonSource";
}

/**
 * Parameters for the per-segment (object-keyed) skeleton chunk source
 * used by the **pass-2** rendering path.  The source is parametrised
 * the same way as pass 1 (the underlying chunk format is identical),
 * but its ``download(chunk)`` is called once per visible object_id and
 * is responsible for resolving the object's manifest in
 * ``object_index/manifests`` and aggregating its fragments across
 * chunks.
 *
 * The manifest resolution is intentionally pinned to a single
 * resolution level (typically level 0).  Pass 1 is the level-aware
 * multiscale path; pass 2 always renders the highlighted objects at
 * full fidelity.
 */
export class ZarrVectorsObjectKeyedSkeletonSourceParameters {
  baseUrl!: string;
  rank!: number;
  attributeNames!: string[];
  attributeDtypes!: ZarrVectorsAttributeDtype[];
  linksConvention!: ZarrVectorsLinksConvention;
  geometryKind!: ZarrVectorsSkeletonGeometryKind;
  linkDtype!: ZarrVectorsLinkDtype;
  static RPC_ID = "zarr-vectors/ObjectKeyedSkeletonSource";
}
