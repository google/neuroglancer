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
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { RenderLayer } from "#src/renderlayer.js";
import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import type { SegmentationDisplayState3D } from "#src/segmentation_display_state/frontend.js";
import type { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { Disposer, Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { Uint64 } from "#src/util/uint64.js";
import type { DependentViewContext } from "#src/widget/dependent_view_widget.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { Tab } from "#src/widget/tab_view.js";

export class SegmentationGraphSourceTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const { element } = this;
    element.appendChild(
      this.registerDisposer(
        new DependentViewWidget(
          layer.displayState.segmentationGroupState.value.graph,
          (graph, parent, context) => {
            if (graph?.tabContents) {
              parent.appendChild(graph.tabContents(layer, context, this));
            }
          },
        ),
      ).element,
    );
  }
}

export abstract class SegmentationGraphSource {
  abstract connect(
    layer: SegmentationUserLayer,
  ): Owned<SegmentationGraphSourceConnection>;
  abstract merge(a: Uint64, b: Uint64): Promise<Uint64>;
  abstract split(
    include: Uint64,
    exclude: Uint64,
  ): Promise<{ include: Uint64; exclude: Uint64 }>;
  abstract trackSegment(
    id: Uint64,
    callback: (id: Uint64 | null) => void,
  ): () => void;
  abstract get visibleSegmentEquivalencePolicy(): VisibleSegmentEquivalencePolicy;
  tabContents?(
    layer: SegmentationUserLayer,
    context: DependentViewContext,
    tab: SegmentationGraphSourceTab,
  ): HTMLDivElement;
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
  SourceType extends SegmentationGraphSource = SegmentationGraphSource,
> extends RefCounted {
  constructor(
    public graph: SourceType,
    public segmentsState: VisibleSegmentsState,
  ) {
    super();
  }
  abstract computeSplit(
    include: Uint64,
    exclude: Uint64,
  ): ComputedSplit | undefined;

  createRenderLayers(
    chunkManager: ChunkManager,
    displayState: SegmentationDisplayState3D,
    localPosition: WatchableValueInterface<Float32Array>,
  ): RenderLayer[] {
    chunkManager;
    displayState;
    localPosition;
    return [];
  }
}

export function trackWatchableValueSegment(
  graph: SegmentationGraphSource,
  watchable: WatchableValueInterface<Uint64 | undefined>,
): Disposer {
  let lastId: Uint64 | null | undefined;
  let watchDisposer: undefined | (() => void) = undefined;
  const handleLocalChange = () => {
    const { value } = watchable;
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
    watchDisposer = graph.trackSegment(value, (newId) => {
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
