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

import {withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {DisplayDimensionRenderInfo} from 'neuroglancer/navigation_state';
import {RenderedViewBackend, RenderLayerBackend, RenderLayerBackendAttachment} from 'neuroglancer/render_layer_backend';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {BASE_PRIORITY, deserializeTransformedSources, SCALE_PRIORITY_MULTIPLIER} from 'neuroglancer/sliceview/backend';
import {TransformedSource} from 'neuroglancer/sliceview/base';
import {VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {vec3} from 'neuroglancer/util/geom';
import {getBasePriority, getPriorityTier} from 'neuroglancer/visibility_priority/backend';
import {forEachVisibleVolumeRenderingChunk, VOLUME_RENDERING_RENDER_LAYER_RPC_ID, VOLUME_RENDERING_RENDER_LAYER_UPDATE_SOURCES_RPC_ID} from 'neuroglancer/volume_rendering/base';
import {registerRPC, registerSharedObject, RPC} from 'neuroglancer/worker_rpc';

interface VolumeRenderingRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSources: TransformedSource<VolumeRenderingRenderLayerBackend, VolumeChunkSource>[][];
}

const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();
const tempCenterDataPosition = vec3.create();

@registerSharedObject(VOLUME_RENDERING_RENDER_LAYER_RPC_ID)
class VolumeRenderingRenderLayerBackend extends withChunkManager
(RenderLayerBackend) {
  localPosition: SharedWatchableValue<Float32Array>;
  renderScaleTarget: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
    this.localPosition = rpc.get(options.localPosition);
    const scheduleUpdateChunkPriorities = () => this.chunkManager.scheduleUpdateChunkPriorities();
    this.registerDisposer(this.localPosition.changed.add(scheduleUpdateChunkPriorities));
    this.registerDisposer(this.renderScaleTarget.changed.add(scheduleUpdateChunkPriorities));
    this.registerDisposer(
        this.chunkManager.recomputeChunkPriorities.add(() => this.recomputeChunkPriorities()));
  }

  attach(attachment: RenderLayerBackendAttachment<
         RenderedViewBackend, VolumeRenderingRenderLayerAttachmentState>) {
    const scheduleUpdateChunkPriorities = () => this.chunkManager.scheduleUpdateChunkPriorities();
    const {view} = attachment;
    attachment.registerDisposer(scheduleUpdateChunkPriorities);
    attachment.registerDisposer(
        view.projectionParameters.changed.add(scheduleUpdateChunkPriorities));
    attachment.registerDisposer(view.visibility.changed.add(scheduleUpdateChunkPriorities));
    attachment.state = {
      displayDimensionRenderInfo: view.projectionParameters.value.displayDimensionRenderInfo,
      transformedSources: [],
    };
  }

  private recomputeChunkPriorities() {
    for (const attachment of this.attachments.values()) {
      const {view} = attachment;
      const visibility = view.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) {
        continue;
      }
      const {transformedSources, displayDimensionRenderInfo} =
          attachment.state as VolumeRenderingRenderLayerAttachmentState;
      if (transformedSources.length === 0 ||
          displayDimensionRenderInfo !==
              view.projectionParameters.value.displayDimensionRenderInfo) {
        continue;
      }

      const projectionParameters = view.projectionParameters.value;
      const priorityTier = getPriorityTier(visibility);
      let basePriority = getBasePriority(visibility);
      basePriority += BASE_PRIORITY;
      const localCenter = tempCenter;
      const chunkSize = tempChunkSize;
      const centerDataPosition = tempCenterDataPosition;
      const {globalPosition, displayDimensionRenderInfo: {displayDimensionIndices}} =
          projectionParameters;
      for (let displayDim = 0; displayDim < 3; ++displayDim) {
        const globalDim = displayDimensionIndices[displayDim];
        centerDataPosition[displayDim] = globalDim === -1 ? 0 : globalPosition[globalDim];
      }
      let sourceBasePriority: number;
      const {chunkManager} = this;
      chunkManager.registerLayer(this);
      forEachVisibleVolumeRenderingChunk(
          projectionParameters, this.localPosition.value, this.renderScaleTarget.value,
          transformedSources[0],
          (tsource, scaleIndex) => {
            const {chunkLayout} = tsource;
            for (let i = 0; i < 3; ++i) {
            }
            chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);
            const {size, finiteRank} = chunkLayout;
            vec3.copy(chunkSize, size);
            for (let i = finiteRank; i < 3; ++i) {
              chunkSize[i] = 0;
              localCenter[i] = 0;
            }
            const priorityIndex = transformedSources[0].length - 1 - scaleIndex;
            sourceBasePriority = basePriority + SCALE_PRIORITY_MULTIPLIER * priorityIndex;
          },
          (tsource, _, positionInChunks) => {
            vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
            const priority = -vec3.distance(localCenter, tempChunkPosition);
            const chunk = tsource.source.getChunk(tsource.curPositionInChunks);
            ++this.numVisibleChunksNeeded;
            chunkManager.requestChunk(chunk, priorityTier, sourceBasePriority + priority);
            if (chunk.state === ChunkState.GPU_MEMORY) {
              ++this.numVisibleChunksAvailable;
            }
          });
    }
  }
}
VolumeRenderingRenderLayerBackend;

registerRPC(VOLUME_RENDERING_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, function(x) {
  const view = this.get(x.view) as RenderedViewBackend;
  const layer = this.get(x.layer) as VolumeRenderingRenderLayerBackend;
  const attachment = layer.attachments.get(view)! as
      RenderLayerBackendAttachment<RenderedViewBackend, VolumeRenderingRenderLayerAttachmentState>;
  attachment.state!.transformedSources =
      deserializeTransformedSources<VolumeChunkSource, VolumeRenderingRenderLayerBackend>(
          this, x.sources, layer);
  attachment.state!.displayDimensionRenderInfo =
      attachment.view.projectionParameters.value.displayDimensionRenderInfo;
  layer.chunkManager.scheduleUpdateChunkPriorities();
});
