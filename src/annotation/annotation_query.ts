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

// Annotation query engine: parse, execute, and compute histograms for
// annotation-list filtering/sorting.  Mirrors the segment query engine in
// segmentation_display_state/property_map.ts but is row-major (each annotation
// carries its own property values) rather than columnar.

import type {
  AnnotationNumericPropertySpec,
  AnnotationPropertySpec,
} from "#src/annotation/index.js";
import { propertyTypeDataType } from "#src/annotation/index.js";
import type {
  NumericalPropertyConstraint,
  QueryParseError,
  SortBy,
} from "#src/segmentation_display_state/property_map.js";
import type { SerializablePropertyQueryClause } from "#src/ui/property_query.js";
import {
  resolvePropertyQuery,
  serializePropertyQueryClauses,
} from "#src/ui/property_query.js";
import type {
  NumericalPropertyHistogram,
  NumericalSummaryDataSource,
  NumericalSummaryProperty,
  NumericalSummaryQuery,
  NumericalSummaryQueryResult,
} from "#src/ui/property_summary.js";
import { DataType } from "#src/util/data_type.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";

// ============================================================================
// Schema types
// ============================================================================

export interface AnnotationNumericPropSchema {
  identifier: string;
  dataType: DataType;
  bounds: DataTypeInterval;
  description?: string;
  /** SI base unit for derived/computed properties (e.g. "m", "s", "m^3"). */
  baseUnit?: string;
}

export interface AnnotationEnumPropSchema {
  identifier: string;
  /** Raw numeric enum values (e.g. [0, 1, 2]). */
  enumValues: number[];
  /** Human-readable labels corresponding to each enumValue. */
  enumLabels: string[];
  description?: string;
}

export interface AnnotationBoolPropSchema {
  identifier: string;
  description?: string;
}

/** Partitioned schema derived from a deduplicated AnnotationPropertySpec list. */
export interface AnnotationQuerySchema {
  /** Plain numeric properties (no enumValues). */
  numericProps: AnnotationNumericPropSchema[];
  /** Numeric properties that have enumValues/enumLabels. */
  enumProps: AnnotationEnumPropSchema[];
  /** Boolean properties. */
  boolProps: AnnotationBoolPropSchema[];
}

/**
 * Build a query schema from a deduplicated list of annotation property specs.
 * @param coordDims  Optional coordinate dimensions to add as float32 numeric props.
 *                   Skipped if their id conflicts with an existing property identifier.
 */
export function buildAnnotationQuerySchema(
  specs: AnnotationPropertySpec[],
  coordDims?: Array<{ id: string; description?: string }>,
  typeProp?: AnnotationEnumPropSchema,
  derivedProps?: AnnotationNumericPropSchema[],
): AnnotationQuerySchema {
  const numericProps: AnnotationNumericPropSchema[] = [];
  const enumProps: AnnotationEnumPropSchema[] = [];
  const boolProps: AnnotationBoolPropSchema[] = [];

  for (const spec of specs) {
    if (spec.type === "rgb" || spec.type === "rgba") continue;
    if (spec.type === "bool") {
      boolProps.push({
        identifier: spec.identifier,
        description: spec.description ?? undefined,
      });
      continue;
    }
    const numSpec = spec as AnnotationNumericPropertySpec;
    const dataType = propertyTypeDataType[spec.type]!;
    const defaultRange = defaultDataTypeRange[dataType] as DataTypeInterval;
    const bounds: DataTypeInterval = [
      numSpec.min ?? (defaultRange[0] as number),
      numSpec.max ?? (defaultRange[1] as number),
    ] as DataTypeInterval;
    if (numSpec.enumValues !== undefined && numSpec.enumValues.length > 0) {
      enumProps.push({
        identifier: spec.identifier,
        enumValues: numSpec.enumValues,
        enumLabels: numSpec.enumLabels ?? numSpec.enumValues.map(String),
        description: spec.description ?? undefined,
      });
    } else {
      numericProps.push({
        identifier: spec.identifier,
        dataType,
        bounds,
        description: spec.description ?? undefined,
      });
    }
  }
  const usedIds = new Set([
    ...numericProps.map((p) => p.identifier),
    ...enumProps.map((p) => p.identifier),
    ...boolProps.map((p) => p.identifier),
  ]);
  // Prepend the synthetic annotation-type enum so it appears first in the chips.
  if (typeProp !== undefined && !usedIds.has(typeProp.identifier)) {
    enumProps.unshift(typeProp);
    usedIds.add(typeProp.identifier);
  }
  if (coordDims !== undefined) {
    for (const coord of coordDims) {
      if (!usedIds.has(coord.id)) {
        numericProps.push({
          identifier: coord.id,
          dataType: DataType.FLOAT32,
          bounds: defaultDataTypeRange[DataType.FLOAT32] as DataTypeInterval,
          description: coord.description,
        });
        usedIds.add(coord.id);
      }
    }
  }
  // Append derived (computed) geometric properties (length, volume, ...).
  if (derivedProps !== undefined) {
    for (const prop of derivedProps) {
      if (!usedIds.has(prop.identifier)) {
        numericProps.push(prop);
        usedIds.add(prop.identifier);
      }
    }
  }
  return { numericProps, enumProps, boolProps };
}

