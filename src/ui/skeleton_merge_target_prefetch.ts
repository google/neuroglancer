/**
 * @license
 * Copyright 2026 Google Inc.
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

import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/frontend.js";
import type {
  SpatialSkeletonInputReference,
  SpatialSkeletonState,
} from "#src/skeleton/spatial_skeleton_manager.js";

type MergeTargetLoad =
  | { readonly kind: "loading"; readonly requestOwner: object }
  | {
      readonly kind: "loaded";
      readonly inputReference: SpatialSkeletonInputReference;
    }
  | { readonly kind: "failed" };

/**
 * Loads a merge target's complete skeleton before the pick that merges into it,
 * and keeps the loaded snapshot protected from eviction while it is the target.
 *
 * A failed load is not retried until the target changes. A replaced snapshot
 * is loaded and protected again on the next `setTarget` for the same segment.
 */
export class SpatialSkeletonMergeTargetPrefetch {
  private target:
    | { readonly segmentId: number; readonly load: MergeTargetLoad }
    | undefined = undefined;

  constructor(private readonly state: SpatialSkeletonState) {}

  setTarget(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentId: number,
  ): void {
    const { target } = this;
    if (
      target?.segmentId === segmentId &&
      !(
        target.load.kind === "loaded" && !target.load.inputReference.isCurrent()
      )
    ) {
      return;
    }
    this.clear();
    // A pick update can run immediately before rendering evicts cached nodes.
    // Protect a cached target now rather than in a later promise callback.
    const inputReference = this.state.tryAcquireInputReference({ segmentId });
    if (inputReference !== undefined) {
      this.target = {
        segmentId,
        load: { kind: "loaded", inputReference },
      };
      return;
    }
    const requestOwner = {};
    const load: MergeTargetLoad = { kind: "loading", requestOwner };
    this.target = { segmentId, load };
    const finishLoad = (succeeded: boolean) => {
      if (this.target?.load !== load) return;
      this.state.releaseFullSegmentNodeFetchOwner(requestOwner);
      const inputReference = succeeded
        ? this.state.tryAcquireInputReference({ segmentId })
        : undefined;
      this.target = {
        segmentId,
        load:
          inputReference === undefined
            ? { kind: "failed" }
            : { kind: "loaded", inputReference },
      };
    };
    void this.state
      .getFullSegmentNodes(skeletonLayer, segmentId, {
        retainWhileInactive: true,
        requestOwner,
      })
      .then(
        () => finishLoad(true),
        () => finishLoad(false),
      );
  }

  clear(): void {
    const load = this.target?.load;
    this.target = undefined;
    if (load?.kind === "loading") {
      this.state.releaseFullSegmentNodeFetchOwner(load.requestOwner);
    } else if (load?.kind === "loaded") {
      load.inputReference.release();
    }
  }
}
