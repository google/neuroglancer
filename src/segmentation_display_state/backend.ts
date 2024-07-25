/**
 * @license
 * Copyright 2016 Google Inc.
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

// Import to register the shared object types.
import "#src/shared_disjoint_sets.js";
import "#src/uint64_map.js";
import "#src/uint64_set.js";

import type { ChunkRequester } from "#src/chunk_manager/backend.js";
import { ChunkSource } from "#src/chunk_manager/backend.js";
import type { RenderLayerTransformOrError } from "#src/render_coordinate_transform.js";
import type {
  IndexedSegmentProperty,
  VisibleSegmentsState,
} from "#src/segmentation_display_state/base.js";
import {
  VISIBLE_SEGMENTS_STATE_PROPERTIES,
  onTemporaryVisibleSegmentsStateChanged,
  onVisibleSegmentsStateChanged,
} from "#src/segmentation_display_state/base.js";
import type { SharedDisjointUint64Sets } from "#src/shared_disjoint_sets.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { WatchableValue } from "#src/trackable_value.js";
import type { Uint64OrderedSet } from "#src/uint64_ordered_set.js";
import type { Uint64Set } from "#src/uint64_set.js";
import type { AnyConstructor } from "#src/util/mixin.js";
import type { RPC } from "#src/worker_rpc.js";

export function receiveVisibleSegmentsState(
  rpc: RPC,
  options: any,
  target: VisibleSegmentsState = {} as VisibleSegmentsState,
): VisibleSegmentsState {
  // No need to increase the reference count of these properties since our owner will hold a
  // reference to their owners.
  for (const property of VISIBLE_SEGMENTS_STATE_PROPERTIES) {
    target[property] = rpc.get(options[property]);
  }
  return target;
}

export const withSegmentationLayerBackendState = <
  TBase extends AnyConstructor<ChunkRequester>,
>(
  Base: TBase,
) =>
  class SegmentationLayerState extends Base implements VisibleSegmentsState {
    timestamp: WatchableValue<number | undefined>;
    visibleSegments: Uint64Set;
    selectedSegments: Uint64OrderedSet;
    segmentEquivalences: SharedDisjointUint64Sets;
    temporaryVisibleSegments: Uint64Set;
    temporarySegmentEquivalences: SharedDisjointUint64Sets;
    useTemporaryVisibleSegments: SharedWatchableValue<boolean>;
    useTemporarySegmentEquivalences: SharedWatchableValue<boolean>;
    transform: SharedWatchableValue<RenderLayerTransformOrError>;
    renderScaleTarget: SharedWatchableValue<number>;
    constructor(...args: any[]) {
      const [rpc, options] = args as [RPC, any];
      super(rpc, options);
      receiveVisibleSegmentsState(rpc, options, this);
      this.transform = rpc.get(options.transform);
      this.renderScaleTarget = rpc.get(options.renderScaleTarget);

      const scheduleUpdateChunkPriorities = () => {
        this.chunkManager.scheduleUpdateChunkPriorities();
      };
      onTemporaryVisibleSegmentsStateChanged(
        this,
        this,
        scheduleUpdateChunkPriorities,
      );
      onVisibleSegmentsStateChanged(this, this, scheduleUpdateChunkPriorities);
      this.registerDisposer(
        this.transform.changed.add(scheduleUpdateChunkPriorities),
      );
      this.registerDisposer(
        this.renderScaleTarget.changed.add(scheduleUpdateChunkPriorities),
      );
    }
  };

export class IndexedSegmentPropertySourceBackend extends ChunkSource {
  properties: readonly Readonly<IndexedSegmentProperty>[];
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.properties = options.properties;
  }
}