// ============================================================================
// Query items
// ============================================================================

/**
 * One queryable row derived from an annotation.
 * Values are keyed by property identifier:
 *  - numeric/enum → number (NaN if not present for that annotation)
 *  - bool         → boolean (absent if not present)
 *  - coord dims   → midpoint of the annotation's spatial extent for that dim
 */
export interface AnnotationQueryItem {
  description: string;
  values: Map<string, number | boolean>;
  /**
   * Spatial [min, max] extent per coordinate dimension.
   * Used for range-overlap filtering and direction-dependent sorting:
   *   ascending  → sort by min (smallest-start first)
   *   descending → sort by max (largest-end first)
   */
  coordBounds?: Map<string, [number, number]>;
}

/**
 * Build AnnotationQueryItems from a flat annotation list.
 *
 * @param listElements  Pairs of (annotation, source properties array, optional coord data).
 */
export function buildAnnotationQueryItems(
  listElements: Array<{
    annotation: { description?: string; properties: any[] };
    propSpecs: AnnotationPropertySpec[];
    /** Per-dimension midpoint value for use in histograms. */
    coordValues?: Map<string, number>;
    /** Per-dimension [min, max] extent for filtering and sorting. */
    coordBounds?: Map<string, [number, number]>;
    /** Raw AnnotationType value (0–4) stored under the "type" field. */
    annotationType?: number;
    /** Derived/computed geometric property values (NaN where not applicable). */
    derivedValues?: Map<string, number>;
  }>,
): AnnotationQueryItem[] {
  return listElements.map(
    ({
      annotation,
      propSpecs,
      coordValues,
      coordBounds,
      annotationType,
      derivedValues,
    }) => {
      const values = new Map<string, number | boolean>();
      if (coordValues !== undefined) {
        for (const [id, v] of coordValues) {
          values.set(id, v);
        }
      }
      if (derivedValues !== undefined) {
        for (const [id, v] of derivedValues) {
          values.set(id, v);
        }
      }
      if (annotationType !== undefined) {
        values.set("type", annotationType);
      }
      for (let i = 0; i < propSpecs.length; ++i) {
        const spec = propSpecs[i];
        if (spec.type === "rgb" || spec.type === "rgba") continue;
        const raw = annotation.properties[i];
        if (raw === undefined || raw === null) continue;
        if (spec.type === "bool") {
          values.set(spec.identifier, Boolean(raw));
        } else {
          values.set(spec.identifier, Number(raw));
        }
      }
      return { description: annotation.description ?? "", values, coordBounds };
    },
  );
}

// ============================================================================
// Filter query types
// ============================================================================

export interface AnnotationEnumConstraint {
  fieldId: string;
  /** Include only items whose enum value is in this list (empty = accept all). */
  include: number[];
  /** Exclude items whose enum value is in this list. */
  exclude: number[];
}

export interface AnnotationBoolConstraint {
  fieldId: string;
  /** undefined = no constraint; true = require true; false = require false. */
  value: boolean | undefined;
}

export interface AnnotationFilterQuery extends NumericalSummaryQuery {
  // From NumericalSummaryQuery:
  //   sortBy: SortBy[]
  //   includeColumns: string[]
  //   numericalConstraints: NumericalPropertyConstraint[]

  /** Description prefix filter (case-insensitive). */
  prefix: string | undefined;
  /** Description regexp filter. */
  regexp: RegExp | undefined;
  enumConstraints: AnnotationEnumConstraint[];
  boolConstraints: AnnotationBoolConstraint[];
}

