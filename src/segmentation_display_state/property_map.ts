/**
 * @license
 * Copyright 2020 Google Inc.
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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { ChunkSource } from "#src/chunk_manager/frontend.js";
import type { IndexedSegmentProperty } from "#src/segmentation_display_state/base.js";
import type { SerializablePropertyQueryClause } from "#src/ui/property_query.js";
import {
  resolvePropertyQuery,
  serializePropertyQueryClauses,
} from "#src/ui/property_query.js";
import type { Uint64OrderedSet } from "#src/uint64_ordered_set.js";
import type { Uint64Set } from "#src/uint64_set.js";
import type {
  TypedArray,
  TypedNumberArray,
  WritableArrayLike,
} from "#src/util/array.js";
import { mergeSequences } from "#src/util/array.js";
import { bigintCompare } from "#src/util/bigint.js";
import { DataType } from "#src/util/data_type.js";
import type { Borrowed } from "#src/util/disposable.js";
import { murmurHash3_x86_32Hash64Bits_Bigint } from "#src/util/hash.js";
import { parseUint64 } from "#src/util/json.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import {
  dataTypeCompare,
  dataTypeIntervalEqual,
  dataTypeValueNextAfter,
} from "#src/util/lerp.js";
import { getObjectId } from "#src/util/object_id.js";
import { defaultStringCompare } from "#src/util/string.js";

export type InlineSegmentProperty =
  | InlineSegmentStringProperty
  | InlineSegmentTagsProperty
  | InlineSegmentNumericalProperty;

export interface InlineSegmentStringProperty {
  id: string;
  type: "string" | "label" | "description";
  description?: string | undefined;
  values: string[];
}

export interface InlineSegmentTagsProperty {
  id: string;
  type: "tags";
  tags: string[];
  // Must be the same length as `tags`.
  tagDescriptions: string[];
  // Each value is a string, where the character code indicates the tag.  For example,
  // "\u0001\u0010" indicates tags [1, 16].  The character codes must be distinct and sorted.
  values: string[];
}

export interface InlineSegmentNumericalProperty {
  id: string;
  type: "number";
  dataType: DataType;
  description: string | undefined;
  values: TypedNumberArray<ArrayBuffer>;
  bounds: DataTypeInterval;
}

export interface InlineSegmentPropertyMap {
  ids: BigUint64Array<ArrayBuffer>;
  properties: InlineSegmentProperty[];
}

export interface IndexedSegmentPropertyMapOptions {
  properties: readonly Readonly<IndexedSegmentProperty>[];
}

export class IndexedSegmentPropertySource extends ChunkSource {
  declare OPTIONS: IndexedSegmentPropertyMapOptions;
  properties: readonly Readonly<IndexedSegmentProperty>[];

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    options: IndexedSegmentPropertyMapOptions,
  ) {
    super(chunkManager, options);
    this.properties = options.properties;
  }

  static encodeOptions(options: IndexedSegmentPropertyMapOptions): {
    [key: string]: any;
  } {
    return { properties: options.properties };
  }
}

function insertIntoLinearChainingTable(
  table: TypedNumberArray,
  hashCode: number,
  value: number,
) {
  const mask = table.length - 1;
  while (true) {
    hashCode = hashCode & mask;
    if (table[hashCode] === 0) {
      table[hashCode] = value;
      return;
    }
    ++hashCode;
  }
}

export type IndicesArray = Uint32Array | Uint16Array | Uint8Array;

function makeIndicesArray(size: number, maxValue: number): IndicesArray {
  if (maxValue <= 0xff) {
    return new Uint8Array(size);
  }
  if (maxValue <= 0xffff) {
    return new Uint16Array(size);
  }
  return new Uint32Array(size);
}

function makeUint64PermutationHashMap(values: BigUint64Array): IndicesArray {
  // Use twice the next power of 2 as the size.  This ensures a load factor <= 0.5.
  const numEntries = values.length;
  const hashCodeBits = Math.ceil(Math.log2(numEntries)) + 1;
  const size = 2 ** hashCodeBits;
  const table = makeIndicesArray(size, numEntries + 1);
  for (let i = 0; i < numEntries; ++i) {
    insertIntoLinearChainingTable(
      table,
      murmurHash3_x86_32Hash64Bits_Bigint(/*seed=*/ 0, values[i]),
      i + 1,
    );
  }
  return table;
}

function queryUint64PermutationHashMap(
  table: TypedNumberArray,
  values: BigUint64Array,
  x: bigint,
): number {
  if (table.length === 0) return -1;
  let hashCode = murmurHash3_x86_32Hash64Bits_Bigint(/*seed=*/ 0, x);
  const mask = table.length - 1;
  while (true) {
    hashCode = hashCode & mask;
    let index = table[hashCode];
    if (index === 0) return -1;
    --index;
    if (values[index] === x) {
      return index;
    }
    ++hashCode;
  }
}

