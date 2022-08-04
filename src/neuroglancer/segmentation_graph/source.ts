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

import {VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Disposer, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';
import {RenderLayer } from 'neuroglancer/renderlayer';
import { ChunkManager } from 'neuroglancer/chunk_manager/frontend';
import { SegmentationDisplayState3D } from 'neuroglancer/segmentation_display_state/frontend';
import { SegmentationUserLayer } from 'neuroglancer/segmentation_user_layer';
import { DependentViewContext, DependentViewWidget } from 'neuroglancer/widget/dependent_view_widget';
import { Tab } from 'neuroglancer/widget/tab_view';

export enum VisibleSegmentEquivalencePolicy {
  MIN_REPRESENTATIVE = 0, // defafult, representative elmement is the minimum element in equivalence set
  MAX_REPRESENTATIVE = 1, // representative elmement is the maximum element in equivalence set
  REPRESENTATIVE_EXCLUDED = 1 << 1, // filter out the representative element when iterating over visible segments
  NONREPRESENTATIVE_EXCLUDED = 1 << 2, // filter out non representative elements when iterating over visible segments
}

export class SegmentationGraphSourceTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
    element.appendChild(
      this.registerDisposer(new DependentViewWidget(
                                layer.displayState.segmentationGroupState.value.graph,
                                (graph, parent, context) => {
                                  if (graph?.tabContents) {
                                    parent.appendChild(graph.tabContents(layer, context, this));
                                  }
                                }))
        .element);

  }
}

export abstract class SegmentationGraphSource {
  abstract connect(layer: SegmentationUserLayer): Owned<SegmentationGraphSourceConnection>;
  abstract merge(a: Uint64, b: Uint64): Promise<Uint64>;
  abstract split(include: Uint64, exclude: Uint64): Promise<{include: Uint64, exclude: Uint64}>;
  abstract trackSegment(id: Uint64, callback: (id: Uint64|null) => void): () => void;
  abstract get visibleSegmentEquivalencePolicy(): VisibleSegmentEquivalencePolicy;
  tabContents?(layer: SegmentationUserLayer, context: DependentViewContext, tab: SegmentationGraphSourceTab): HTMLDivElement;
}

export interface ComputedSplit {
  // New representative id of retained segment.  May be fake.
  includeRepresentative: Uint64;
  // Base segment ids in retained segment.
  includeBaseSegments: Uint64[];
  // New representative id of split-off segment.  May be fake.
  excludeRepresentative: Uint64;
  // Base segments in split-off segment.
  excludeBaseSegments: Uint64[];
}

export abstract class SegmentationGraphSourceConnection<
    SourceType extends SegmentationGraphSource = SegmentationGraphSource> extends RefCounted {
  constructor(public graph: SourceType, public segmentsState: VisibleSegmentsState) {
    super();
  }
  abstract computeSplit(include: Uint64, exclude: Uint64): ComputedSplit|undefined;

  createRenderLayers(
      chunkManager: ChunkManager,
      displayState: SegmentationDisplayState3D,
      localPosition: WatchableValueInterface<Float32Array>): RenderLayer[] {
    chunkManager;
    displayState;
    localPosition;
    return [];
  };
}

export function trackWatchableValueSegment(
    graph: SegmentationGraphSource,
    watchable: WatchableValueInterface<Uint64|undefined>): Disposer {
  let lastId: Uint64|null|undefined;
  let watchDisposer: undefined|(() => void) = undefined;
  const handleLocalChange = () => {
    const {value} = watchable;
    if (value === undefined) {
      if (watchDisposer !== undefined) {
        watchDisposer();
        watchDisposer = undefined;
        lastId = undefined;
      }
      return;
    }
    if (lastId != null && Uint64.equal(lastId, value)) {
      return;
    }
    if (watchDisposer !== undefined) {
      watchDisposer();
      watchDisposer = undefined;
      lastId = undefined;
    }
    watchDisposer = graph.trackSegment(value, newId => {
      lastId = newId;
      watchable.value = newId ?? undefined;
    });
  };
  handleLocalChange();
  const signalDisposer = watchable.changed.add(handleLocalChange);
  const disposer = () => {
    signalDisposer();
    if (watchDisposer !== undefined) {
      watchDisposer();
      watchDisposer = undefined;
    }
  };
  return disposer;
}

// Returns `true` if `segmentId` is a base segment id, rather than a segment id added to the graph.
export function isBaseSegmentId(segmentId: Uint64) {
  return (segmentId.high >>> 31) ? false : true;
}

export const UNKNOWN_NEW_SEGMENT_ID = new Uint64(0xffffffff, 0xffffffff);