export interface AnnotationQueryResult extends NumericalSummaryQueryResult {
  // From NumericalSummaryQueryResult:
  //   query: NumericalSummaryQuery (actually AnnotationFilterQuery)
  //   indices?: ArrayLike<number>
  //   intermediateIndices?: ArrayLike<number>
  //   intermediateIndicesMask?: Uint32Array | Uint16Array | Uint8Array

  query: AnnotationFilterQuery;
  count: number;
  total: number;
  errors: QueryParseError[];
  /** Per enum property: how many items in `indices` have each raw value. */
  enumStats: Map<string, Map<number, number>>;
  /** Per bool property: how many items in `indices` are true vs false. */
  boolStats: Map<string, { trueCount: number; falseCount: number }>;
}

// ============================================================================
// Parser
// ============================================================================

const emptyQuery = (): AnnotationFilterQuery => ({
  prefix: undefined,
  regexp: undefined,
  numericalConstraints: [],
  enumConstraints: [],
  boolConstraints: [],
  sortBy: [],
  includeColumns: [],
});

/**
 * Parse a free-text annotation query string.
 *
 * Grammar (tokens are space-separated):
 *   <field          sort by `field` ascending
 *   >field          sort by `field` descending  (field = property id, "description", "index")
 *   |field          show `field` as a column
 *   prop<N          numeric constraint (also <=, =, >=, >)
 *   #prop=label     include only enum values matching label (case-insensitive)
 *   -#prop=label    exclude enum values matching label
 *   #prop           require bool property to be true
 *   -#prop          require bool property to be false
 *   /re/            description regexp
 *   word            description prefix
 */
export function parseAnnotationQuery(
  schema: AnnotationQuerySchema,
  queryText: string,
): AnnotationFilterQuery | { errors: QueryParseError[] } {
  const allNumericIds = new Set(
    schema.numericProps.map((p) => p.identifier.toLowerCase()),
  );
  const allEnumIds = new Set(
    schema.enumProps.map((p) => p.identifier.toLowerCase()),
  );
  const allBoolIds = new Set(
    schema.boolProps.map((p) => p.identifier.toLowerCase()),
  );
  const allFieldIds = new Set([...allNumericIds, ...allEnumIds, ...allBoolIds]);
  return resolvePropertyQuery(queryText, {
    createQuery: emptyQuery,
    resolveSortField: (clause) => {
      const fieldId = clause.field.toLowerCase();
      if (
        fieldId !== "description" &&
        fieldId !== "index" &&
        !allFieldIds.has(fieldId)
      ) {
        return {
          error: {
            begin: clause.begin + 1,
            end: clause.end,
            message: `Unknown sort field: ${fieldId}`,
          },
        };
      }
      return {
        value:
          fieldId === "description" || fieldId === "index"
            ? fieldId
            : findCanonicalId(fieldId, schema),
      };
    },
    duplicateSortMessage: (clause) =>
      `Duplicate sort field: ${clause.field.toLowerCase()}`,
    resolveColumnField: (clause) => {
      const fieldId = clause.field.toLowerCase();
      if (!allFieldIds.has(fieldId)) {
        return {
          error: {
            begin: clause.begin + 1,
            end: clause.end,
            message: `Unknown column field: ${fieldId}`,
          },
        };
      }
      return { value: findCanonicalId(fieldId, schema) };
    },
    resolveNumericField: (clause) => {
      const fieldId = clause.field.toLowerCase();
      const property = schema.numericProps.find(
        (candidate) => candidate.identifier.toLowerCase() === fieldId,
      );
      if (property === undefined) {
        return {
          error: {
            begin: clause.begin,
            end: clause.end,
            message: `Unknown or non-numeric field: ${fieldId}`,
          },
        };
      }
      return {
        value: {
          fieldId: property.identifier,
          dataType: property.dataType,
          bounds: property.bounds,
        },
      };
    },
    applyCategoricalClause: (query, clause, { errors }) => {
      const fieldId = clause.field.toLowerCase();
      if (allBoolIds.has(fieldId)) {
        if (clause.value !== undefined) {
          errors.push({
            begin: clause.begin,
            end: clause.end,
            message: `Bool property ${fieldId} does not accept a value; use #${fieldId} or -#${fieldId}`,
          });
          return;
        }
        const canonicalId = findCanonicalId(fieldId, schema);
        let constraint = query.boolConstraints.find(
          (candidate) => candidate.fieldId === canonicalId,
        );
        if (constraint === undefined) {
          constraint = { fieldId: canonicalId, value: undefined };
          query.boolConstraints.push(constraint);
        }
        constraint.value = !clause.exclude;
        return;
      }
      if (allEnumIds.has(fieldId)) {
        const property = schema.enumProps.find(
          (candidate) => candidate.identifier.toLowerCase() === fieldId,
        )!;
        if (clause.value === undefined) {
          errors.push({
            begin: clause.begin,
            end: clause.end,
            message: `Enum property ${fieldId} requires a value: #${fieldId}=label`,
          });
          return;
        }
        const labelIndex = property.enumLabels.findIndex(
          (label) => label.toLowerCase() === clause.value!.toLowerCase(),
        );
        const numericValue = Number(clause.value);
        const value =
          labelIndex === -1 ? numericValue : property.enumValues[labelIndex];
        if (
          labelIndex === -1 &&
          (!Number.isFinite(value) || !property.enumValues.includes(value))
        ) {
          errors.push({
            begin: clause.begin,
            end: clause.end,
            message: `Unknown enum value for ${fieldId}: ${clause.value}`,
          });
          return;
        }
        let constraint = query.enumConstraints.find(
          (candidate) => candidate.fieldId === property.identifier,
        );
        if (constraint === undefined) {
          constraint = {
            fieldId: property.identifier,
            include: [],
            exclude: [],
          };
          query.enumConstraints.push(constraint);
        }
        const target = clause.exclude ? constraint.exclude : constraint.include;
        if (!target.includes(value)) target.push(value);
        return;
      }
      errors.push({
        begin: clause.begin,
        end: clause.end,
        message: `Unknown property: ${fieldId}`,
      });
    },
    defaultSort: { fieldId: "index", order: "<" },
    regexpFlags: "i",
  });
}

