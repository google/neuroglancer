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

/**
 * @file Reports which spatial skeleton edit actions the active source of a
 * segmentation layer allows. Applies the hints of an adopted preview to the
 * segments and the selection of the layer.
 */

import type { SkeletonNodeSelection } from "#src/layer/segmentation/skeleton_node_selection.js";
import type { SegmentationGroupState } from "#src/segmentation_display_state/frontend.js";
import type {
  SpatialSkeletonLayerContext,
  SpatialSkeletonEditSession,
} from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  ensureSpatialSkeletonEditQueue,
  editableSpatiallyIndexedSkeletonSourceSupportsAction,
} from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import type { SpatialSkeletonAction } from "#src/skeleton/edit_commands.js";
import {
  DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS,
  getSpatialSkeletonActionSupportLabel,
  isSpatialSkeletonEditAction,
  SpatialSkeletonActions,
} from "#src/skeleton/edit_commands.js";
import type { SpatialSkeletonResolvedPreviewUiHints } from "#src/skeleton/edit_queue/preview_ui_hints.js";
import { SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON } from "#src/skeleton/edit_queue/types.js";
import type { SkeletonFindPathState } from "#src/skeleton/find_path/find_path.js";
import type { SpatialSkeletonFindPathAnnotationController } from "#src/skeleton/find_path/find_path_attachment.js";
import type { SkeletonNodeAccess } from "#src/skeleton/skeleton_navigator.js";
import type { MultiscaleSpatiallyIndexedSkeletonSource } from "#src/skeleton/spatial/frontend.js";
import type { SkeletonOverlaySegments } from "#src/skeleton/spatial/overlay_segments.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { RefCounted } from "#src/util/disposable.js";

function remapSegmentSet(
  set: Pick<Uint64Set, "add" | "delete" | "has">,
  remappings: ReadonlyMap<bigint, bigint>,
) {
  const presentTargets = new Set<bigint>();
  for (const [from, to] of remappings) {
    if (from !== to && set.has(from)) presentTargets.add(to);
  }
  for (const [from, to] of remappings) {
    if (from !== to) set.delete(from);
  }
  for (const target of presentTargets) set.add(target);
}

export interface SpatialSkeletonFindPathContext {
  readonly skeletonLayer: SpatiallyIndexedSkeletonLayer;
  readonly state: SkeletonFindPathState;
  readonly annotationController: SpatialSkeletonFindPathAnnotationController;
}

export interface SkeletonSourceConnectionOptions {
  readonly spatialSkeletonEditSession: SpatialSkeletonEditSession;
  readonly selection: SkeletonNodeSelection;
  readonly overlaySegments: SkeletonOverlaySegments;
  readonly segmentationGroupState: WatchableValueInterface<SegmentationGroupState>;
  readonly skeletonNodeAccess: WatchableValueInterface<
    SkeletonNodeAccess | undefined
  >;
  readonly spatiallyIndexedSkeletonLayer: WatchableValueInterface<
    SpatiallyIndexedSkeletonLayer | undefined
  >;
}

