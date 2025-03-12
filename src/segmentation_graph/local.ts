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

import { debounce } from "lodash-es";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type { ComputedSplit } from "#src/segmentation_graph/source.js";
import {
  SegmentationGraphSource,
  SegmentationGraphSourceConnection,
} from "#src/segmentation_graph/source.js";
import { SharedDisjointUint64Sets } from "#src/shared_disjoint_sets.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { bigintCompare } from "#src/util/bigint.js";
import { DisjointUint64Sets } from "#src/util/disjoint_sets.js";
import { parseArray, parseUint64 } from "#src/util/json.js";
import { Signal } from "#src/util/signal.js";

export class LocalSegmentationGraphSource extends SegmentationGraphSource {
  spanningTreeEdges = new Map<bigint, Set<bigint>>();
  equivalences = new SharedDisjointUint64Sets();
  connections = new Set<LocalSegmentationGraphSourceConnection>();
  changed = new Signal();

  private link(a: bigint, b: bigint) {
    this.equivalences.link(a, b);
    for (const connection of this.connections) {
      connection.segmentsState.segmentEquivalences.link(a, b);
    }
  }

  private linkAll(ids: bigint[]) {
    this.equivalences.linkAll(ids);
    for (const connection of this.connections) {
      connection.segmentsState.segmentEquivalences.linkAll(ids);
    }
  }

  private deleteSet(a: bigint) {
    this.equivalences.deleteSet(a);
    for (const connection of this.connections) {
      connection.segmentsState.segmentEquivalences.deleteSet(a);
    }
  }

  private normalizeAll() {
    for (const connection of this.connections) {
      normalizeSegmentSet(
        connection.segmentsState.visibleSegments,
        connection.segmentsState.segmentEquivalences.disjointSets,
      );
    }
  }

  private addSpanningTreeEdge(a: bigint, b: bigint) {
    const { spanningTreeEdges } = this;
    let aEdges = spanningTreeEdges.get(a);
    if (aEdges === undefined) {
      aEdges = new Set();
      spanningTreeEdges.set(a, aEdges);
    }
    let bEdges = spanningTreeEdges.get(b);
    if (bEdges === undefined) {
      bEdges = new Set();
      spanningTreeEdges.set(b, bEdges);
    }
    aEdges.add(b);
    bEdges.add(a);
  }

  private removeSpanningTreeEdge(a: bigint, b: bigint) {
    const { spanningTreeEdges } = this;
    const aEdges = spanningTreeEdges.get(a)!;
    const bEdges = spanningTreeEdges.get(b)!;
    aEdges.delete(b);
    if (aEdges.size === 0) {
      spanningTreeEdges.delete(a);
    }
    bEdges.delete(a);
    if (bEdges.size === 0) {
      spanningTreeEdges.delete(b);
    }
  }

  private *getSpanningTreeNeighbors(a: bigint): IterableIterator<bigint> {
    const neighbors = this.spanningTreeEdges.get(a);
    if (neighbors === undefined) return;
    yield* neighbors;
  }

  restoreState(obj: unknown) {
    const { equivalences, spanningTreeEdges } = this;
    equivalences.clear();
    spanningTreeEdges.clear();
    if (obj === undefined) {
      return;
    }
    parseArray(obj, (groupObj) => {
      let prev: bigint | undefined;
      parseArray(groupObj, (s) => {
        const id = parseUint64(s);
        if (prev !== undefined) {
          if (equivalences.link(prev, id)) {
            this.addSpanningTreeEdge(prev, id);
          }
        }
        prev = id;
      });
    });
  }

  toJSON() {
    const { spanningTreeEdges } = this;
    if (spanningTreeEdges.size === 0) return undefined;
    const sets = new Array<bigint[]>();
    for (const [a, neighbors] of spanningTreeEdges) {
      for (const b of neighbors) {
        if (a > b) continue;
        sets.push([a, b]);
      }
    }
    sets.sort((a, b) => bigintCompare(a[0], b[0]) || bigintCompare(a[1], b[1]));
    return sets.map((set) => set.map((element) => element.toString()));
  }

  get visibleSegmentEquivalencePolicy() {
    return VisibleSegmentEquivalencePolicy.MIN_REPRESENTATIVE;
  }

  async merge(a: bigint, b: bigint): Promise<bigint> {
    const { equivalences } = this;
    if (equivalences.get(a) === equivalences.get(b)) {
      // Already merged.
      return a;
    }
    this.addSpanningTreeEdge(a, b);
    this.link(a, b);
    this.normalizeAll();
    this.changed.dispatch();
    return equivalences.get(a);
  }