/** Convert an AnnotationFilterQuery back to a query string. */
export function unparseAnnotationQuery(
  query: AnnotationFilterQuery,
  schemaBoundsMap?: ReadonlyMap<string, readonly [number, number]>,
): string {
  const clauses: SerializablePropertyQueryClause[] = [];
  for (const { fieldId, order } of query.sortBy) {
    if (fieldId !== "index" || order !== "<") {
      clauses.push({ type: "sort", field: fieldId, order });
    }
  }
  for (const col of query.includeColumns) {
    if (!query.sortBy.find((s) => s.fieldId === col)) {
      clauses.push({ type: "column", field: col });
    }
  }
  for (const c of query.numericalConstraints) {
    const sb = schemaBoundsMap?.get(c.fieldId);
    const [lo, hi] = c.bounds as [number, number];
    if (sb === undefined || lo > sb[0]) {
      clauses.push({
        type: "comparison",
        field: c.fieldId,
        operator: ">=",
        value: `${lo}`,
      });
    }
    if (sb === undefined || hi < sb[1]) {
      clauses.push({
        type: "comparison",
        field: c.fieldId,
        operator: "<=",
        value: `${hi}`,
      });
    }
  }
  for (const c of query.enumConstraints) {
    for (const value of c.include) {
      clauses.push({
        type: "categorical",
        exclude: false,
        field: c.fieldId,
        value: `${value}`,
      });
    }
    for (const value of c.exclude) {
      clauses.push({
        type: "categorical",
        exclude: true,
        field: c.fieldId,
        value: `${value}`,
      });
    }
  }
  for (const c of query.boolConstraints) {
    if (c.value !== undefined) {
      clauses.push({
        type: "categorical",
        exclude: !c.value,
        field: c.fieldId,
        value: undefined,
      });
    }
  }
  if (query.regexp !== undefined) {
    clauses.push({
      type: "regexp",
      pattern: query.regexp.source,
      closed: true,
    });
  } else if (query.prefix !== undefined) {
    clauses.push({ type: "text", value: query.prefix });
  }
  return serializePropertyQueryClauses(clauses);
}

// ============================================================================
// Query executor
// ============================================================================