export class SegmentPropertyMap {
  inlineProperties: InlineSegmentPropertyMap | undefined;

  constructor(options: {
    inlineProperties?: InlineSegmentPropertyMap | undefined;
  }) {
    this.inlineProperties = options.inlineProperties;
  }
}

export class PreprocessedSegmentPropertyMap {
  // Linear-chaining hash table that maps uint64 ids to indices into `inlineProperties.ids`.
  inlineIdToIndex: IndicesArray | undefined;
  tags: InlineSegmentTagsProperty | undefined;
  labels: InlineSegmentStringProperty | undefined;
  numericalProperties: InlineSegmentNumericalProperty[];

  getSegmentInlineIndex(id: bigint): number {
    const { inlineIdToIndex } = this;
    if (inlineIdToIndex === undefined) return -1;
    return queryUint64PermutationHashMap(
      inlineIdToIndex,
      this.segmentPropertyMap.inlineProperties!.ids,
      id,
    );
  }

  constructor(public segmentPropertyMap: SegmentPropertyMap) {
    const { inlineProperties } = segmentPropertyMap;
    if (inlineProperties !== undefined) {
      this.inlineIdToIndex = makeUint64PermutationHashMap(inlineProperties.ids);
    }
    this.tags = inlineProperties?.properties.find((p) => p.type === "tags") as
      | InlineSegmentTagsProperty
      | undefined;
    this.labels = inlineProperties?.properties.find(
      (p) => p.type === "label",
    ) as InlineSegmentStringProperty | undefined;
    this.numericalProperties = (inlineProperties?.properties.filter(
      (p) => p.type === "number",
    ) ?? []) as InlineSegmentNumericalProperty[];
  }

  getSegmentLabel(id: bigint): string | undefined {
    const index = this.getSegmentInlineIndex(id);
    if (index === -1) return undefined;
    const { labels, tags: tagsProperty } = this;
    let label = "";
    if (labels !== undefined) {
      label = labels.values[index];
    }
    if (tagsProperty !== undefined) {
      const { tags, values } = tagsProperty;
      const tagIndices = values[index];
      for (let i = 0, length = tagIndices.length; i < length; ++i) {
        const tag = tags[tagIndices.charCodeAt(i)];
        if (label.length > 0) {
          label += " ";
        }
        label += "#";
        label += tag;
      }
    }
    if (label.length === 0) return undefined;
    return label;
  }
}

function remapArray<T>(
  input: ArrayLike<T>,
  output: WritableArrayLike<T>,
  toMerged: IndicesArray,
) {
  for (let i = 0, length = toMerged.length; i < length; ++i) {
    output[toMerged[i]] = input[i];
  }
}

function isIdArraySorted(ids: TypedArray): boolean {
  for (let i = 1, n = ids.length; i < n; ++i) {
    if (ids[i] <= ids[0]) return false;
  }
  return true;
}

export function normalizeInlineSegmentPropertyMap(
  inlineProperties: InlineSegmentPropertyMap,
): InlineSegmentPropertyMap {
  // Check if ids are already sorted.
  const { ids } = inlineProperties;
  if (isIdArraySorted(ids)) {
    return inlineProperties;
  }
  const length = ids.length;
  const permutation = makeIndicesArray(length, length - 1);
  for (let i = 0; i < length; ++i) {
    permutation[i] = i;
  }
  permutation.sort((a, b) => bigintCompare(ids[a], ids[b]));
  const newIds = new BigUint64Array(length);
  for (let newIndex = 0; newIndex < length; ++newIndex) {
    const oldIndex = permutation[newIndex];
    newIds[newIndex] = ids[oldIndex];
  }
  const properties = inlineProperties.properties.map((property) => {
    const { values } = property;
    const newValues = new (values.constructor as typeof Array)(length);
    for (let i = 0; i < length; ++i) {
      newValues[i] = values[permutation[i]];
    }
    return { ...property, values: newValues } as InlineSegmentProperty;
  });
  return { ids: newIds, properties };
}

function remapStringProperty(
  property: InlineSegmentStringProperty | InlineSegmentTagsProperty,
  numMerged: number,
  toMerged: Uint32Array,
): InlineSegmentStringProperty | InlineSegmentTagsProperty {
  const values = new Array<string>(numMerged);
  values.fill("");
  remapArray(property.values, values, toMerged);
  return { ...property, values };
}

function remapNumericalProperty(
  property: InlineSegmentNumericalProperty,
  numMerged: number,
  toMerged: Uint32Array,
): InlineSegmentNumericalProperty {
  const values = new Float32Array(numMerged);
  values.fill(Number.NaN);
  remapArray(property.values, values, toMerged);
  return { ...property, values };
}