  async split(
    a: bigint,
    b: bigint,
  ): Promise<{ include: bigint; exclude: bigint }> {
    const result = this.computeSplit(a, b);
    if (result === undefined) {
      throw new Error("Segments are already split");
    }
    const {
      includeBaseSegments,
      includeRepresentative,
      excludeBaseSegments,
      excludeRepresentative,
    } = result;
    const { equivalences } = this;
    this.deleteSet(a);
    this.linkAll(includeBaseSegments);
    this.linkAll(excludeBaseSegments);
    const removeSplitEdges = (segments: bigint[], expectedRoot: bigint) => {
      for (const id of segments) {
        for (const neighbor of this.getSpanningTreeNeighbors(id)) {
          if (equivalences.get(neighbor) !== expectedRoot) {
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
      const { selectedSegments, visibleSegments } = connection.segmentsState;
      if (selectedSegments.has(excludeRepresentative)) {
        selectedSegments.delete(excludeRepresentative);
        selectedSegments.add(includeRepresentative);
        visibleSegments.add(includeRepresentative);
      }
    }
    this.normalizeAll();
    this.changed.dispatch();
    return { include: includeRoot, exclude: excludeRoot };
  }

  trackSegment(id: bigint, callback: (id: bigint | null) => void): () => void {
    // FIXME: implement
    id;
    callback;
    return () => {};
  }

  computeSplit(include: bigint, exclude: bigint): ComputedSplit | undefined {
    const { equivalences } = this;
    const root = equivalences.get(include);
    if (root !== equivalences.get(exclude)) {
      // Already split.
      return undefined;
    }
    const ds = new DisjointUint64Sets();
    for (const baseSegment of equivalences.setElements(root)) {
      if (baseSegment === exclude) continue;
      for (const neighbor of this.getSpanningTreeNeighbors(baseSegment)) {
        if (neighbor === exclude) continue;
        ds.link(baseSegment, neighbor);
      }
    }
    const includeSegments: bigint[] = [];
    const excludeSegments: bigint[] = [];
    const includeRoot = ds.get(include);
    let includeRep = include;
    let excludeRep = exclude;
    for (const baseSegment of equivalences.setElements(root)) {
      if (ds.get(baseSegment) === includeRoot) {
        includeSegments.push(baseSegment);
        if (baseSegment < includeRep) {
          includeRep = baseSegment;
        }
      } else {
        excludeSegments.push(baseSegment);
        if (baseSegment < excludeRep) {
          excludeRep = baseSegment;
        }
      }
    }
    includeSegments.sort(bigintCompare);
    excludeSegments.sort(bigintCompare);
    return {
      includeBaseSegments: includeSegments,
      includeRepresentative: includeRep,
      excludeBaseSegments: excludeSegments,
      excludeRepresentative: excludeRep,
    };
  }

  connect(layer: SegmentationUserLayer): SegmentationGraphSourceConnection {
    const segmentsState = layer.displayState.segmentationGroupState.value;
    const connection = new LocalSegmentationGraphSourceConnection(
      this,
      segmentsState,
    );
    segmentsState.segmentEquivalences.assignFrom(this.equivalences);
    normalizeSegmentSet(
      segmentsState.visibleSegments,
      segmentsState.segmentEquivalences.disjointSets,
    );
    connection.registerDisposer(
      segmentsState.visibleSegments.changed.add(
        connection.registerCancellable(
          debounce(
            () =>
              normalizeSegmentSet(
                segmentsState.visibleSegments,
                segmentsState.segmentEquivalences.disjointSets,
              ),
            0,
          ),
        ),
      ),
    );
    this.connections.add(connection);
    connection.registerDisposer(() => {
      this.connections.delete(connection);
    });
    return connection;
  }
}

function normalizeSegmentSet(
  segmentSet: Uint64Set,
  equivalences: DisjointUint64Sets,
) {
  const add: bigint[] = [];
  for (const id of segmentSet.keys()) {
    const rootId = equivalences.get(id);
    if (id !== rootId) {
      add.push(rootId);
      segmentSet.delete(id);
    }
  }
  for (const id of add) {
    segmentSet.add(id);
  }
}

class LocalSegmentationGraphSourceConnection extends SegmentationGraphSourceConnection<LocalSegmentationGraphSource> {
  computeSplit(include: bigint, exclude: bigint): ComputedSplit | undefined {
    return this.graph.computeSplit(include, exclude);
  }
}
