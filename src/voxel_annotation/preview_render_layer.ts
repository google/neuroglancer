/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { SliceViewBase, TransformedSource } from "#src/sliceview/base.js";
import { forEachPlaneIntersectingVolumetricChunk } from "#src/sliceview/base.js";
import type { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type {
  FrontendTransformedSource,
  SliceView,
  SliceViewChunk,
} from "#src/sliceview/frontend.js";
import type { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";

function* chunkGridPositions(chunks: Iterable<SliceViewChunk>) {
  for (const chunk of chunks) {
    yield chunk.chunkGridPosition;
  }
}

/**
 * Turns a volume render layer class into the render layer of the voxel
 * editing preview, which draws the in-memory edits not yet written.
 */
export function VoxelEditingPreviewRenderLayerMixin<
  TBase extends { new (...args: any[]): SliceViewRenderLayer },
>(Base: TBase) {
  abstract class C extends Base {
    // Edits are only made at the finest scale, whatever the zoom.
    filterVisibleSources(
      _sliceView: SliceViewBase,
      sources: readonly TransformedSource[],
    ): Iterable<TransformedSource> {
      return sources.slice(0, 1);
    }

    // The preview source only holds the chunks being edited: visit those
    // instead of walking the whole finest-scale grid under the viewport.
    forEachVisibleChunk(
      sliceView: SliceView,
      tsource: FrontendTransformedSource,
      chunkLayout: ChunkLayout,
      callback: (key: string) => void,
    ) {
      forEachPlaneIntersectingVolumetricChunk(
        sliceView.projectionParameters.value,
        this.localPosition.value,
        tsource,
        chunkLayout,
        () => {
          callback(tsource.curPositionInChunks.join());
        },
        chunkGridPositions(tsource.source.chunks.values()),
      );
    }
  }
  return C;
}