function makeIndicesArray(
  length: number,
): Uint32Array | Uint16Array | Uint8Array {
  if (length <= 0xff) return new Uint8Array(length);
  if (length <= 0xffff) return new Uint16Array(length);
  return new Uint32Array(length);
}

/**
 * Execute an annotation filter query against a list of items.
 *
 * Returns a result with:
 *   - `indices`              sorted flat indices of items that pass all constraints
 *   - `intermediateIndices`  indices passing desc/enum/bool but not numeric (for marginal CDFs)
 *   - `intermediateIndicesMask`  bitmask per intermediate index for numeric constraints
 *   - `enumStats`, `boolStats`  counts within the final `indices`
 */
export function executeAnnotationQuery(
  items: AnnotationQueryItem[],
  query: AnnotationFilterQuery,
  coordFieldIds?: ReadonlySet<string>,
): AnnotationQueryResult {
  const n = items.length;
  const allIndices = new Uint32Array(n);
  for (let i = 0; i < n; ++i) allIndices[i] = i;

  // 1. Description filter
  let indices: Uint32Array | Uint16Array | Uint8Array = allIndices;
  const { prefix, regexp } = query;
  if (prefix !== undefined || regexp !== undefined) {
    const lower = prefix !== undefined ? prefix.toLowerCase() : undefined;
    indices = filterIndices(indices, (i) => {
      const desc = items[i].description;
      if (lower !== undefined && !desc.toLowerCase().startsWith(lower))
        return false;
      if (regexp !== undefined && regexp.test(desc) === false) return false;
      return true;
    });
  }

  // 2. Bool constraints
  for (const { fieldId, value } of query.boolConstraints) {
    if (value === undefined) continue;
    indices = filterIndices(indices, (i) => {
      const v = items[i].values.get(fieldId);
      if (typeof v !== "boolean") return false;
      return v === value;
    });
  }

  // 3. Enum constraints
  for (const { fieldId, include, exclude } of query.enumConstraints) {
    const hasInclude = include.length > 0;
    const hasExclude = exclude.length > 0;
    if (!hasInclude && !hasExclude) continue;
    indices = filterIndices(indices, (i) => {
      const v = items[i].values.get(fieldId);
      if (typeof v !== "number") return false;
      if (hasInclude && !include.includes(v)) return false;
      if (hasExclude && exclude.includes(v)) return false;
      return true;
    });
  }

  // 4. Numeric constraints — build intermediateIndicesMask and filter
  let intermediateIndices: Uint32Array | Uint16Array | Uint8Array | undefined;
  let intermediateIndicesMask:
    | Uint32Array
    | Uint16Array
    | Uint8Array
    | undefined;
  const { numericalConstraints } = query;
  if (numericalConstraints.length > 0) {
    const numConstraints = numericalConstraints.length;
    const fullMask = 2 ** numConstraints - 1;
    const mask = makeIndicesArray(indices.length);
    for (let ci = 0; ci < numConstraints; ++ci) {
      const { fieldId, bounds } = numericalConstraints[ci];
      const [lo, hi] = bounds as [number, number];
      const bit = 2 ** ci;
      const isCoord = coordFieldIds?.has(fieldId) ?? false;
      for (let j = 0; j < indices.length; ++j) {
        const item = items[indices[j]];
        let passes: boolean;
        if (isCoord) {
          const cb = item.coordBounds?.get(fieldId);
          // Overlap: annotation covers [cb[0], cb[1]], filter window is [lo, hi].
          passes = cb !== undefined ? cb[0] <= hi && cb[1] >= lo : false;
        } else {
          const v = item.values.get(fieldId);
          passes = typeof v === "number" && v >= lo && v <= hi;
        }
        if (passes) {
          (mask as Uint32Array)[j] |= bit;
        }
      }
    }
    intermediateIndices = indices;
    intermediateIndicesMask = mask;
    const filtered = new Uint32Array(indices.length);
    let outLen = 0;
    for (let j = 0; j < indices.length; ++j) {
      if ((mask as Uint32Array)[j] === fullMask) {
        filtered[outLen++] = indices[j];
      }
    }
    indices = filtered.subarray(0, outLen) as Uint32Array;
  }

  // 5. Sort
  const finalIndices = sortAnnotationIndices(
    indices,
    items,
    query.sortBy,
    coordFieldIds,
  );

  // 6. Compute enum/bool stats from final result
  const enumStats = new Map<string, Map<number, number>>();
  for (const { fieldId } of query.enumConstraints.length > 0
    ? query.enumConstraints
    : []) {
    const counts = new Map<number, number>();
    for (let j = 0; j < finalIndices.length; ++j) {
      const v = items[finalIndices[j]].values.get(fieldId);
      if (typeof v === "number") {
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    enumStats.set(fieldId, counts);
  }
  const boolStats = new Map<
    string,
    { trueCount: number; falseCount: number }
  >();
  for (const { fieldId } of query.boolConstraints) {
    let trueCount = 0;
    let falseCount = 0;
    for (let j = 0; j < finalIndices.length; ++j) {
      const v = items[finalIndices[j]].values.get(fieldId);
      if (v === true) ++trueCount;
      else if (v === false) ++falseCount;
    }
    boolStats.set(fieldId, { trueCount, falseCount });
  }

  return {
    query,
    indices: finalIndices,
    intermediateIndices,
    intermediateIndicesMask: intermediateIndicesMask as
      | Uint32Array
      | Uint16Array
      | Uint8Array
      | undefined,
    count: finalIndices.length,
    total: n,
    errors: [],
    enumStats,
    boolStats,
  };
}

function filterIndices(
  indices: Uint32Array | Uint16Array | Uint8Array,
  pred: (i: number) => boolean,
): Uint32Array | Uint16Array | Uint8Array {
  const out = new Uint32Array(indices.length);
  let len = 0;
  for (let j = 0; j < indices.length; ++j) {
    if (pred(indices[j])) out[len++] = indices[j];
  }
  return out.subarray(0, len);
}

function sortAnnotationIndices(
  indices: Uint32Array | Uint16Array | Uint8Array,
  items: AnnotationQueryItem[],
  sortBy: SortBy[],
  coordFieldIds?: ReadonlySet<string>,
): Uint32Array {
  // Make a mutable copy of indices as Uint32Array for sort.
  const arr =
    indices instanceof Uint32Array ? indices.slice() : new Uint32Array(indices);

  if (
    sortBy.length === 0 ||
    (sortBy.length === 1 &&
      sortBy[0].fieldId === "index" &&
      sortBy[0].order === "<")
  ) {
    // Default: preserve original order (sort by index ascending).
    return arr;
  }

  // Stable sort by first sortBy entry (compound sorting is a future optimization).
  const { fieldId, order } = sortBy[0];
  const sign = order === "<" ? 1 : -1;

  if (fieldId === "index") {
    arr.sort();
    if (order === ">") arr.reverse();
    return arr;
  }

  if (fieldId === "description") {
    const arrCopy = Array.from(arr);
    arrCopy.sort((a, b) => {
      const da = items[a].description;
      const db = items[b].description;
      if (da < db) return -sign;
      if (da > db) return sign;
      return a - b; // stable by index
    });
    return new Uint32Array(arrCopy);
  }

  // Sort by property or coordinate value.
  const isCoord = coordFieldIds?.has(fieldId) ?? false;
  const useMax = isCoord && order === ">";
  const arrCopy = Array.from(arr);
  arrCopy.sort((a, b) => {
    let na: number, nb: number;
    if (isCoord) {
      // Ascending: sort by minimum extent (smallest-start first).
      // Descending: sort by maximum extent (largest-end first).
      const aRange = items[a].coordBounds?.get(fieldId);
      const bRange = items[b].coordBounds?.get(fieldId);
      na = aRange !== undefined ? (useMax ? aRange[1] : aRange[0]) : NaN;
      nb = bRange !== undefined ? (useMax ? bRange[1] : bRange[0]) : NaN;
    } else {
      const va = items[a].values.get(fieldId);
      const vb = items[b].values.get(fieldId);
      const toNum = (v: number | boolean | undefined) =>
        typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : NaN;
      na = toNum(va);
      nb = toNum(vb);
    }
    // Missing values sort to end.
    if (isNaN(na) && isNaN(nb)) return a - b;
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    const cmp = na - nb;
    if (cmp !== 0) return cmp * sign;
    return a - b; // stable by index
  });
  return new Uint32Array(arrCopy);
}

// ============================================================================
// NumericalSummaryDataSource adapter
// ============================================================================

/**
 * Creates a NumericalSummaryDataSource for use with NumericalPropertiesSummary.
 * `getItems` is called on every histogram update, so it can return a fresh
 * array after annotation-list rebuilds without recreating the data source.
 */
export function makeAnnotationNumericalDataSource(
  schema: AnnotationQuerySchema,
  getItems: () => AnnotationQueryItem[],
): NumericalSummaryDataSource {
  // Cache per-property histograms with their freshness key.
  interface AnnotationHistogramCache {
    queryResult: AnnotationQueryResult | undefined;
    window: DataTypeInterval;
    histogram: NumericalPropertyHistogram;
  }
  const cache: AnnotationHistogramCache[] = [];

  const properties: NumericalSummaryProperty[] = schema.numericProps.map(
    (p) => ({
      id: p.identifier,
      dataType: p.dataType,
      bounds: p.bounds,
      description: p.description,
    }),
  );

  return {
    properties,
    updateHistograms(qr, histograms, windowBounds) {
      const annotationQr = qr as AnnotationQueryResult | undefined;
      if (annotationQr?.indices === undefined) {
        histograms.length = 0;
        return;
      }
      const numProps = schema.numericProps.length;
      histograms.length = numProps;
      for (let pi = 0; pi < numProps; ++pi) {
        const prop = schema.numericProps[pi];
        const window = windowBounds[pi];
        const cached = cache[pi];
        if (
          cached !== undefined &&
          cached.queryResult === annotationQr &&
          cached.window[0] === window[0] &&
          cached.window[1] === window[1]
        ) {
          histograms[pi] = cached.histogram;
          continue;
        }
        const histogram = computeAnnotationPropertyHistogram(
          prop.identifier,
          getItems(),
          annotationQr,
          window,
        );
        cache[pi] = { queryResult: annotationQr, window, histogram };
        histograms[pi] = histogram;
      }
    },
  };
}

/** Compute a histogram for one numeric annotation property. */
function computeAnnotationPropertyHistogram(
  propId: string,
  items: AnnotationQueryItem[],
  queryResult: AnnotationQueryResult,
  window: DataTypeInterval,
): NumericalPropertyHistogram {
  const numBins = 256;
  const [min, max] = window as [number, number];
  const multiplier = max <= min ? 0 : numBins / (max - min);
  const histogram = new Uint32Array(numBins + 2);

  const { numericalConstraints } = queryResult.query;
  const constraintIndex = numericalConstraints.findIndex(
    (c) => c.fieldId === propId,
  );

  if (constraintIndex === -1) {
    // Unconstrained: compute from final result set.
    const indices = queryResult.indices!;
    for (let j = 0; j < indices.length; ++j) {
      const v = items[indices[j]].values.get(propId);
      if (typeof v === "number" && !Number.isNaN(v)) {
        ++histogram[
          (Math.min(numBins - 1, Math.max(-1, (v - min) * multiplier)) + 1) >>>
            0
        ];
      }
    }
  } else {
    // Constrained: compute marginal histogram from intermediateIndices.
    const { intermediateIndices, intermediateIndicesMask } = queryResult;
    if (
      intermediateIndices === undefined ||
      intermediateIndicesMask === undefined
    ) {
      return { window, histogram };
    }
    const numConstraints = numericalConstraints.length;
    const requiredBits = 2 ** numConstraints - 1 - 2 ** constraintIndex;
    for (let j = 0; j < intermediateIndices.length; ++j) {
      if ((intermediateIndicesMask[j] & requiredBits) === requiredBits) {
        const v = items[intermediateIndices[j]].values.get(propId);
        if (typeof v === "number" && !Number.isNaN(v)) {
          ++histogram[
            (Math.min(numBins - 1, Math.max(-1, (v - min) * multiplier)) +
              1) >>>
              0
          ];
        }
      }
    }
  }
  return { window, histogram };
}

function findCanonicalId(
  lowerCaseId: string,
  schema: AnnotationQuerySchema,
): string {
  for (const p of schema.numericProps) {
    if (p.identifier.toLowerCase() === lowerCaseId) return p.identifier;
  }
  for (const p of schema.enumProps) {
    if (p.identifier.toLowerCase() === lowerCaseId) return p.identifier;
  }
  for (const p of schema.boolProps) {
    if (p.identifier.toLowerCase() === lowerCaseId) return p.identifier;
  }
  return lowerCaseId;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { NumericalPropertyConstraint, QueryParseError, SortBy };
