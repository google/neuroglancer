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
import {Borrowed} from 'neuroglancer/util/disposable';
import {defaultStringCompare} from 'neuroglancer/util/string';

export function normalizeSegmentLabel(x: string) {
  //return x.toLowerCase();
  // Use case-sensitive matching.
  return x;
}

export function compareSegmentLabels(a: string, b: string) {
  return defaultStringCompare(normalizeSegmentLabel(a), normalizeSegmentLabel(b));
}

export class SegmentLabelMap {
  readonly sortedNames: readonly(readonly[string, string])[];
  idToLabel: {[id: string]: string} = {};

  has(idString: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.idToLabel, idString);
  }

  get(idString: string) {
    return this.idToLabel[idString];
  }

  constructor(public readonly ids: readonly string[], public labels: readonly string[]) {
    const sortedNames = this.sortedNames = labels.map((label, i) => [ids[i], label]);
    const {idToLabel} = this;
    for (let i = 0, count = ids.length; i < count; ++i) {
      idToLabel[ids[i]] = labels[i];
    }
    sortedNames.sort((a, b) => compareSegmentLabels(a[1], b[1]));
  }
}

export interface InlineSegmentProperty {
  id: string;
  type: 'string'|'label'|'description';
  description: string|undefined;
  values: string[];
}

export interface InlineSegmentPropertyMap {
  ids: string[];
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

export class SegmentPropertyMap {
  inlineIdToIndex: {[id: string]: number}|undefined;
  inlineProperties: InlineSegmentPropertyMap|undefined;
  indexedProperties: IndexedSegmentPropertySource|undefined;
  labelMap: SegmentLabelMap|undefined;

  constructor(options: {
    inlineProperties?: InlineSegmentPropertyMap|undefined,
    indexedProperties?: IndexedSegmentPropertySource|undefined
  }) {
    const inlineProperties = this.inlineProperties = options.inlineProperties;
    if (inlineProperties !== undefined) {
      const {ids} = inlineProperties;
      const idToIndex: {[id: string]: number} = this.inlineIdToIndex = {};
      for (let i = 0, count = ids.length; i < count; ++i) {
        idToIndex[ids[i]] = i;
      }
      // Attempt to compute segment label map
      const labelProperty = inlineProperties.properties.find(p => p.type === 'label');
      if (labelProperty !== undefined) {
        this.labelMap = new SegmentLabelMap(inlineProperties.ids, labelProperty.values);
      }
    }
    this.indexedProperties = options.indexedProperties;
  }
}