function remapProperty(
  property: InlineSegmentProperty,
  numMerged: number,
  toMerged: Uint32Array,
): InlineSegmentProperty {
  const { type } = property;
  if (
    type === "label" ||
    type === "description" ||
    type === "string" ||
    type === "tags"
  ) {
    return remapStringProperty(
      property as InlineSegmentStringProperty | InlineSegmentTagsProperty,
      numMerged,
      toMerged,
    );
  }
  return remapNumericalProperty(
    property as InlineSegmentNumericalProperty,
    numMerged,
    toMerged,
  );
}

function mergeInlinePropertyMaps(
  a: InlineSegmentPropertyMap | undefined,
  b: InlineSegmentPropertyMap | undefined,
): InlineSegmentPropertyMap | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  // Determine number of unique ids and mapping from `a` and `b` indices to joined indices.
  let numUnique = 0;
  const aCount = a.ids.length;
  const bCount = b.ids.length;
  const aToMerged = new Uint32Array(aCount);
  const bToMerged = new Uint32Array(bCount);
  const aIds = a.ids;
  const bIds = b.ids;
  mergeSequences(
    aCount,
    bCount,
    (a, b) => bigintCompare(aIds[a], bIds[b]),
    (a) => {
      aToMerged[a] = numUnique;
      ++numUnique;
    },
    (b) => {
      bToMerged[b] = numUnique;
      ++numUnique;
    },
    (a, b) => {
      aToMerged[a] = numUnique;
      bToMerged[b] = numUnique;
      ++numUnique;
    },
  );
  let ids: BigUint64Array<ArrayBuffer>;
  if (numUnique === aCount) {
    ids = aIds;
  } else if (numUnique === bCount) {
    ids = bIds;
  } else {
    ids = new BigUint64Array(numUnique);
    for (let a = 0; a < aCount; ++a) {
      const i = aToMerged[a];
      ids[i] = aIds[a];
    }
    for (let b = 0; b < bCount; ++b) {
      const i = bToMerged[b];
      ids[i] = bIds[b];
    }
  }
  const properties: InlineSegmentProperty[] = [];
  if (numUnique === aCount) {
    properties.push(...a.properties);
  } else {
    for (const property of a.properties) {
      properties.push(remapProperty(property, numUnique, aToMerged));
    }
  }
  if (numUnique === bCount) {
    properties.push(...b.properties);
  } else {
    for (const property of b.properties) {
      properties.push(remapProperty(property, numUnique, bToMerged));
    }
  }
  return { ids, properties };
}

function mergePropertyMaps(a: SegmentPropertyMap, b: SegmentPropertyMap) {
  return new SegmentPropertyMap({
    inlineProperties: mergeInlinePropertyMaps(
      a.inlineProperties,
      b.inlineProperties,
    ),
  });
}

export function mergeSegmentPropertyMaps(
  maps: SegmentPropertyMap[],
): SegmentPropertyMap | undefined {
  while (true) {
    if (maps.length === 0) return undefined;
    if (maps.length === 1) return maps[0];
    const merged: SegmentPropertyMap[] = [];
    for (let i = 0, length = maps.length; i < length; i += 2) {
      if (i + 1 === length) {
        merged.push(maps[i]);
      } else {
        merged.push(mergePropertyMaps(maps[i], maps[i + 1]));
      }
    }
    maps = merged;
  }
}

export function getPreprocessedSegmentPropertyMap(
  chunkManager: ChunkManager,
  maps: SegmentPropertyMap[],
): PreprocessedSegmentPropertyMap | undefined {
  return chunkManager.memoize.getUncounted(
    {
      id: "getPreprocessedSegmentPropertyMap",
      maps: maps.map((m) => getObjectId(m)),
    },
    () => {
      const merged = mergeSegmentPropertyMaps(maps);
      if (merged === undefined) return undefined;
      return new PreprocessedSegmentPropertyMap(merged);
    },
  );
}

export interface SortBy {
  fieldId: string;
  order: "<" | ">";
}

export interface ExplicitIdQuery {
  ids: bigint[];
  prefix?: undefined;
  regexp?: undefined;
  includeTags?: undefined;
  excludeTags?: undefined;
  numericalConstraints?: undefined;
  sortBy?: undefined;
  includeColumns?: undefined;
  errors?: undefined;
}

export interface NumericalPropertyConstraint {
  fieldId: string;
  bounds: DataTypeInterval;
}

export interface FilterQuery {
  ids?: undefined;
  prefix: string | undefined;
  regexp: RegExp | undefined;
  includeTags: string[];
  excludeTags: string[];
  numericalConstraints: NumericalPropertyConstraint[];
  sortBy: SortBy[];
  includeColumns: string[];
  errors?: undefined;
}

