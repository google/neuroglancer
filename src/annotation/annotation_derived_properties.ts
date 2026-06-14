/**
 * @license
 * Copyright 2024 Google Inc.
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

// Derived (computed) geometric numerical properties for annotations: length,
// area/volume, duration, delta_{dim}, extent_{dim}.  These are computed live
// from annotation geometry transformed into the view's global coordinate system
// and expressed in SI base units (meters, seconds, m^2, m^3...).  They are
// synthetic — injected into the annotation query schema/items exactly like the
// coordinate-dimension properties — and never persisted onto annotations.
//
// The module is split so that the metric math (the generator registry, operating
// on a plain PhysicalGeometry) is unit-testable without coordinate transforms,
// while extractPhysicalGeometry performs the transform-dependent extraction.

import type { Annotation } from "#src/annotation/index.js";
import { AnnotationType, annotationTypeHandlers } from "#src/annotation/index.js";
import type { AnnotationNumericPropSchema } from "#src/annotation/annotation_query.js";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { ChunkTransformParameters } from "#src/render_coordinate_transform.js";
import { DataType } from "#src/util/data_type.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import { transformPoint, transformVector } from "#src/util/matrix.js";
import { supportedUnits } from "#src/util/si_units.js";

// ============================================================================
// Dimension references and unit grouping
// ============================================================================

/** A view dimension that carries a physical unit, with the data needed to map a
 * transformed (layer-space) coordinate to an SI-base-unit physical value.  The
 * layer-dimension index is resolved per-annotation (from each annotation's own
 * transform) since it can differ between attached states. */
export interface DimRef {
  /** Display name of the dimension (e.g. "x", "t"). */
  name: string;
  /** SI base unit: "m" (spatial), "s" (temporal), "Hz", "rad/s". */
  baseUnit: string;
  /** Whether this is a global or local coordinate-space dimension. */
  scope: "global" | "local";
  /** Index into the (global or local) coordinate space. */
  coordDim: number;
  /** SI-base-units per coordinate unit (coordinateSpace.scales[coordDim]). */
  scale: number;
}

/**
 * Build the list of physical-unit dimensions visible to the annotation layer.
 * Unitless dimensions (unit === "") are skipped.
 */
export function collectPhysicalDimensions(
  coordinateSpace: CoordinateSpace,
  viewDimIndices: readonly number[],
  scope: "global" | "local",
): DimRef[] {
  const result: DimRef[] = [];
  for (const coordDim of viewDimIndices) {
    const unit = coordinateSpace.units[coordDim] ?? "";
    const baseUnit = supportedUnits.get(unit)?.unit ?? "";
    if (baseUnit === "") continue; // Unitless dimension: no derived properties.
    result.push({
      name: coordinateSpace.names[coordDim],
      baseUnit,
      scope,
      coordDim,
      scale: coordinateSpace.scales[coordDim],
    });
  }
  return result;
}

// ============================================================================
// Physical geometry
// ============================================================================

/** Annotation geometry sampled in SI base units, indexed by an active-dimension
 * layout.  `points[k][i]` is the physical coordinate of point k along active
 * dimension i; `radii[i]` is the (absolute) physical radius for an ellipsoid. */
export interface PhysicalGeometry {
  type: AnnotationType;
  points: number[][];
  radii?: number[];
}

/**
 * Extract an annotation's geometry into SI base units along the provided
 * dimensions, transforming chunk coordinates to layer space (so coordinate
 * transforms are accounted for) and scaling each dimension by its physical scale.
 */
export function extractPhysicalGeometry(
  annotation: Annotation,
  chunkTransform: ChunkTransformParameters,
  dims: readonly DimRef[],
): PhysicalGeometry {
  const { layerRank } = chunkTransform;
  const { globalToRenderLayerDimensions, localToRenderLayerDimensions } =
    chunkTransform.modelTransform;
  // Resolve each dimension's layer index from this annotation's own transform.
  const layerDims = dims.map((d) =>
    d.scope === "global"
      ? globalToRenderLayerDimensions[d.coordDim]
      : localToRenderLayerDimensions[d.coordDim],
  );
  const padded = new Float32Array(layerRank);
  const out = new Float32Array(layerRank);
  const points: number[][] = [];
  let radii: number[] | undefined;
  annotationTypeHandlers[annotation.type].visitGeometry(
    annotation,
    (vec: Float32Array, isVector: boolean) => {
      padded.fill(0);
      padded.set(vec.subarray(0, layerRank));
      (isVector ? transformVector : transformPoint)(
        out,
        chunkTransform.chunkToLayerTransform,
        layerRank + 1,
        padded,
        layerRank,
      );
      const coords = dims.map((_, i) => {
        const ld = layerDims[i];
        return ld === undefined || ld === -1 ? NaN : out[ld] * dims[i].scale;
      });
      if (isVector) {
        // Only the ellipsoid emits a vector (its radii).
        radii = coords.map(Math.abs);
      } else {
        points.push(coords);
      }
    },
  );
  return { type: annotation.type, points, radii };
}

