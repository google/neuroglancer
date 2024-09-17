/**
 * @license
 * Copyright 2024 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use viewer file except in compliance with the License.
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

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { MultiscaleMeshLayer } from "#src/mesh/frontend.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import type { Viewer } from "#src/viewer.js";
import { VolumeRenderingRenderLayer } from "#src/volume_rendering/volume_render_layer.js";

export function getViewerResolutionState(viewer: Viewer) {
  const layers = viewer.layerManager.visibleRenderLayers;
  const map = new Map();
  for (const layer of layers) {
    if (layer.role === RenderLayerRole.DATA) {
      const layer_name = layer.userLayer!.managedLayer.name;
      if (layer instanceof ImageRenderLayer) {
        const type = "ImageRenderLayer";
        const sliceResolution = layer.renderScaleTarget.value;
        map.set([layer_name, type], { sliceResolution });
      } else if (layer instanceof VolumeRenderingRenderLayer) {
        const type = "VolumeRenderingRenderLayer";
        const volumeResolution = layer.depthSamplesTarget.value;
        const physicalSpacing = layer.physicalSpacing;
        const resolutionIndex = layer.selectedDataResolution;
        map.set([layer_name, type], {
          volumeResolution,
          physicalSpacing,
          resolutionIndex,
        });
      } else if (layer instanceof SegmentationRenderLayer) {
        const type = "SegmentationRenderLayer";
        const segmentationResolution = layer.renderScaleTarget.value;
        map.set([layer_name, type], {
          sliceResolution: segmentationResolution,
        });
      } else if (layer instanceof MultiscaleMeshLayer) {
        const type = "MultiscaleMeshLayer";
        const userLayer = layer.userLayer as SegmentationUserLayer;
        const meshResolution = userLayer.displayState.renderScaleTarget.value;
        map.set([layer_name, type], { meshResolution });
      }
    }
  }
  return map;
}