export interface QueryParseError {
  begin: number;
  end: number;
  message: string;
}

export interface QueryParseErrors {
  errors: QueryParseError[];
  ids?: undefined;
  prefix?: undefined;
  regexp?: undefined;
  includeTags?: undefined;
  excludeTags?: undefined;
  numericalConstraints?: undefined;
  sortBy?: undefined;
  includeColumns?: undefined;
}

export type QueryParseResult = ExplicitIdQuery | FilterQuery | QueryParseErrors;

const idPattern = /^[,\s]*[0-9]+(?:[,\s]+[0-9]+)*[,\s]*$/;

export function parseSegmentQuery(
  db: PreprocessedSegmentPropertyMap | undefined,
  queryString: string,
): QueryParseResult {
  if (queryString.match(idPattern) !== null) {
    const parts = queryString.split(/[\s,]+/);
    const idSet = new Set<bigint>();
    for (let i = 0, n = parts.length; i < n; ++i) {
      const part = parts[i];
      if (part === "") continue;
      let id: bigint;
      try {
        id = parseUint64(part);
      } catch {
        continue;
      }
      idSet.add(id);
    }
    const ids = Array.from(idSet).sort(bigintCompare);
    return { ids };
  }
  const properties = db?.segmentPropertyMap.inlineProperties?.properties;
  const tags = db?.tags;
  const tagNames = tags?.tags || [];
  const lowerCaseTags = tagNames.map((x) => x.toLowerCase());
  const labels = db?.labels;
  return resolvePropertyQuery(queryString, {
    createQuery: (): FilterQuery => ({
      regexp: undefined,
      prefix: undefined,
      includeTags: [],
      excludeTags: [],
      numericalConstraints: [],
      sortBy: [],
      includeColumns: [],
    }),
    resolveSortField: (clause) => {
      const fieldId = clause.field.toLowerCase();
      if (fieldId === "id" || fieldId === "label") return { value: fieldId };
      const property = properties?.find(
        (candidate) =>
          candidate.id.toLowerCase() === fieldId &&
          (candidate.type === "number" ||
            candidate.type === "label" ||
            candidate.type === "string"),
      );
      return property === undefined
        ? {
            error: {
              begin: clause.begin + 1,
              end: clause.end,
              message: `Invalid field: ${fieldId}`,
            },
          }
        : { value: property.id };
    },
    resolveColumnField: (clause) => {
      const fieldId = clause.field.toLowerCase();
      if (fieldId === "id" || fieldId === "label") return { ignore: true };
      const property = properties?.find(
        (candidate) =>
          candidate.id.toLowerCase() === fieldId &&
          (candidate.type === "number" || candidate.type === "string"),
      );
      return property === undefined
        ? {
            error: {
              begin: clause.begin + 1,
              end: clause.end,
              message: `Invalid field: ${fieldId}`,
            },
          }
        : { value: property.id };
    },
    resolveNumericField: (clause) => {
      const fieldId = clause.field.toLowerCase();
      const property = db?.numericalProperties.find(
        (candidate) => candidate.id.toLowerCase() === fieldId,
      );
      return property === undefined
        ? {
            error: {
              begin: clause.begin,
              end: clause.begin + fieldId.length,
              message: `Invalid numerical field: ${fieldId}`,
            },
          }
        : {
            value: {
              fieldId: property.id,
              dataType: property.dataType,
              bounds: property.bounds,
            },
          };
    },
    applyCategoricalClause: (query, clause, { errors }) => {
      const tagText =
        clause.value === undefined
          ? clause.field
          : `${clause.field}=${clause.value}`;
      const tagIndex = lowerCaseTags.indexOf(tagText.toLowerCase());
      const begin = clause.begin + (clause.exclude ? 2 : 1);
      if (tagIndex === -1) {
        errors.push({
          begin,
          end: clause.end,
          message: `Invalid tag: ${tagText}`,
        });
        return;
      }
      const tag = tagNames[tagIndex];
      if (query.includeTags.includes(tag) || query.excludeTags.includes(tag)) {
        errors.push({
          begin,
          end: clause.end,
          message: `Duplicate tag: ${tag}`,
        });
        return;
      }
      (clause.exclude ? query.excludeTags : query.includeTags).push(tag);
    },
    defaultSort: { fieldId: getDefaultSortField(db), order: "<" },
    textUnavailableError:
      labels === undefined && tagNames.length === 0
        ? "No label property"
        : undefined,
  });
}

export interface TagCount {
  tag: string;
  tagIndex: number;
  count: number;
  desc: string;
}

export interface PropertyHistogram {
  // Solely serves to indicate whether this histogram is up to date.
  queryResult: QueryResult;
  window: DataTypeInterval;
  histogram: Uint32Array;
}