// ============================================================================
// Derived property generators (registry)
// ============================================================================

/** Context shared by generators describing the active (relevant) dimensions. */
interface BuildContext {
  activeDims: DimRef[];
  /** Indices into `activeDims` whose baseUnit is spatial ("m"). */
  spatial: number[];
  /** Indices into `activeDims` whose baseUnit is temporal ("s"). */
  temporal: number[];
}

type DescriptorKind = "normal" | "temporalDelta";

interface DerivedPropDescriptor {
  id: string;
  description: string;
  /** Display base unit: "m" | "s" | "m^2" | "m^3" | ... */
  baseUnit: string;
  appliesTo: ReadonlySet<AnnotationType>;
  /** Compute the value in SI base units, or NaN if not applicable. */
  compute: (geom: PhysicalGeometry) => number;
  kind: DescriptorKind;
}

type DescriptorBuilder = (ctx: BuildContext) => DerivedPropDescriptor[];

const LINE_POLY = new Set([AnnotationType.LINE, AnnotationType.POLYLINE]);
const BOX_ELLIPSOID = new Set([
  AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
  AnnotationType.ELLIPSOID,
]);
const ALL_NON_POINT = new Set([
  AnnotationType.LINE,
  AnnotationType.POLYLINE,
  AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
  AnnotationType.ELLIPSOID,
]);
const POLY = new Set([AnnotationType.POLYLINE]);

/** Unit n-ball volume coefficient C_n (volume = C_n * product(radii)). */
function ballVolumeCoefficient(n: number): number {
  if (n <= 0) return 1;
  if (n === 1) return 2;
  let prev2 = 1; // C_0
  let prev1 = 2; // C_1
  for (let k = 2; k <= n; ++k) {
    const c = ((2 * Math.PI) / k) * prev2;
    prev2 = prev1;
    prev1 = c;
  }
  return prev1;
}

