/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CHUNKED_GRAPH_LAYER_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification, CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID} from 'neuroglancer/sliceview/chunked_graph/base';
import {FrontendTransformedSource, getVolumetricTransformedSources, serializeAllTransformedSources, SliceViewChunkSource, SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {SliceViewPanelRenderLayer, SliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import { RefCounted } from 'neuroglancer/util/disposable';
import { LayerChunkProgressInfo } from 'neuroglancer/chunk_manager/base';
import { SegmentationDisplayState3D, SegmentationLayerSharedObject } from 'neuroglancer/segmentation_display_state/frontend';
import { LayerView, VisibleLayerInfo } from 'neuroglancer/layer';
import { ChunkTransformParameters, getChunkTransformParameters, RenderLayerTransformOrError } from 'neuroglancer/render_coordinate_transform';
import { DisplayDimensionRenderInfo } from 'neuroglancer/navigation_state';
import { makeValueOrError, ValueOrError, valueOrThrow } from 'neuroglancer/util/error';
import { makeCachedLazyDerivedWatchableValue, NestedStateManager, registerNested, WatchableValueInterface } from 'neuroglancer/trackable_value';
import { SharedWatchableValue } from 'neuroglancer/shared_watchable_value';
import { StatusMessage } from 'neuroglancer/status';

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

export const responseIdentity = async (x: any) => x;

export class ChunkedGraphChunkSource extends SliceViewChunkSource implements
    ChunkedGraphChunkSourceInterface {
  spec: ChunkedGraphChunkSpecification;
  OPTIONS: {spec: ChunkedGraphChunkSpecification};

  constructor(chunkManager: ChunkManager, options: {
    spec: ChunkedGraphChunkSpecification,
  }) {
    super(chunkManager, options);
  }
}

export interface ChunkedGraphLayerDisplayState extends SegmentationDisplayState3D {}

interface TransformedChunkedGraphSource extends
    FrontendTransformedSource<SliceViewRenderLayer, ChunkedGraphChunkSource> {}

interface AttachmentState {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  source?: NestedStateManager<TransformedChunkedGraphSource>;
}

export class SliceViewPanelChunkedGraphLayer extends SliceViewPanelRenderLayer {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  private sharedObject: SegmentationLayerSharedObject;
  readonly chunkTransform: WatchableValueInterface<ValueOrError<ChunkTransformParameters>>;

  private leafRequestsActive: SharedWatchableValue<boolean>;
  private leafRequestsStatusMessage: StatusMessage|undefined;

  constructor(public chunkManager: ChunkManager, public source: SliceViewSingleResolutionSource<ChunkedGraphChunkSource>,
      public displayState: ChunkedGraphLayerDisplayState,
      public localPosition: WatchableValueInterface<Float32Array>,
      nBitsForLayerId: number) {
    super();
    this.leafRequestsActive = this.registerDisposer(SharedWatchableValue.make(chunkManager.rpc!, true));
    this.chunkTransform = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
        modelTransform =>
            makeValueOrError(() => getChunkTransformParameters(valueOrThrow(modelTransform))),
        this.displayState.transform));
    let sharedObject = this.sharedObject = this.backend = this.registerDisposer(
        new SegmentationLayerSharedObject(chunkManager, displayState, this.layerChunkProgressInfo));
    sharedObject.RPC_TYPE_ID = CHUNKED_GRAPH_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      source: source.chunkSource.addCounterpartRef(),
      localPosition: this.registerDisposer(SharedWatchableValue.makeFromExisting(chunkManager.rpc!, this.localPosition))
                         .rpcId,
      leafRequestsActive: this.leafRequestsActive.rpcId,
      nBitsForLayerId: this.registerDisposer(SharedWatchableValue.make(chunkManager.rpc!, nBitsForLayerId)).rpcId,
    });
    this.registerDisposer(sharedObject.visibility.add(this.visibility));

    this.registerDisposer(this.leafRequestsActive.changed.add(() => {
      this.showOrHideMessage(this.leafRequestsActive.value);
    }));
  }

  attach(attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
    super.attach(attachment);
    const chunkTransform = this.chunkTransform.value;
    const displayDimensionRenderInfo = attachment.view.displayDimensionRenderInfo.value;
    attachment.state = {
      chunkTransform,
      displayDimensionRenderInfo,
    };
    attachment.state!.source = attachment.registerDisposer(registerNested(
        (context: RefCounted, transform: RenderLayerTransformOrError,
         displayDimensionRenderInfo: DisplayDimensionRenderInfo) => {
          const transformedSources =
              getVolumetricTransformedSources(
                  displayDimensionRenderInfo, transform,
                  _options =>
                      [[this.source]],
                  attachment.messages, this) as TransformedChunkedGraphSource[][];
          attachment.view.flushBackendProjectionParameters();
          this.sharedObject.rpc!.invoke(CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, {
            layer: this.sharedObject.rpcId,
            view: attachment.view.rpcId,
            displayDimensionRenderInfo,
            sources: serializeAllTransformedSources(transformedSources),
          });
          context;
          return transformedSources[0][0];
        },
        this.displayState.transform, attachment.view.displayDimensionRenderInfo));
  }

  isReady() {
    return true;
  }

  private showOrHideMessage(leafRequestsActive: boolean) {
    if (this.leafRequestsStatusMessage && leafRequestsActive) {
      this.leafRequestsStatusMessage.dispose();
      this.leafRequestsStatusMessage = undefined;
      StatusMessage.showTemporaryMessage('Loading chunked graph segmentation...', 3000);
    } else if ((!this.leafRequestsStatusMessage) && (!leafRequestsActive)) {
      this.leafRequestsStatusMessage = StatusMessage.showMessage(
          'At this zoom level, chunked graph segmentation will not be loaded. Please zoom in if you wish to load it.');
    }
  }
}