export interface QueryResult {
  query: QueryParseResult;
  // Indices into the inline properties table that satisfy all constraints *except* numerical
  // constraints.  Sorting is also not applied.
  intermediateIndices?: IndicesArray | undefined;
  // Bitvectors for each index in `intermediateIndices`.  Bit `i` is true if constraints on
  // numerical property `i` are satisfied.  This along with `intermediateIndices` is used to compute
  // "marginal" histograms for the numerical properties, for the distribution with all other
  // constraints applied, but without constraining the property for which we are computing the
  // histogram.
  intermediateIndicesMask?: Uint32Array | Uint16Array | Uint8Array | undefined;
  // Indices into the inline properties table that satisfy all constraints.  Sorting is applied.
  indices?: IndicesArray | undefined;
  explicitIds?: bigint[] | undefined;
  tags?: TagCount[] | undefined;
  count: number;
  total: number;
  errors?: QueryParseError[] | undefined;
}

function regexpEscapeCharCode(code: number) {
  return "\\u" + code.toString(16).padStart(4, "0");
}

export function executeSegmentQuery(
  db: PreprocessedSegmentPropertyMap | undefined,
  query: QueryParseResult,
): QueryResult {
  if (query.errors !== undefined) {
    return { query, total: -1, count: 0, errors: query.errors };
  }
  if (query.ids !== undefined) {
    const { ids } = query;
    return { query, total: -1, explicitIds: ids, count: ids.length };
  }
  const inlineProperties = db?.segmentPropertyMap?.inlineProperties;
  if (inlineProperties === undefined) {
    return {
      query,
      count: 0,
      total: -1,
    };
  }
  const properties = inlineProperties?.properties;
  const totalIds = inlineProperties.ids.length;
  const totalTags = db?.tags?.tags?.length || 0;
  let indices = makeIndicesArray(totalIds, totalIds);
  const showTags = makeIndicesArray(totalTags, totalTags);
  showTags.fill(1);
  for (let i = 0; i < totalIds; ++i) {
    indices[i] = i;
  }

  const filterIndices = (predicate: (index: number) => boolean) => {
    const length = indices.length;
    let outIndex = 0;
    for (let i = 0; i < length; ++i) {
      const index = indices[i];
      if (predicate(index)) {
        indices[outIndex] = index;
        ++outIndex;
      }
    }
    indices = indices.subarray(0, outIndex);
  };
  const filterByTagDescriptions = (regexp: RegExp) => {
    const tagDescriptions = db!.tags!.tagDescriptions!;
    const tags = db!.tags!.tags!;

    // reset showTags
    showTags.fill(0);

    // iterate over tagDescriptions with a for loop
    for (let i = 0; i < tagDescriptions.length; i++) {
      if (tagDescriptions[i].match(regexp) !== null) {
        showTags[i] = 1;
      }
      if (tags[i].match(regexp) !== null) {
        showTags[i] = 1;
      }
    }
  };

  // Filter by label
  if (query.regexp !== undefined || query.prefix !== undefined) {
    const { regexp, prefix } = query;
    if (db!.labels !== undefined) {
      const values = db!.labels!.values;
      if (regexp !== undefined) {
        filterIndices((index) => values[index].match(regexp) !== null);
      }
      if (prefix !== undefined) {
        filterIndices((index) => values[index].startsWith(prefix));
      }
    }
    // if the regular expression returns nothing
    // then assudme the user wants to search through the tags
    // and/or tag descriptions
    if (
      (indices.length == 0 && regexp !== undefined) ||
      (db!.labels == undefined && regexp != undefined)
    ) {
      indices = makeIndicesArray(totalIds, totalIds);
      for (let i = 0; i < totalIds; ++i) {
        indices[i] = i;
      }
      filterByTagDescriptions(regexp);
      // reset regexp to none so that it doesn't get applied again
      query.regexp = undefined;
    }
  }

  // Filter by tags
  const { includeTags, excludeTags } = query;
  const tagsProperty = db!.tags;
  if (includeTags.length > 0 || excludeTags.length > 0) {
    // Since query was already validated, tags property must exist if tags were specified.
    const { values, tags } = tagsProperty!;
    const allTags = [];
    for (const tag of includeTags) {
      allTags.push([tags.indexOf(tag), 1]);
    }
    for (const tag of excludeTags) {
      allTags.push([tags.indexOf(tag), 0]);
    }
    allTags.sort((a, b) => a[0] - b[0]);
    let pattern = "^";
    let prevTagIndex = 0;
    const addSkipPattern = (endCode: number) => {
      if (endCode < prevTagIndex) return;
      pattern += `[${regexpEscapeCharCode(prevTagIndex)}-${regexpEscapeCharCode(
        endCode,
      )}]*`;
    };
    for (const [tagIndex, sign] of allTags) {
      addSkipPattern(tagIndex - 1);
      if (sign) {
        pattern += regexpEscapeCharCode(tagIndex);
      }
      prevTagIndex = tagIndex + 1;
    }
    addSkipPattern(0xffff);
    pattern += "$";
    const regexp = new RegExp(pattern);
    filterIndices((index) => values[index].match(regexp) !== null);
  }
  let intermediateIndicesMask: IndicesArray | undefined;
  let intermediateIndices: IndicesArray | undefined;

  // Filter by numerical properties.
  const { numericalConstraints } = query;
  if (numericalConstraints.length > 0) {
    const numericalProperties = db!.numericalProperties;
    const numNumericalConstraints = numericalConstraints.length;
    const fullMask = 2 ** numNumericalConstraints - 1;
    intermediateIndicesMask = makeIndicesArray(indices.length, fullMask);
    for (
      let constraintIndex = 0;
      constraintIndex < numNumericalConstraints;
      ++constraintIndex
    ) {
      const constraint = numericalConstraints[constraintIndex];
      const property = numericalProperties.find(
        (p) => p.id === constraint.fieldId,
      )!;
      const { values } = property;
      const bit = 2 ** constraintIndex;
      const [min, max] = constraint.bounds as [number, number];
      for (let i = 0, n = indices.length; i < n; ++i) {
        const value = values[indices[i]];
        intermediateIndicesMask[i] |=
          bit * ((value >= min && value <= max) as any);
      }
    }
    intermediateIndices = indices;
    indices = intermediateIndices.slice();
    const length = indices.length;
    let outIndex = 0;
    for (let i = 0; i < length; ++i) {
      if (intermediateIndicesMask[i] === fullMask) {
        indices[outIndex] = indices[i];
        ++outIndex;
      }
    }
    indices = indices.subarray(0, outIndex);
  }

  // Compute tag statistics.
  let tagStatistics: TagCount[] = [];
  if (tagsProperty !== undefined) {
    const tagStatisticsInQuery: TagCount[] = [];
    const { tags, values, tagDescriptions } = tagsProperty;
    const tagCounts = new Uint32Array(tags.length);
    for (let i = 0, n = indices.length; i < n; ++i) {
      const value = values[indices[i]];
      for (let j = 0, m = value.length; j < m; ++j) {
        ++tagCounts[value.charCodeAt(j)];
      }
    }
    for (
      let tagIndex = 0, numTags = tags.length;
      tagIndex < numTags;
      ++tagIndex
    ) {
      if (showTags[tagIndex] === 0) continue;
      const count = tagCounts[tagIndex];
      const tag = tags[tagIndex];
      const tagDesc = tagDescriptions[tagIndex];
      const tagCount = {
        tag,
        tagIndex,
        count: tagCounts[tagIndex],
        desc: tagDesc,
      };
      if (query.includeTags.includes(tag) || query.excludeTags.includes(tag)) {
        tagStatisticsInQuery.push(tagCount);
      } else if (count > 0) {
        tagStatistics.push(tagCount);
      }
    }
    tagStatisticsInQuery.push(...tagStatistics);
    tagStatistics = tagStatisticsInQuery;
  }

  const sortByProperty = (
    property: InlineSegmentProperty,
    orderCoeff: number,
  ) => {
    if (property.type !== "number") {
      const { values } = property;
      indices.sort(
        (a, b) => defaultStringCompare(values[a], values[b]) * orderCoeff,
      );
    } else {
      const values = property.values as TypedNumberArray;
      indices.sort((a, b) => (values[a] - values[b]) * orderCoeff);
    }
  };

  const sortByLabel = (orderCoeff: number) => {
    // Sort by tags and then by label.
    if (tagsProperty !== undefined) {
      sortByProperty(tagsProperty, orderCoeff);
    }
    const labelsProperty = db?.labels;
    if (labelsProperty !== undefined) {
      sortByProperty(labelsProperty, orderCoeff);
    }
  };

  // Sort.  Apply the sort orders in reverse order to achieve the desired composite ordering, given
  // that JavaScript's builtin sort is stable.
  const { sortBy } = query;
  for (let i = sortBy.length - 1; i >= 0; --i) {
    const { fieldId, order } = sortBy[i];
    const orderCoeff = order === "<" ? 1 : -1;
    if (fieldId === "id") {
      if (i + 1 === sortBy.length) {
        if (order === "<") {
          // Default order, no need to sort.
          continue;
        }
        indices.reverse();
        continue;
      }
      indices.sort((a, b) => orderCoeff * (a - b));
    } else if (fieldId === "label") {
      sortByLabel(orderCoeff);
    } else {
      sortByProperty(properties.find((p) => p.id === fieldId)!, orderCoeff);
    }
  }

  return {
    query,
    intermediateIndices,
    intermediateIndicesMask,
    indices,
    tags: tagStatistics,
    count: indices.length,
    total: totalIds,
  };
}

