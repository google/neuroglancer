/**
 * @license
 * Copyright 2024 Google Inc.
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

import type { BrushHashTable } from "#src/brush_stroke/index.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import { RefCounted } from "#src/util/disposable.js";

/**
 * Holds a segmentation layer's optimistic brush/erase voxels.
 *
 * These voxels are *rendered* elsewhere, straight from this object's
 * `brushHashTable`:
 *   - 2D slice views: the canonical SegmentationRenderLayer's brush hijack
 *     (sliceview/volume/segmentation_renderlayer.ts) routes painted voxels
 *     through its own shader, so they inherit the layer opacity and the
 *     focused-instance highlight and stay in lock-step with disk data.
 *   - 3D: the perspective panel reads this object directly
 *     (perspective_view/panel.ts → SliceViewRenderHelper.bindBrushResources).
 *
 * So this is purely the shared data holder; it has no render layer of its own.
 * Repaints are driven by `brushHashTable.changed`, which the canonical
 * SegmentationRenderLayer subscribes to — edit tools just mutate the table.
 */
export class BrushStrokeLayer extends RefCounted {
  constructor(
    public brushHashTable: BrushHashTable,
    public displayState: SegmentationDisplayState,
  ) {
    super();
  }
}
