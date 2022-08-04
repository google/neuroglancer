/**
 * @license
 * Copyright 2021 Google Inc.
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

import debounce from 'lodash/debounce';
import {ComputedSplit, SegmentationGraphSource, SegmentationGraphSourceConnection, VisibleSegmentEquivalencePolicy} from 'neuroglancer/segmentation_graph/source';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {DisjointUint64Sets} from 'neuroglancer/util/disjoint_sets';
import {parseArray} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';

export class LocalSegmentationGraphSource extends SegmentationGraphSource {
  spanningTreeEdges = new Map<string, Set<string>>();
  equivalences = new SharedDisjointUint64Sets();
  connections = new Set<LocalSegmentationGraphSourceConnection>();
  changed = new Signal();

  private link(a: Uint64, b: Uint64) {
    this.equivalences.link(a, b);
    for (const connection of this.connections) {
      connection.segmentsState.segmentEquivalences.link(a, b);
    }
  }

  private linkAll(ids: Uint64[]) {
    this.equivalences.linkAll(ids);
    for (const connection of this.connections) {
      connection.segmentsState.segmentEquivalences.linkAll(ids);
    }
  }

  private deleteSet(a: Uint64) {
    this.equivalences.deleteSet(a);
    for (const connection of this.connections) {
      connection.segmentsState.segmentEquivalences.deleteSet(a);
    }
  }

  private normalizeAll() {
    for (const connection of this.connections) {
      normalizeSegmentSet(
          connection.segmentsState.visibleSegments,
          connection.segmentsState.segmentEquivalences.disjointSets);
    }
  }

  private addSpanningTreeEdge(a: Uint64, b: Uint64) {
    const aString = a.toString(), bString = b.toString();
    const {spanningTreeEdges} = this;
    let aEdges = spanningTreeEdges.get(aString);
    if (aEdges === undefined) {
      aEdges = new Set();
      spanningTreeEdges.set(aString, aEdges);
    }
    let bEdges = spanningTreeEdges.get(bString);
    if (bEdges === undefined) {
      bEdges = new Set();
      spanningTreeEdges.set(bString, bEdges);
    }
    aEdges.add(bString);
    bEdges.add(aString);
  }

  private removeSpanningTreeEdge(a: Uint64, b: Uint64) {
    const aString = a.toString(), bString = b.toString();
    const {spanningTreeEdges} = this;
    const aEdges = spanningTreeEdges.get(aString)!;
    const bEdges = spanningTreeEdges.get(bString)!;
    aEdges.delete(bString);
    if (aEdges.size === 0) {
      spanningTreeEdges.delete(aString);
    }
    bEdges.delete(aString);
    if (bEdges.size === 0) {
      spanningTreeEdges.delete(bString);
    }
  }

  private * getSpanningTreeNeighbors(a: Uint64): IterableIterator<Uint64> {
    const b = new Uint64();
    const neighbors = this.spanningTreeEdges.get(a.toString());
    if (neighbors === undefined) return;
    for (const neighborString of neighbors) {
      b.parseString(neighborString);
      yield b;
    }
  }

  restoreState(obj: unknown) {
    const {equivalences, spanningTreeEdges} = this;
    equivalences.clear();
    spanningTreeEdges.clear();
    if (obj === undefined) {
      return;
    }
    const ids = [new Uint64(), new Uint64()];
    parseArray(obj, groupObj => {
      parseArray(groupObj, (s, index) => {
        ids[index % 2].parseString(String(s), 10);
        if (index !== 0) {
          if (equivalences.link(ids[0], ids[1])) {
            this.addSpanningTreeEdge(ids[0], ids[1]);
          }
        }
      });
    });
  }

  toJSON() {
    const {spanningTreeEdges} = this;
    if (spanningTreeEdges.size === 0) return undefined;
    const sets = new Array<Uint64[]>();
    for (let [idString, neighbors] of spanningTreeEdges) {
      const a = Uint64.parseString(idString);
      for (const neighborString of neighbors) {
        const b = Uint64.parseString(neighborString);
        if (Uint64.compare(a, b) > 0) continue;
        sets.push([a, b]);
      }
    }
    sets.sort((a, b) => Uint64.compare(a[0], b[0]) || Uint64.compare(a[1], b[1]));
    return sets.map(set => set.map(element => element.toString()));
  }

  get visibleSegmentEquivalencePolicy() {
    return VisibleSegmentEquivalencePolicy.MIN_REPRESENTATIVE;
  }

  async merge(a: Uint64, b: Uint64): Promise<Uint64> {
    const {equivalences} = this;
    if (Uint64.equal(equivalences.get(a), equivalences.get(b))) {
      // Already merged.
      return a;
    }
    this.addSpanningTreeEdge(a, b);
    this.link(a, b);
    this.normalizeAll();
    this.changed.dispatch();
    return equivalences.get(a);
  }

  async split(a: Uint64, b: Uint64): Promise<{include: Uint64, exclude: Uint64}> {
    const result = this.computeSplit(a, b);
    if (result === undefined) {
      throw new Error('Segments are already split');
    }
    const {includeBaseSegments, includeRepresentative, excludeBaseSegments, excludeRepresentative} =
        result;
    const {equivalences} = this;
    this.deleteSet(a);
    this.linkAll(includeBaseSegments);
    this.linkAll(excludeBaseSegments);
    const removeSplitEdges = (segments: Uint64[], expectedRoot: Uint64) => {
      for (const id of segments) {
        for (const neighbor of this.getSpanningTreeNeighbors(id)) {
          if (!Uint64.equal(equivalences.get(neighbor), expectedRoot)) {
            this.removeSpanningTreeEdge(id, neighbor);
          }
        }
      }
    };
    const includeRoot = equivalences.get(a);
    const excludeRoot = equivalences.get(b);
    removeSplitEdges(includeBaseSegments, includeRoot);
    removeSplitEdges(excludeBaseSegments, excludeRoot);
    for (const connection of this.connections) {
      const {visibleSegments} = connection.segmentsState;
      if (visibleSegments.has(excludeRepresentative)) {
        visibleSegments.delete(excludeRepresentative);
        visibleSegments.add(includeRepresentative);
      }
    }
    this.normalizeAll();
    this.changed.dispatch();
    return {include: includeRoot, exclude: excludeRoot};
  }

  trackSegment(id: Uint64, callback: (id: Uint64|null) => void): () => void {
    // FIXME: implement
    id;
    callback;
    return () => {

    };
  }

  computeSplit(include: Uint64, exclude: Uint64): ComputedSplit|undefined {
    const {equivalences} = this;
    const root = equivalences.get(include);
    if (!Uint64.equal(root, equivalences.get(exclude))) {
      // Already split.
      return undefined;
    }
    const ds = new DisjointUint64Sets();
    for (const baseSegment of equivalences.setElements(root)) {
      if (Uint64.equal(baseSegment, exclude)) continue;
      for (const neighbor of this.getSpanningTreeNeighbors(baseSegment)) {
        if (Uint64.equal(neighbor, exclude)) continue;
        ds.link(baseSegment, neighbor);
      }
    }
    const includeSegments: Uint64[] = [];
    const excludeSegments: Uint64[] = [];
    const includeRoot = ds.get(include);
    let includeRep = include;
    let excludeRep = exclude;
    for (const baseSegment of equivalences.setElements(root)) {
      if (Uint64.equal(ds.get(baseSegment), includeRoot)) {
        includeSegments.push(baseSegment);
        if (Uint64.compare(baseSegment, includeRep) < 0) includeRep = baseSegment;
      } else {
        excludeSegments.push(baseSegment);
        if (Uint64.compare(baseSegment, excludeRep) < 0) excludeRep = baseSegment;
      }
    }
    includeSegments.sort(Uint64.compare);
    excludeSegments.sort(Uint64.compare);
    return {
      includeBaseSegments: includeSegments,
      includeRepresentative: includeRep,
      excludeBaseSegments: excludeSegments,
      excludeRepresentative: excludeRep
    };
  }

  connect(layer: SegmentationUserLayer): SegmentationGraphSourceConnection {
    const segmentsState = layer.displayState.segmentationGroupState.value;
    const connection = new LocalSegmentationGraphSourceConnection(this, segmentsState);
    segmentsState.segmentEquivalences.assignFrom(this.equivalences);
    normalizeSegmentSet(
        segmentsState.visibleSegments, segmentsState.segmentEquivalences.disjointSets);
    connection.registerDisposer(
        segmentsState.visibleSegments.changed.add(connection.registerCancellable(debounce(
            () => normalizeSegmentSet(
                segmentsState.visibleSegments, segmentsState.segmentEquivalences.disjointSets),
            0))));
    this.connections.add(connection);
    connection.registerDisposer(() => {
      this.connections.delete(connection);
    });
    return connection;
  }
}

function normalizeSegmentSet(segmentSet: Uint64Set, equivalences: DisjointUint64Sets) {
  const add: Uint64[] = [];
  for (const id of segmentSet.unsafeKeys()) {
    const rootId = equivalences.get(id);
    if (!Uint64.equal(id, rootId)) {
      add.push(rootId);
      segmentSet.delete(id);
    }
  }
  for (const id of add) {
    segmentSet.add(id);
  }
}

class LocalSegmentationGraphSourceConnection extends
    SegmentationGraphSourceConnection<LocalSegmentationGraphSource> {
  computeSplit(include: Uint64, exclude: Uint64): ComputedSplit|undefined {
    return this.graph.computeSplit(include, exclude);
  }
}