function updatePropertyHistogram(
  queryResult: QueryResult,
  property: InlineSegmentNumericalProperty,
  bounds: DataTypeInterval,
): PropertyHistogram {
  const numBins = 256;
  const { values } = property;
  const [min, max] = bounds as [number, number];
  const multiplier = max <= min ? 0 : numBins / (max - min);
  const histogram = new Uint32Array(numBins + 2);
  const { numericalConstraints } = queryResult!.query as FilterQuery;
  const constraintIndex = numericalConstraints.findIndex(
    (c) => c.fieldId === property.id,
  );
  if (constraintIndex === -1) {
    // Property is unconstrained, just compute histogram from final result set.
    const indices = queryResult.indices!;
    for (let i = 0, n = indices.length; i < n; ++i) {
      const value = values[indices[i]];
      if (!Number.isNaN(value)) {
        ++histogram[
          (Math.min(numBins - 1, Math.max(-1, (value - min) * multiplier)) +
            1) >>>
            0
        ];
      }
    }
  } else {
    // Property is constrained, compute histogram from intermediateIndices.
    const intermediateIndices = queryResult.intermediateIndices!;
    const intermediateIndicesMask = queryResult.intermediateIndicesMask!;
    const requiredBits =
      2 ** numericalConstraints.length - 1 - 2 ** constraintIndex;
    for (let i = 0, n = intermediateIndices.length; i < n; ++i) {
      const mask = intermediateIndicesMask[i];
      if ((mask & requiredBits) === requiredBits) {
        const value = values[intermediateIndices[i]];
        if (!Number.isNaN(value)) {
          ++histogram[
            (Math.min(numBins - 1, Math.max(-1, (value - min) * multiplier)) +
              1) >>>
              0
          ];
        }
      }
    }
  }
  return { queryResult, histogram, window: bounds };
}