export class SkeletonSourceConnection
  extends RefCounted
  implements SpatialSkeletonLayerContext
{
  private activeSource: MultiscaleSpatiallyIndexedSkeletonSource | undefined;
  private findPathContext: SpatialSkeletonFindPathContext | undefined;

  constructor(private readonly options: SkeletonSourceConnectionOptions) {
    super();
  }

  get spatialSkeletonEditSession() {
    return this.options.spatialSkeletonEditSession;
  }

  getSpatiallyIndexedSkeletonLayer() {
    return this.options.spatiallyIndexedSkeletonLayer.value;
  }

  getActionsDisabledReason(
    requiredActions:
      | SpatialSkeletonAction
      | readonly SpatialSkeletonAction[] = DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS,
  ): string | undefined {
    const requirements: readonly SpatialSkeletonAction[] = Array.isArray(
      requiredActions,
    )
      ? requiredActions
      : [requiredActions as SpatialSkeletonAction];
    if (
      requirements.some((action) => isSpatialSkeletonEditAction(action)) &&
      this.spatialSkeletonEditSession.getReloadRequired() !== undefined
    ) {
      return SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON;
    }
    const skeletonLayer = this.getSpatiallyIndexedSkeletonLayer();
    if (
      skeletonLayer !== undefined &&
      skeletonLayer.editableSource === undefined &&
      requirements.some((action) => action !== SpatialSkeletonActions.inspect)
    ) {
      return "The active spatial skeleton source is read-only.";
    }
    const missingRequirements = requirements.filter(
      (action) => !this.supportsAction(action),
    );
    if (missingRequirements.length === 0) return undefined;
    const names = missingRequirements.map(getSpatialSkeletonActionSupportLabel);
    return `The active spatial skeleton source does not support ${names.join(", ")}.`;
  }

  sourceChanged(
    source: MultiscaleSpatiallyIndexedSkeletonSource | undefined,
  ): void {
    const previousSource = this.activeSource;
    this.activeSource = source;
    if (previousSource !== undefined && previousSource !== source) {
      this.spatialSkeletonEditSession.clearRuntimeState();
      this.options.overlaySegments.clear();
    }
  }

  attachFindPath(
    context: SpatialSkeletonFindPathContext,
    lifetime: RefCounted,
  ): void {
    this.findPathContext = context;
    lifetime.registerDisposer(
      this.spatialSkeletonEditSession.nodeDataVersion.changed.add(() => {
        // Invalidate before the active tool recomputes the path.
        if (this.spatialSkeletonEditSession.hasUnconfirmedEdits()) {
          context.state.invalidateResult();
        }
      }),
    );
    lifetime.registerDisposer(() => {
      if (this.findPathContext === context) {
        this.findPathContext = undefined;
      }
    });
  }

  getFindPathContext(): SpatialSkeletonFindPathContext | undefined {
    return this.findPathContext;
  }

  applySpatialSkeletonPreviewUiHints(
    hints: SpatialSkeletonResolvedPreviewUiHints,
  ): void {
    this.spatialSkeletonEditSession.remapPendingNodePositions(
      hints.nodeIdRemappings,
    );
    const group = this.options.segmentationGroupState.value;
    for (const set of [
      group.visibleSegments,
      group.temporaryVisibleSegments,
      group.selectedSegments,
    ]) {
      remapSegmentSet(set, hints.segmentIdRemappings);
    }
    for (const visibility of hints.segmentVisibility) {
      const { segmentId } = visibility;
      if (visibility.visible) {
        group.visibleSegments.add(segmentId);
        group.temporaryVisibleSegments.add(segmentId);
      } else {
        group.visibleSegments.delete(segmentId);
        group.temporaryVisibleSegments.delete(segmentId);
        if (visibility.deselect) {
          group.selectedSegments.delete(segmentId);
        }
      }
    }
    this.options.selection.applyPreviewUiHints(hints);
    const { overlaySegments } = this.options;
    if (hints.segmentIdRemappings.size !== 0) {
      // Copied so that the layer cannot change the preview's publication.
      overlaySegments.remap(new Map(hints.segmentIdRemappings));
    }
    for (const segmentId of hints.retainSegmentIds) {
      overlaySegments.retain(segmentId);
    }
  }

  private supportsAction(action: SpatialSkeletonAction) {
    if (action === SpatialSkeletonActions.inspect) {
      return this.options.skeletonNodeAccess.value !== undefined;
    }
    const source = this.getSpatiallyIndexedSkeletonLayer()?.editableSource;
    if (source === undefined) return false;
    try {
      ensureSpatialSkeletonEditQueue(this, source);
    } catch {
      // A writable source with an invalid driver contract is inspect-only.
      return false;
    }
    return editableSpatiallyIndexedSkeletonSourceSupportsAction(source, action);
  }
}
