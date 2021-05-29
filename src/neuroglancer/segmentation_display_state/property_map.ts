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

import {ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {IndexedSegmentProperty} from 'neuroglancer/segmentation_display_state/base';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {mergeSequences, TypedArray, TypedArrayConstructor, WritableArrayLike} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {Borrowed} from 'neuroglancer/util/disposable';
import {murmurHash3_x86_32Hash64Bits} from 'neuroglancer/util/hash';
import {clampToInterval, dataTypeCompare, DataTypeInterval, dataTypeIntervalEqual, dataTypeValueNextAfter, parseDataTypeValue} from 'neuroglancer/util/lerp';
import {getObjectId} from 'neuroglancer/util/object_id';
import {defaultStringCompare} from 'neuroglancer/util/string';
import {Uint64} from 'neuroglancer/util/uint64';

export type InlineSegmentProperty =
    InlineSegmentStringProperty|InlineSegmentTagsProperty|InlineSegmentNumericalProperty;

export interface InlineSegmentStringProperty {
  id: string;
  type: 'string'|'label'|'description';
  description?: string|undefined;
  values: string[];
}

export interface InlineSegmentTagsProperty {
  id: string;
  type: 'tags';
  tags: string[];
  // Must be the same length as `tags`.
  tagDescriptions: string[];
  // Each value is a string, where the character code indicates the tag.  For example,
  // "\u0001\u0010" indicates tags [1, 16].  The character codes must be distinct and sorted.
  values: string[];
}

export interface InlineSegmentNumericalProperty {
  id: string;
  type: 'number';
  dataType: DataType;
  description: string|undefined;
  values: TypedArray;
  bounds: DataTypeInterval;
}

export interface InlineSegmentPropertyMap {
  // Specifies low/high 32-bit portions of ids.
  ids: Uint32Array;
  properties: InlineSegmentProperty[];
}

export interface IndexedSegmentPropertyMapOptions {
  properties: readonly Readonly<IndexedSegmentProperty>[];
}

export class IndexedSegmentPropertySource extends ChunkSource {
  OPTIONS: IndexedSegmentPropertyMapOptions;
  properties: readonly Readonly<IndexedSegmentProperty>[];

  constructor(chunkManager: Borrowed<ChunkManager>, options: IndexedSegmentPropertyMapOptions) {
    super(chunkManager, options);
    this.properties = options.properties;
  }

  static encodeOptions(options: IndexedSegmentPropertyMapOptions): {[key: string]: any} {
    return {properties: options.properties};
  }
}

function insertIntoLinearChainingTable(table: TypedArray, hashCode: number, value: number) {
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

export type IndicesArray = Uint32Array|Uint16Array|Uint8Array;

function makeIndicesArray(size: number, maxValue: number): IndicesArray {
  if (maxValue <= 0xff) {
    return new Uint8Array(size);
  }
  if (maxValue <= 0xffff) {
    return new Uint16Array(size);
  }
  return new Uint32Array(size);
}

function makeUint64PermutationHashMap(values: Uint32Array): IndicesArray {
  // Use twice the next power of 2 as the size.  This ensures a load factor <= 0.5.
  const numEntries = values.length / 2;
  const hashCodeBits = Math.ceil(Math.log2(numEntries)) + 1;
  const size = 2 ** hashCodeBits;
  const table = makeIndicesArray(size, numEntries + 1);
  for (let i = 0; i < numEntries; ++i) {
    const low = values[2 * i];
    const high = values[2 * i + 1];
    insertIntoLinearChainingTable(
        table, murmurHash3_x86_32Hash64Bits(/*seed=*/ 0, low, high), i + 1);
  }
  return table;
}

function queryUint64PermutationHashMap(
    table: TypedArray, values: Uint32Array, low: number, high: number): number {
  let hashCode = murmurHash3_x86_32Hash64Bits(/*seed=*/ 0, low, high);
  const mask = table.length - 1;
  while (true) {
    hashCode = hashCode & mask;
    let index = table[hashCode];
    if (index === 0) return -1;
    --index;
    if (values[2 * index] === low && values[2 * index + 1] === high) {
      return index;
    }
    ++hashCode;
  }
}

export class SegmentPropertyMap {
  inlineProperties: InlineSegmentPropertyMap|undefined;

  constructor(options: {inlineProperties?: InlineSegmentPropertyMap|undefined}) {
    this.inlineProperties = options.inlineProperties;
  }
}

export class PreprocessedSegmentPropertyMap {
  // Linear-chaining hash table that maps uint64 ids to indices into `inlineProperties.ids`.
  inlineIdToIndex: IndicesArray|undefined;
  tags: InlineSegmentTagsProperty|undefined;
  labels: InlineSegmentStringProperty|undefined;
  numericalProperties: InlineSegmentNumericalProperty[];

  getSegmentInlineIndex(id: Uint64): number {
    const {inlineIdToIndex} = this;
    if (inlineIdToIndex === undefined) return -1;
    return queryUint64PermutationHashMap(
        inlineIdToIndex, this.segmentPropertyMap.inlineProperties!.ids, id.low, id.high);
  }

  constructor(public segmentPropertyMap: SegmentPropertyMap) {
    const {inlineProperties} = segmentPropertyMap;
    if (inlineProperties !== undefined) {
      this.inlineIdToIndex = makeUint64PermutationHashMap(inlineProperties.ids);
    }
    this.tags =
        inlineProperties?.properties.find(p => p.type === 'tags') as InlineSegmentTagsProperty |
        undefined;
    this.labels =
        inlineProperties?.properties.find(p => p.type === 'label') as InlineSegmentStringProperty |
        undefined;
    this.numericalProperties = (inlineProperties?.properties.filter(p => p.type === 'number') ??
                                []) as InlineSegmentNumericalProperty[];
  }

  getSegmentLabel(id: Uint64): string|undefined {
    const index = this.getSegmentInlineIndex(id);
    if (index === -1) return undefined;
    const {labels, tags: tagsProperty} = this;
    let label = '';
    if (labels !== undefined) {
      label = labels.values[index];
    }
    if (tagsProperty !== undefined) {
      const {tags, values} = tagsProperty;
      let tagIndices = values[index];
      for (let i = 0, length = tagIndices.length; i < length; ++i) {
        const tag = tags[tagIndices.charCodeAt(i)];
        if (label.length > 0) {
          label += ' ';
        }
        label += '#';
        label += tag;
      }
    }
    if (label.length === 0) return undefined;
    return label;
  }
}

function remapArray<T>(input: ArrayLike<T>, output: WritableArrayLike<T>, toMerged: IndicesArray) {
  for (let i = 0, length = toMerged.length; i < length; ++i) {
    output[toMerged[i]] = input[i];
  }
}

function isIdArraySorted(ids: Uint32Array): boolean {
  const n = ids.length;
  if (n === 0) return true;
  let prevLow = ids[0], prevHigh = ids[1];
  for (let i = 0; i < n; i += 2) {
    const low = ids[i], high = ids[i + 1];
    if (((high - prevHigh) || (low - prevLow)) <= 0) return false;
    prevLow = low;
    prevHigh = high;
  }
  return true;
}

export function normalizeInlineSegmentPropertyMap(inlineProperties: InlineSegmentPropertyMap):
    InlineSegmentPropertyMap {
  // Check if ids are already sorted.
  const {ids} = inlineProperties;
  if (isIdArraySorted(ids)) {
    return inlineProperties;
  }
  const length = ids.length / 2;
  const permutation = makeIndicesArray(length, length - 1);
  for (let i = 0; i < length; ++i) {
    permutation[i] = i;
  }
  permutation.sort((a, b) => {
    const aLow = ids[a * 2], aHigh = ids[a * 2 + 1];
    const bLow = ids[b * 2], bHigh = ids[b * 2 + 1];
    return (aHigh - bHigh) || (aLow - bLow);
  });
  const newIds = new Uint32Array(length * 2);
  for (let newIndex = 0; newIndex < length; ++newIndex) {
    const oldIndex = permutation[newIndex];
    newIds[newIndex * 2] = ids[oldIndex * 2];
    newIds[newIndex * 2 + 1] = ids[oldIndex * 2 + 1];
  }
  const properties = inlineProperties.properties.map(property => {
    const {values} = property;
    const newValues = new (values.constructor as (TypedArrayConstructor | typeof Array))(length);
    for (let i = 0; i < length; ++i) {
      newValues[i] = values[permutation[i]];
    }
    return {...property, values: newValues} as InlineSegmentProperty;
  });
  return {ids: newIds, properties};
}

function remapStringProperty(
    property: InlineSegmentStringProperty|InlineSegmentTagsProperty, numMerged: number,
    toMerged: Uint32Array): InlineSegmentStringProperty|InlineSegmentTagsProperty {
  const values = new Array<string>(numMerged);
  values.fill('');
  remapArray(property.values, values, toMerged);
  return {...property, values};
}

function remapNumericalProperty(
    property: InlineSegmentNumericalProperty, numMerged: number,
    toMerged: Uint32Array): InlineSegmentNumericalProperty {
  const values = new Float32Array(numMerged);
  values.fill(Number.NaN);
  remapArray(property.values, values, toMerged);
  return {...property, values};
}

function remapProperty(property: InlineSegmentProperty, numMerged: number, toMerged: Uint32Array):
    InlineSegmentProperty {
  const {type} = property;
  if (type === 'label' || type === 'description' || type === 'string' || type === 'tags') {
    return remapStringProperty(
        property as InlineSegmentStringProperty | InlineSegmentTagsProperty, numMerged, toMerged);
  }
  return remapNumericalProperty(property as InlineSegmentNumericalProperty, numMerged, toMerged);
}

function mergeInlinePropertyMaps(
    a: InlineSegmentPropertyMap|undefined,
    b: InlineSegmentPropertyMap|undefined): InlineSegmentPropertyMap|undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  // Determine number of unique ids and mapping from `a` and `b` indices to joined indices.
  let numUnique = 0;
  const aCount = a.ids.length / 2;
  const bCount = b.ids.length / 2;
  const aToMerged = new Uint32Array(aCount), bToMerged = new Uint32Array(bCount);
  const aIds = a.ids, bIds = b.ids;
  mergeSequences(
      aCount, bCount,
      (a, b) => {
        const aHigh = aIds[2 * a + 1];
        const aLow = aIds[2 * a];
        const bHigh = bIds[2 * b + 1];
        const bLow = bIds[2 * b];
        return (aHigh - bHigh) || (aLow - bLow);
      },
      a => {
        aToMerged[a] = numUnique;
        ++numUnique;
      },
      b => {
        bToMerged[b] = numUnique;
        ++numUnique;
      },
      (a, b) => {
        aToMerged[a] = numUnique;
        bToMerged[b] = numUnique;
        ++numUnique;
      });
  let ids: Uint32Array;
  if (numUnique === aCount) {
    ids = aIds;
  } else if (numUnique === bCount) {
    ids = bIds;
  } else {
    ids = new Uint32Array(numUnique * 2);
    for (let a = 0; a < aCount; ++a) {
      const i = aToMerged[a];
      ids[2 * i] = aIds[2 * a];
      ids[2 * i + 1] = aIds[2 * a + 1];
    }
    for (let b = 0; b < bCount; ++b) {
      const i = bToMerged[b];
      ids[2 * i] = bIds[2 * b];
      ids[2 * i + 1] = bIds[2 * b + 1];
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
  return {ids, properties};
}

function mergePropertyMaps(a: SegmentPropertyMap, b: SegmentPropertyMap) {
  return new SegmentPropertyMap({
    inlineProperties: mergeInlinePropertyMaps(a.inlineProperties, b.inlineProperties),
  });
}

export function mergeSegmentPropertyMaps(maps: SegmentPropertyMap[]): SegmentPropertyMap|undefined {
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
    chunkManager: ChunkManager, maps: SegmentPropertyMap[]): PreprocessedSegmentPropertyMap|
    undefined {
  return chunkManager.memoize.getUncounted(
      {id: 'getPreprocessedSegmentPropertyMap', maps: maps.map(m => getObjectId(m))}, () => {
        const merged = mergeSegmentPropertyMaps(maps);
        if (merged === undefined) return undefined;
        return new PreprocessedSegmentPropertyMap(merged);
      });
}

export interface SortBy {
  fieldId: string;
  order: '<'|'>';
}

export interface ExplicitIdQuery {
  ids: Uint64[];
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
  prefix: string|undefined, regexp: RegExp|undefined;
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

export type QueryParseResult = ExplicitIdQuery|FilterQuery|QueryParseErrors;

const idPattern = /^[,\s]*[0-9]+(?:[,\s]+[0-9]+)*[,\s]*$/;

export function parseSegmentQuery(
    db: PreprocessedSegmentPropertyMap|undefined, queryString: string): QueryParseResult {
  if (queryString.match(idPattern) !== null) {
    const parts = queryString.split(/[\s,]+/);
    const ids: Uint64[] = [];
    const idSet = new Set<string>();
    for (let i = 0, n = parts.length; i < n; ++i) {
      const part = parts[i];
      if (part === '') continue;
      const id = new Uint64();
      if (!id.tryParseString(part)) {
        continue;
      }
      const idString = id.toString();
      if (idSet.has(idString)) continue;
      idSet.add(idString);
      ids.push(id);
    }
    ids.sort(Uint64.compare);
    return {ids};
  }
  const parsed: FilterQuery = {
    regexp: undefined,
    prefix: undefined,
    includeTags: [],
    excludeTags: [],
    numericalConstraints: [],
    sortBy: [],
    includeColumns: [],
  };
  const properties = db?.segmentPropertyMap.inlineProperties?.properties;
  const tags = db?.tags;
  const tagNames = (tags?.tags || []);
  const lowerCaseTags = tagNames.map(x => x.toLowerCase());
  const labels = db?.labels;
  const errors: QueryParseError[] = [];
  let nextStartIndex: number;
  for (let startIndex = 0; startIndex < queryString.length; startIndex = nextStartIndex) {
    let endIndex = queryString.indexOf(' ', startIndex);
    let word: string;
    if (endIndex === -1) {
      nextStartIndex = endIndex = queryString.length;
    } else {
      nextStartIndex = endIndex + 1;
    }
    word = queryString.substring(startIndex, endIndex);
    if (word.length === 0) continue;
    const checkTag = (tag: string, begin: number) => {
      const lowerCaseTag = tag.toLowerCase();
      const tagIndex = lowerCaseTags.indexOf(lowerCaseTag);
      if (tagIndex === -1) {
        errors.push({begin, end: endIndex, message: `Invalid tag: ${tag}`});
        return undefined;
      }
      tag = tagNames[tagIndex];
      if (parsed.includeTags.includes(tag) || parsed.excludeTags.includes(tag)) {
        errors.push({begin, end: endIndex, message: `Duplicate tag: ${tag}`});
        return undefined;
      }
      return tag;
    };
    if (word.startsWith('#')) {
      const tag = checkTag(word.substring(1), startIndex + 1);
      if (tag !== undefined) {
        parsed.includeTags.push(tag);
      }
      continue;
    }
    if (word.startsWith('-#')) {
      const tag = checkTag(word.substring(2), startIndex + 2);
      if (tag !== undefined) {
        parsed.excludeTags.push(tag);
      }
      continue;
    }
    if (word.startsWith('<') || word.startsWith('>')) {
      let fieldId = word.substring(1).toLowerCase();
      if (fieldId !== 'id' && fieldId !== 'label') {
        const property = properties?.find(
            p => p.id.toLowerCase() === fieldId &&
                (p.type === 'number' || p.type === 'label' || p.type === 'string'));
        if (property === undefined) {
          errors.push({begin: startIndex + 1, end: endIndex, message: `Invalid field: ${fieldId}`});
          continue;
        }
        fieldId = property.id;
      }
      if (parsed.sortBy.find(x => x.fieldId === fieldId) !== undefined) {
        errors.push(
            {begin: startIndex + 1, end: endIndex, message: `Duplicate sort field: ${fieldId}`});
        continue;
      }
      parsed.sortBy.push({order: word[0] as '<' | '>', fieldId});
      continue;
    }
    if (word.startsWith('|')) {
      let fieldId = word.substring(1).toLowerCase();
      if (fieldId === 'id' || fieldId === 'label') continue;
      const property = properties?.find(
          p => p.id.toLowerCase() === fieldId && (p.type === 'number' || p.type === 'string'));
      if (property === undefined) {
        errors.push({begin: startIndex + 1, end: endIndex, message: `Invalid field: ${fieldId}`});
        continue;
      }
      fieldId = property.id;
      if (parsed.sortBy.find(x => x.fieldId === fieldId) ||
          parsed.includeColumns.find(x => x === fieldId)) {
        // Ignore duplicate column.
        continue;
      }
      parsed.includeColumns.push(fieldId);
      continue;
    }
    if (word.startsWith('/')) {
      if (parsed.regexp !== undefined) {
        errors.push(
            {begin: startIndex, end: endIndex, message: 'Only one regular expression allowed'});
        continue;
      }
      if (parsed.prefix !== undefined) {
        errors.push({
          begin: startIndex,
          end: endIndex,
          message: 'Prefix cannot be combined with regular expression'
        });
        continue;
      }
      if (labels === undefined) {
        errors.push({begin: startIndex, end: endIndex, message: 'No label property'});
        continue;
      }
      try {
        parsed.regexp = new RegExp(word.substring(1));
      } catch (e) {
        errors.push(
            {begin: startIndex, end: endIndex, message: 'Invalid regular expression syntax'});
      }
      continue;
    }
    const constraintMatch = word.match(/^([a-zA-Z][a-zA-Z0-9_]*)(<|<=|=|>=|>)([0-9.].*)$/);
    if (constraintMatch !== null) {
      let fieldId = constraintMatch[1].toLowerCase();
      const op = constraintMatch[2];
      const property = db?.numericalProperties.find(p => p.id.toLowerCase() === fieldId);
      if (property === undefined) {
        errors.push({
          begin: startIndex,
          end: startIndex + fieldId.length,
          message: `Invalid numerical field: ${fieldId}`
        });
        continue;
      }
      fieldId = property.id;
      let value: number;
      try {
        value = parseDataTypeValue(property.dataType, constraintMatch[3]) as number;
      } catch (e) {
        errors.push({
          begin: startIndex + constraintMatch[1].length + constraintMatch[2].length,
          end: endIndex,
          message: e.message,
        });
        continue;
      }
      let constraint = parsed.numericalConstraints.find(c => c.fieldId === fieldId);
      if (constraint === undefined) {
        constraint = {fieldId, bounds: property.bounds};
        parsed.numericalConstraints.push(constraint);
      }
      const origMin = clampToInterval(property.bounds, constraint.bounds[0]),
            origMax = clampToInterval(property.bounds, constraint.bounds[1]);
      let newMax = origMax, newMin = origMin;
      switch (op) {
        case '<':
          newMax = dataTypeValueNextAfter(property.dataType, value, -1);
          break;
        case '<=':
          newMax = value;
          break;
        case '=':
          newMax = newMin = value;
          break;
        case '>=':
          newMin = value;
          break;
        case '>':
          newMin = dataTypeValueNextAfter(property.dataType, value, +1);
          break;
      }
      newMin = dataTypeCompare(origMin, newMin) > 0 ? origMin : newMin;
      newMax = dataTypeCompare(origMax, newMax) < 0 ? origMax : newMax;
      if (dataTypeCompare(newMin, newMax) > 0) {
        errors.push(
            {begin: startIndex, end: endIndex, message: 'Constraint would not match any values'});
        continue;
      }
      constraint.bounds = [newMin, newMax] as DataTypeInterval;
      continue;
    }
    if (parsed.regexp !== undefined) {
      errors.push({
        begin: startIndex,
        end: endIndex,
        message: 'Prefix cannot be combined with regular expression'
      });
      continue;
    }
    if (labels === undefined) {
      errors.push({begin: startIndex, end: endIndex, message: 'No label property'});
      continue;
    }
    if (parsed.prefix !== undefined) {
      parsed.prefix += ` ${word}`;
    } else {
      parsed.prefix = word;
    }
  }
  if (errors.length > 0) {
    return {errors};
  }
  if (parsed.sortBy.length === 0) {
    // Add default sort order.
    parsed.sortBy.push({fieldId: getDefaultSortField(db), order: '<'});
  }
  return parsed;
}

export interface TagCount {
  tag: string;
  tagIndex: number;
  count: number;
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
  intermediateIndices?: IndicesArray|undefined;
  // Bitvectors for each index in `intermediateIndices`.  Bit `i` is true if constraints on
  // numerical property `i` are satisfied.  This along with `intermediateIndices` is used to compute
  // "marginal" histograms for the numerical properties, for the distribution with all other
  // constraints applied, but without constraining the property for which we are computing the
  // histogram.
  intermediateIndicesMask?: Uint32Array|Uint16Array|Uint8Array|undefined;
  // Indices into the inline properties table that satisfy all constraints.  Sorting is applied.
  indices?: IndicesArray|undefined;
  explicitIds?: Uint64[]|undefined;
  tags?: TagCount[]|undefined;
  count: number;
  total: number;
  errors?: QueryParseError[]|undefined;
}

function regexpEscapeCharCode(code: number) {
  return '\\u' + code.toString(16).padStart(4, '0');
}

export function executeSegmentQuery(
    db: PreprocessedSegmentPropertyMap|undefined, query: QueryParseResult): QueryResult {
  if (query.errors !== undefined) {
    return {query, total: -1, count: 0, errors: query.errors};
  }
  if (query.ids !== undefined) {
    const {ids} = query;
    return {query, total: -1, explicitIds: ids, count: ids.length};
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
  const totalIds = inlineProperties.ids.length / 2;
  let indices = makeIndicesArray(totalIds, totalIds);
  for (let i = 0; i < totalIds; ++i) {
    indices[i] = i;
  }

  const filterIndices = (predicate: (index: number) => boolean) => {
    let length = indices.length;
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

  // Filter by label
  if (query.regexp !== undefined || query.prefix !== undefined) {
    const values = db!.labels!.values;
    const {regexp, prefix} = query;
    if (regexp !== undefined) {
      filterIndices(index => values[index].match(regexp) !== null);
    }
    if (prefix !== undefined) {
      filterIndices(index => values[index].startsWith(prefix));
    }
  }

  // Filter by tags
  const {includeTags, excludeTags} = query;
  const tagsProperty = db!.tags;
  if (includeTags.length > 0 || excludeTags.length > 0) {
    // Since query was already validated, tags property must exist if tags were specified.
    const {values, tags} = tagsProperty!;
    const allTags = [];
    for (const tag of includeTags) {
      allTags.push([tags.indexOf(tag), 1]);
    }
    for (const tag of excludeTags) {
      allTags.push([tags.indexOf(tag), 0]);
    }
    allTags.sort((a, b) => a[0] - b[0]);
    let pattern = '^';
    let prevTagIndex = 0;
    const addSkipPattern = (endCode: number) => {
      if (endCode < prevTagIndex) return;
      pattern += `[${regexpEscapeCharCode(prevTagIndex)}-${regexpEscapeCharCode(endCode)}]*`;
    };
    for (const [tagIndex, sign] of allTags) {
      addSkipPattern(tagIndex - 1);
      if (sign) {
        pattern += regexpEscapeCharCode(tagIndex);
      }
      prevTagIndex = tagIndex + 1;
    }
    addSkipPattern(0xffff);
    pattern += '$';
    const regexp = new RegExp(pattern);
    filterIndices(index => values[index].match(regexp) !== null);
  }

  let intermediateIndicesMask: IndicesArray|undefined;
  let intermediateIndices: IndicesArray|undefined;

  // Filter by numerical properties.
  const {numericalConstraints} = query;
  if (numericalConstraints.length > 0) {
    const numericalProperties = db!.numericalProperties;
    const numNumericalConstraints = numericalConstraints.length;
    const fullMask = 2 ** (numNumericalConstraints) - 1;
    intermediateIndicesMask = makeIndicesArray(indices.length, fullMask);
    for (let constraintIndex = 0; constraintIndex < numNumericalConstraints; ++constraintIndex) {
      const constraint = numericalConstraints[constraintIndex];
      const property = numericalProperties.find(p => p.id === constraint.fieldId)!;
      const {values} = property;
      const bit = 2 ** constraintIndex;
      const [min, max] = constraint.bounds as [number, number];
      for (let i = 0, n = indices.length; i < n; ++i) {
        const value = values[indices[i]];
        intermediateIndicesMask[i] |= bit * ((value >= min && value <= max) as any);
      }
    }
    intermediateIndices = indices;
    indices = intermediateIndices.slice();
    let length = indices.length;
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
    const {tags, values} = tagsProperty;
    const tagCounts = new Uint32Array(tags.length);
    for (let i = 0, n = indices.length; i < n; ++i) {
      const value = values[indices[i]];
      for (let j = 0, m = value.length; j < m; ++j) {
        ++tagCounts[value.charCodeAt(j)];
      }
    }
    for (let tagIndex = 0, numTags = tags.length; tagIndex < numTags; ++tagIndex) {
      const count = tagCounts[tagIndex];
      const tag = tags[tagIndex];
      const tagCount = {tag, tagIndex, count: tagCounts[tagIndex]};
      if (query.includeTags.includes(tag) || query.excludeTags.includes(tag)) {
        tagStatisticsInQuery.push(tagCount);
      } else if (count > 0) {
        tagStatistics.push(tagCount);
      }
    }
    tagStatisticsInQuery.push(...tagStatistics);
    tagStatistics = tagStatisticsInQuery;
  }

  const sortByProperty = (property: InlineSegmentProperty, orderCoeff: number) => {
    if (property.type !== 'number') {
      const {values} = property;
      indices.sort((a, b) => defaultStringCompare(values[a], values[b]) * orderCoeff);
    } else {
      const values = property.values as TypedArray;
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
  const {sortBy} = query;
  for (let i = sortBy.length - 1; i >= 0; --i) {
    const {fieldId, order} = sortBy[i];
    const orderCoeff = order === '<' ? 1 : -1;
    if (fieldId === 'id') {
      if (i + 1 === sortBy.length) {
        if (order === '<') {
          // Default order, no need to sort.
          continue;
        } else {
          indices.reverse();
          continue;
        }
      }
      indices.sort((a, b) => orderCoeff * (a - b));
      continue;
    } else if (fieldId === 'label') {
      sortByLabel(orderCoeff);
    } else {
      sortByProperty(properties.find(p => p.id === fieldId)!, orderCoeff);
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
    queryResult: QueryResult, property: InlineSegmentNumericalProperty,
    bounds: DataTypeInterval): PropertyHistogram {
  const numBins = 256;
  const {values} = property;
  const [min, max] = bounds as [number, number];
  const multiplier = max <= min ? 0 : (numBins / (max - min));
  const histogram = new Uint32Array(numBins + 2);
  const {numericalConstraints} = queryResult!.query as FilterQuery;
  const constraintIndex = numericalConstraints.findIndex(c => c.fieldId === property.id);
  if (constraintIndex === -1) {
    // Property is unconstrained, just compute histogram from final result set.
    const indices = queryResult.indices!;
    for (let i = 0, n = indices.length; i < n; ++i) {
      const value = values[indices[i]];
      if (!isNaN(value)) {
        ++histogram[(Math.min(numBins - 1, Math.max(-1, (value - min) * multiplier)) + 1) >>> 0];
      }
    }
  } else {
    // Property is constrained, compute histogram from intermediateIndices.
    const intermediateIndices = queryResult.intermediateIndices!;
    const intermediateIndicesMask = queryResult.intermediateIndicesMask!;
    const requiredBits = 2 ** (numericalConstraints.length) - 1 - 2 ** constraintIndex;
    for (let i = 0, n = intermediateIndices.length; i < n; ++i) {
      const mask = intermediateIndicesMask[i];
      if ((mask & requiredBits) == requiredBits) {
        const value = values[intermediateIndices[i]];
        if (!isNaN(value)) {
          ++histogram[(Math.min(numBins - 1, Math.max(-1, (value - min) * multiplier)) + 1) >>> 0];
        }
      }
    }
  }
  return {queryResult, histogram, window: bounds};
}

export function updatePropertyHistograms(
    db: PreprocessedSegmentPropertyMap|undefined, queryResult: QueryResult|undefined,
    propertyHistograms: PropertyHistogram[], bounds: DataTypeInterval[]) {
  if (db === undefined) {
    propertyHistograms.length = 0;
    bounds.length = 0;
    return;
  }
  const {numericalProperties} = db;
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
    if (propertyHistogram !== undefined && propertyHistogram.queryResult === queryResult &&
        dataTypeIntervalEqual(property.dataType, propertyHistogram.window, propertyBounds)) {
      continue;
    }
    propertyHistograms[i] = updatePropertyHistogram(queryResult!, property, propertyBounds);
  }
}

function getDefaultSortField(db: PreprocessedSegmentPropertyMap|undefined) {
  return db?.tags || db?.labels ? 'label' : 'id';
}

export function unparseSegmentQuery(
    db: PreprocessedSegmentPropertyMap|undefined, query: ExplicitIdQuery|FilterQuery): string {
  const {ids} = query;
  if (ids !== undefined) {
    return ids.map(x => x.toString()).join(', ');
  }
  let queryString = '';
  query = query as FilterQuery;
  const {prefix, regexp} = query;
  if (prefix !== undefined) {
    queryString = prefix
  } else if (regexp !== undefined) {
    queryString = `/${regexp}`;
  }
  for (const tag of query.includeTags) {
    if (queryString.length > 0) queryString += ' ';
    queryString += `#${tag}`;
  }
  for (const tag of query.excludeTags) {
    if (queryString.length > 0) queryString += ' ';
    queryString += `-#${tag}`;
  }
  for (const constraint of query.numericalConstraints) {
    const {fieldId, bounds} = constraint;
    const [min, max] = bounds as [number, number];
    const property = db!.numericalProperties.find(p => p.id === fieldId)!;
    if (dataTypeIntervalEqual(property.dataType, property.bounds, bounds)) {
      continue;
    }
    if (dataTypeCompare(min, max) === 0) {
      if (queryString.length > 0) queryString += ' ';
      queryString += `${fieldId}=${min}`;
      continue;
    }
    if (dataTypeCompare(min, property.bounds[0]) > 0) {
      if (queryString.length > 0) queryString += ' ';
      const beforeMin = dataTypeValueNextAfter(property.dataType, min, -1);
      const minString = min.toString();
      const beforeMinString = beforeMin.toString();
      if (property.dataType !== DataType.FLOAT32 || minString.length <= beforeMinString.length) {
        queryString += `${fieldId}>=${minString}`;
      } else {
        queryString += `${fieldId}>${beforeMinString}`;
      }
    }
    if (dataTypeCompare(max, property.bounds[1]) < 0) {
      if (queryString.length > 0) queryString += ' ';
      const afterMax = dataTypeValueNextAfter(property.dataType, max, +1);
      const maxString = max.toString();
      const afterMaxString = afterMax.toString();
      if (property.dataType !== DataType.FLOAT32 || maxString.length <= afterMaxString.length) {
        queryString += `${fieldId}<=${maxString}`;
      } else {
        queryString += `${fieldId}<${afterMaxString}`;
      }
    }
  }
  let {sortBy} = query;
  if (sortBy.length === 1) {
    const s = sortBy[0];
    if (s.order === '<' && s.fieldId === getDefaultSortField(db)) {
      sortBy = [];
    }
  }
  for (const s of sortBy) {
    if (queryString.length > 0) queryString += ' ';
    queryString += `${s.order}${s.fieldId}`;
  }
  for (const fieldId of query.includeColumns) {
    if (queryString.length > 0) queryString += ' ';
    queryString += `|${fieldId}`;
  }
  return queryString;
}

const tempUint64 = new Uint64();
export function forEachQueryResultSegmentId(
    db: PreprocessedSegmentPropertyMap|undefined, queryResult: QueryResult|undefined,
    callback: (id: Uint64, index: number) => void) {
  if (queryResult === undefined) return;
  const {explicitIds} = queryResult;
  if (explicitIds !== undefined) {
    explicitIds.forEach(callback);
    return;
  }
  const {indices} = queryResult;
  if (indices !== undefined) {
    const {ids} = db?.segmentPropertyMap.inlineProperties!;
    for (let i = 0, count = indices.length; i < count; ++i) {
      const propIndex = indices[i];
      tempUint64.low = ids[propIndex * 2];
      tempUint64.high = ids[propIndex * 2 + 1];
      callback(tempUint64, i);
    }
  }
}

export function findQueryResultIntersectionSize(
    db: PreprocessedSegmentPropertyMap|undefined, queryResult: QueryResult|undefined,
    segmentSet: Uint64Set): number {
  if (segmentSet.size === 0) return 0;
  let count = 0;
  forEachQueryResultSegmentId(db, queryResult, id => {
    if (segmentSet.has(id)) ++count;
  });
  return count;
}

export function changeTagConstraintInSegmentQuery(
    query: FilterQuery, tag: string, include: boolean, value: boolean): FilterQuery {
  const includeTags = query.includeTags.filter(x => x !== tag);
  const excludeTags = query.excludeTags.filter(x => x !== tag);
  if (value === true) {
    (include ? includeTags : excludeTags).push(tag);
  }
  return {...query, includeTags, excludeTags};
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

export function queryIncludesColumn(query: QueryParseResult|undefined, fieldId: string) {
  if (query === undefined) return false;
  if (query.ids !== undefined) return false;
  if (query.errors !== undefined) return false;
  const {sortBy, includeColumns} = query;
  return sortBy.find(x => x.fieldId === fieldId) !== undefined || includeColumns.includes(fieldId);
}