export function updatePropertyHistograms(
  db: PreprocessedSegmentPropertyMap | undefined,
  queryResult: QueryResult | undefined,
  propertyHistograms: PropertyHistogram[],
  bounds: DataTypeInterval[],
) {
  if (db === undefined) {
    propertyHistograms.length = 0;
    bounds.length = 0;
    return;
  }
  const { numericalProperties } = db;
  const numProperties = numericalProperties.length;
  const indices = queryResult?.indices;
  if (indices === undefined) {
    propertyHistograms.length = 0;
    return;
  }
  for (let i = 0; i < numProperties; ++i) {
    const propertyHistogram = propertyHistograms[i];
    const propertyBounds = bounds[i];
    const property = numericalProperties[i];
    if (
      propertyHistogram !== undefined &&
      propertyHistogram.queryResult === queryResult &&
      dataTypeIntervalEqual(propertyHistogram.window, propertyBounds)
    ) {
      continue;
    }
    propertyHistograms[i] = updatePropertyHistogram(
      queryResult!,
      property,
      propertyBounds,
    );
  }
}

function getDefaultSortField(db: PreprocessedSegmentPropertyMap | undefined) {
  return db?.tags || db?.labels ? "label" : "id";
}

export function unparseSegmentQuery(
  db: PreprocessedSegmentPropertyMap | undefined,
  query: ExplicitIdQuery | FilterQuery,
): string {
  const { ids } = query;
  if (ids !== undefined) {
    return ids.map((x) => x.toString()).join(", ");
  }
  const clauses: SerializablePropertyQueryClause[] = [];
  query = query as FilterQuery;
  const { prefix, regexp } = query;
  if (prefix !== undefined) {
    clauses.push({ type: "text", value: prefix });
  } else if (regexp !== undefined) {
    clauses.push({ type: "regexp", pattern: regexp.source, closed: true });
  }
  for (const tag of query.includeTags) {
    clauses.push({
      type: "categorical",
      exclude: false,
      field: tag,
      value: undefined,
    });
  }
  for (const tag of query.excludeTags) {
    clauses.push({
      type: "categorical",
      exclude: true,
      field: tag,
      value: undefined,
    });
  }
  for (const constraint of query.numericalConstraints) {
    const { fieldId, bounds } = constraint;
    const [min, max] = bounds as [number, number];
    const property = db!.numericalProperties.find((p) => p.id === fieldId)!;
    if (dataTypeIntervalEqual(property.bounds, bounds)) {
      continue;
    }
    if (dataTypeCompare(min, max) === 0) {
      clauses.push({
        type: "comparison",
        field: fieldId,
        operator: "=",
        value: `${min}`,
      });
      continue;
    }
    if (dataTypeCompare(min, property.bounds[0]) > 0) {
      const beforeMin = dataTypeValueNextAfter(property.dataType, min, -1);
      const minString = min.toString();
      const beforeMinString = beforeMin.toString();
      if (
        property.dataType !== DataType.FLOAT32 ||
        minString.length <= beforeMinString.length
      ) {
        clauses.push({
          type: "comparison",
          field: fieldId,
          operator: ">=",
          value: minString,
        });
      } else {
        clauses.push({
          type: "comparison",
          field: fieldId,
          operator: ">",
          value: beforeMinString,
        });
      }
    }
    if (dataTypeCompare(max, property.bounds[1]) < 0) {
      const afterMax = dataTypeValueNextAfter(property.dataType, max, +1);
      const maxString = max.toString();
      const afterMaxString = afterMax.toString();
      if (
        property.dataType !== DataType.FLOAT32 ||
        maxString.length <= afterMaxString.length
      ) {
        clauses.push({
          type: "comparison",
          field: fieldId,
          operator: "<=",
          value: maxString,
        });
      } else {
        clauses.push({
          type: "comparison",
          field: fieldId,
          operator: "<",
          value: afterMaxString,
        });
      }
    }
  }
  let { sortBy } = query;
  if (sortBy.length === 1) {
    const s = sortBy[0];
    if (s.order === "<" && s.fieldId === getDefaultSortField(db)) {
      sortBy = [];
    }
  }
  for (const s of sortBy) {
    clauses.push({ type: "sort", field: s.fieldId, order: s.order });
  }
  for (const fieldId of query.includeColumns) {
    clauses.push({ type: "column", field: fieldId });
  }
  return serializePropertyQueryClauses(clauses);
}