/** Euclidean norm of the difference of two points over the given dim indices. */
function segmentNorm(a: number[], b: number[], idx: number[]): number {
  let sum = 0;
  for (const i of idx) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// length: summed Euclidean path distance over spatial dims (lines, polylines).
const buildPathLength: DescriptorBuilder = ({ spatial }) => {
  if (spatial.length === 0) return [];
  return [
    {
      id: "length",
      description: "Euclidean path length",
      baseUnit: "m",
      appliesTo: LINE_POLY,
      kind: "normal",
      compute: (geom) => {
        const { points } = geom;
        if (points.length < 2) return NaN;
        let total = 0;
        for (let k = 1; k < points.length; ++k) {
          total += segmentNorm(points[k], points[k - 1], spatial);
        }
        return total;
      },
    },
  ];
};

// length/area/volume: spatial measure of boxes (product of |delta|) and
// ellipsoids (n-ball volume from radii), named by spatial-dimension count.
const buildSpatialMeasure: DescriptorBuilder = ({ spatial }) => {
  const n = spatial.length;
  if (n === 0) return [];
  const id = n === 1 ? "length" : n === 2 ? "area" : "volume";
  const baseUnit = n === 1 ? "m" : n === 2 ? "m^2" : "m^3";
  const coeff = ballVolumeCoefficient(n);
  return [
    {
      id,
      description:
        n === 1
          ? "Spatial extent"
          : n === 2
            ? "Spatial area"
            : "Spatial volume",
      baseUnit,
      appliesTo: BOX_ELLIPSOID,
      kind: "normal",
      compute: (geom) => {
        if (geom.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
          const { points } = geom;
          if (points.length < 2) return NaN;
          let product = 1;
          for (const i of spatial) {
            product *= Math.abs(points[0][i] - points[1][i]);
          }
          return product;
        }
        if (geom.type === AnnotationType.ELLIPSOID) {
          const { radii } = geom;
          if (radii === undefined) return NaN;
          let product = coeff;
          for (const i of spatial) product *= Math.abs(radii[i]);
          return product;
        }
        return NaN;
      },
    },
  ];
};

// duration: temporal span over temporal dims (lines, polylines, boxes, ellipsoids).
const buildDuration: DescriptorBuilder = ({ temporal }) => {
  if (temporal.length === 0) return [];
  return [
    {
      id: "duration",
      description: "Temporal duration",
      baseUnit: "s",
      appliesTo: ALL_NON_POINT,
      kind: "normal",
      compute: (geom) => {
        const { points, radii, type } = geom;
        if (type === AnnotationType.ELLIPSOID) {
          if (radii === undefined) return NaN;
          let sum = 0;
          for (const i of temporal) sum += radii[i] * radii[i];
          return 2 * Math.sqrt(sum);
        }
        if (points.length < 2) return NaN;
        let total = 0;
        for (let k = 1; k < points.length; ++k) {
          total += segmentNorm(points[k], points[k - 1], temporal);
        }
        return total;
      },
    },
  ];
};

// delta_{dim}: signed start-end per dimension (spatial for all non-point types;
// temporal only for polylines).  Ellipsoid delta is the diameter (2*radii).
const buildDeltaDims: DescriptorBuilder = ({ activeDims, spatial, temporal }) => {
  const descriptors: DerivedPropDescriptor[] = [];
  const make = (
    i: number,
    appliesTo: ReadonlySet<AnnotationType>,
    kind: DescriptorKind,
  ): DerivedPropDescriptor => {
    const dim = activeDims[i];
    return {
      id: `delta_${dim.name}`,
      description: `Signed extent along ${dim.name} (end - start)`,
      baseUnit: dim.baseUnit,
      appliesTo,
      kind,
      compute: (geom) => {
        if (geom.type === AnnotationType.ELLIPSOID) {
          return geom.radii === undefined ? NaN : 2 * geom.radii[i];
        }
        const { points } = geom;
        if (points.length < 2) return NaN;
        return points[points.length - 1][i] - points[0][i];
      },
    };
  };
  for (const i of spatial) descriptors.push(make(i, ALL_NON_POINT, "normal"));
  for (const i of temporal) descriptors.push(make(i, POLY, "temporalDelta"));
  return descriptors;
};

// extent_{dim}: max - min over all points per spatial dimension (polylines).
const buildExtentDims: DescriptorBuilder = ({ activeDims, spatial }) => {
  return spatial.map((i) => {
    const dim = activeDims[i];
    return {
      id: `extent_${dim.name}`,
      description: `Coordinate span along ${dim.name} (max - min)`,
      baseUnit: dim.baseUnit,
      appliesTo: POLY,
      kind: "normal" as DescriptorKind,
      compute: (geom: PhysicalGeometry) => {
        const { points } = geom;
        if (points.length === 0) return NaN;
        let min = Infinity;
        let max = -Infinity;
        for (const p of points) {
          const v = p[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        return max - min;
      },
    };
  });
};

const REGISTRY: DescriptorBuilder[] = [
  buildPathLength,
  buildSpatialMeasure,
  buildDuration,
  buildDeltaDims,
  buildExtentDims,
];

// ============================================================================
// Set-wide analysis
// ============================================================================

export interface DerivedAnalysisInput {
  annotations: Array<{
    id: string;
    annotation: Annotation;
    chunkTransform: ChunkTransformParameters;
  }>;
  globalCoordinateSpace: CoordinateSpace;
  localCoordinateSpace: CoordinateSpace;
  globalDimensionIndices: readonly number[];
  localDimensionIndices: readonly number[];
}

export interface DerivedAnalysisResult {
  /** Relevant derived properties, with `baseUnit` metadata, for the query schema. */
  schemas: AnnotationNumericPropSchema[];
  /** Per-annotation derived values (NaN where the property does not apply). */
  valuesByAnnotationId: Map<string, Map<string, number>>;
  /** Recompute derived values for a single annotation (e.g. for selection panel). */
  computeForAnnotation: (
    annotation: Annotation,
    chunkTransform: ChunkTransformParameters,
  ) => Map<string, number>;
  /** Warning message when measurable annotations exist but units are missing. */
  warning: string | undefined;
}

const MEASURABLE_TYPES = ALL_NON_POINT;

function computeDescriptorValues(
  descriptors: DerivedPropDescriptor[],
  geom: PhysicalGeometry,
): Map<string, number> {
  // Multiple descriptors may share an id (e.g. "length" from path-length and
  // from a 1-D box measure) with disjoint appliesTo; the applicable (finite) one
  // wins.
  const out = new Map<string, number>();
  for (const d of descriptors) {
    const value = d.appliesTo.has(geom.type) ? d.compute(geom) : NaN;
    const existing = out.get(d.id);
    if (existing === undefined || (!Number.isFinite(existing) && Number.isFinite(value))) {
      out.set(d.id, value);
    }
  }
  return out;
}

export function analyzeDerivedProperties(
  input: DerivedAnalysisInput,
): DerivedAnalysisResult {
  const {
    annotations,
    globalCoordinateSpace,
    localCoordinateSpace,
    globalDimensionIndices,
    localDimensionIndices,
  } = input;

  // Candidate physical dimensions (global then local).
  const candidateDims: DimRef[] = [
    ...collectPhysicalDimensions(
      globalCoordinateSpace,
      globalDimensionIndices,
      "global",
    ),
    ...collectPhysicalDimensions(
      localCoordinateSpace,
      localDimensionIndices,
      "local",
    ),
  ];

  const measurableExists = annotations.some(({ annotation }) =>
    MEASURABLE_TYPES.has(annotation.type),
  );
  const warning =
    measurableExists && candidateDims.length === 0
      ? "Some annotations support measurements (length, volume, duration), " +
        "but the output dimensions have no physical units. Set units for your " +
        "dimensions in the Source tab to enable these properties."
      : undefined;

  const empty: DerivedAnalysisResult = {
    schemas: [],
    valuesByAnnotationId: new Map(),
    computeForAnnotation: () => new Map(),
    warning,
  };
  if (candidateDims.length === 0 || annotations.length === 0) return empty;

  // Pass 1: extract physical geometry per annotation (over candidate dims) and
  // accumulate per-dimension global min/max to determine "active" dimensions.
  const min = new Float64Array(candidateDims.length).fill(Infinity);
  const max = new Float64Array(candidateDims.length).fill(-Infinity);
  const cached: Array<{ id: string; geom: PhysicalGeometry }> = [];
  for (const { id, annotation, chunkTransform } of annotations) {
    const geom = extractPhysicalGeometry(annotation, chunkTransform, candidateDims);
    cached.push({ id, geom });
    for (const p of geom.points) {
      for (let i = 0; i < candidateDims.length; ++i) {
        const v = p[i];
        if (!Number.isFinite(v)) continue;
        if (v < min[i]) min[i] = v;
        if (v > max[i]) max[i] = v;
      }
    }
    // Ellipsoid radii extend the spatial/temporal extent around the center.
    const { radii } = geom;
    if (radii !== undefined && geom.points.length > 0) {
      const c = geom.points[0];
      for (let i = 0; i < candidateDims.length; ++i) {
        const lo = c[i] - Math.abs(radii[i]);
        const hi = c[i] + Math.abs(radii[i]);
        if (Number.isFinite(lo) && lo < min[i]) min[i] = lo;
        if (Number.isFinite(hi) && hi > max[i]) max[i] = hi;
      }
    }
  }

  // Active dims: those that vary across the set (a coordinate that never changes
  // — e.g. t always 0 — is excluded from all calculations).
  const activeCandidate: number[] = [];
  for (let i = 0; i < candidateDims.length; ++i) {
    if (min[i] < max[i]) activeCandidate.push(i);
  }
  if (activeCandidate.length === 0) return empty;

  const activeDims = activeCandidate.map((i) => candidateDims[i]);
  // Map from a PhysicalGeometry over candidate dims → compact active layout.
  const selectActive = (geom: PhysicalGeometry): PhysicalGeometry => ({
    type: geom.type,
    points: geom.points.map((p) => activeCandidate.map((i) => p[i])),
    radii:
      geom.radii === undefined
        ? undefined
        : activeCandidate.map((i) => geom.radii![i]),
  });

  const spatial: number[] = [];
  const temporal: number[] = [];
  activeDims.forEach((d, i) => {
    if (d.baseUnit === "m") spatial.push(i);
    else if (d.baseUnit === "s") temporal.push(i);
  });

  // Build descriptors from the registry over the active dims.
  const ctx: BuildContext = { activeDims, spatial, temporal };
  const descriptors = REGISTRY.flatMap((build) => build(ctx));

  // Pass 2: compute every descriptor for every annotation.
  const valuesByAnnotationId = new Map<string, Map<string, number>>();
  // Track relevance: which ids have any nonzero finite value, and whether any
  // polyline is non-monotonic in time (for temporal delta relevance).
  const idHasNonZero = new Map<string, boolean>();
  const idHasFinite = new Map<string, boolean>();
  const idBounds = new Map<string, [number, number]>();
  let anyNonMonotonicPolyline = false;

  for (const { id, geom: candidateGeom } of cached) {
    const geom = selectActive(candidateGeom);
    const values = computeDescriptorValues(descriptors, geom);
    valuesByAnnotationId.set(id, values);
    for (const [pid, value] of values) {
      if (!Number.isFinite(value)) continue;
      idHasFinite.set(pid, true);
      if (value !== 0) idHasNonZero.set(pid, true);
      const b = idBounds.get(pid);
      if (b === undefined) idBounds.set(pid, [value, value]);
      else {
        if (value < b[0]) b[0] = value;
        if (value > b[1]) b[1] = value;
      }
    }
    // Non-monotonic check: a polyline whose summed |Δt| exceeds |net Δt| in some
    // temporal dim reverses direction; only then is delta_t not duplicative of
    // duration.
    if (geom.type === AnnotationType.POLYLINE && temporal.length > 0) {
      for (const i of temporal) {
        let sumAbs = 0;
        for (let k = 1; k < geom.points.length; ++k) {
          sumAbs += Math.abs(geom.points[k][i] - geom.points[k - 1][i]);
        }
        const net = Math.abs(
          geom.points[0][i] - geom.points[geom.points.length - 1][i],
        );
        if (sumAbs - net > 1e-30) anyNonMonotonicPolyline = true;
      }
    }
  }

  // Determine which descriptor ids survive relevance pruning.
  const survivingIds = new Set<string>();
  for (const d of descriptors) {
    if (!idHasFinite.get(d.id)) continue; // no applicable annotation
    if (!idHasNonZero.get(d.id)) continue; // all-zero → trivial
    if (d.kind === "temporalDelta" && !anyNonMonotonicPolyline) continue;
    survivingIds.add(d.id);
  }

  // Build schemas (one per surviving id; dedupe shared ids).
  const schemas: AnnotationNumericPropSchema[] = [];
  const seen = new Set<string>();
  for (const d of descriptors) {
    if (!survivingIds.has(d.id) || seen.has(d.id)) continue;
    seen.add(d.id);
    const bounds = idBounds.get(d.id)!;
    schemas.push({
      identifier: d.id,
      dataType: DataType.FLOAT32,
      bounds: [bounds[0], bounds[1]] as DataTypeInterval,
      description: d.description,
      baseUnit: d.baseUnit,
    });
  }

  // Prune non-surviving ids from the per-annotation value maps.
  for (const values of valuesByAnnotationId.values()) {
    for (const pid of [...values.keys()]) {
      if (!survivingIds.has(pid)) values.delete(pid);
    }
  }

  const survivingDescriptors = descriptors.filter((d) =>
    survivingIds.has(d.id),
  );
  const computeForAnnotation = (
    annotation: Annotation,
    chunkTransform: ChunkTransformParameters,
  ): Map<string, number> => {
    const geom = selectActive(
      extractPhysicalGeometry(annotation, chunkTransform, candidateDims),
    );
    const values = computeDescriptorValues(survivingDescriptors, geom);
    for (const pid of [...values.keys()]) {
      if (!survivingIds.has(pid)) values.delete(pid);
    }
    return values;
  };

  return { schemas, valuesByAnnotationId, computeForAnnotation, warning };
}

// ============================================================================
// Display formatting
// ============================================================================

const SUPERSCRIPT: Record<string, string> = { "2": "²", "3": "³" };

/** Pretty unit label for a column header / value suffix ("m" → "m", "m^2" → "m²"). */
export function prettyUnit(baseUnit: string): string {
  const m = baseUnit.match(/^([a-zA-Z/]+)\^(\d+)$/);
  if (m !== null) return `${m[1]}${SUPERSCRIPT[m[2]] ?? `^${m[2]}`}`;
  return baseUnit;
}