export function forEachQueryResultSegmentId(
  db: PreprocessedSegmentPropertyMap | undefined,
  queryResult: QueryResult | undefined,
  callback: (id: bigint, index: number) => void,
) {
  if (queryResult === undefined) return;
  const { explicitIds } = queryResult;
  if (explicitIds !== undefined) {
    explicitIds.forEach(callback);
    return;
  }
  const { indices } = queryResult;
  if (indices !== undefined) {
    const { ids } = db!.segmentPropertyMap.inlineProperties!;
    for (let i = 0, count = indices.length; i < count; ++i) {
      const propIndex = indices[i];
      callback(ids[propIndex], i);
    }
  }
}

export function* forEachQueryResultSegmentIdGenerator(
  db: PreprocessedSegmentPropertyMap | undefined,
  queryResult: QueryResult | undefined,
): IterableIterator<bigint> {
  if (queryResult === undefined) return;
  const { explicitIds } = queryResult;
  if (explicitIds !== undefined) {
    for (const id of explicitIds) {
      yield id;
    }
  }
  const { indices } = queryResult;
  if (indices !== undefined) {
    const { ids } = db!.segmentPropertyMap.inlineProperties!;
    for (let i = 0, count = indices.length; i < count; ++i) {
      const propIndex = indices[i];
      yield ids[propIndex];
    }
  }
}

export function findQueryResultIntersectionSize(
  db: PreprocessedSegmentPropertyMap | undefined,
  queryResult: QueryResult | undefined,
  segmentSet: Uint64Set | Uint64OrderedSet,
): number {
  if (segmentSet.size === 0) return 0;
  let count = 0;
  forEachQueryResultSegmentId(db, queryResult, (id) => {
    if (segmentSet.has(id)) ++count;
  });
  return count;
}

export function changeTagConstraintInSegmentQuery(
  query: FilterQuery,
  tag: string,
  include: boolean,
  value: boolean,
): FilterQuery {
  const includeTags = query.includeTags.filter((x) => x !== tag);
  const excludeTags = query.excludeTags.filter((x) => x !== tag);
  if (value === true) {
    (include ? includeTags : excludeTags).push(tag);
  }
  return { ...query, includeTags, excludeTags };
}

export function isQueryUnconstrained(query: QueryParseResult) {
  if (query.ids !== undefined) return false;
  if (query.errors !== undefined) return true;
  if (query.numericalConstraints.length > 0) return false;
  if (query.includeTags.length > 0) return false;
  if (query.excludeTags.length > 0) return false;
  if (query.prefix) return false;
  if (query.regexp) return false;
  return true;
}

export function queryIncludesColumn(
  query: QueryParseResult | undefined,
  fieldId: string,
) {
  if (query === undefined) return false;
  if (query.ids !== undefined) return false;
  if (query.errors !== undefined) return false;
  const { sortBy, includeColumns } = query;
  return (
    sortBy.find((x) => x.fieldId === fieldId) !== undefined ||
    includeColumns.includes(fieldId)
  );
}
