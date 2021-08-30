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
import {VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {CHUNKED_GRAPH_LAYER_RPC_ID, CHUNKED_GRAPH_SOURCE_UPDATE_ROOT_SEGMENTS_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification, RENDER_RATIO_LIMIT} from 'neuroglancer/sliceview/chunked_graph/base';
import {SliceViewChunkSource, SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {SliceViewRenderLayer, SliceViewRenderLayerOptions} from 'neuroglancer/sliceview/renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {RPC} from 'neuroglancer/worker_rpc';
import {SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {HttpError} from 'neuroglancer/util/http_request';

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

export const responseIdentity = async (x: any) => x;

export class ChunkedGraphChunkSource extends SliceViewChunkSource implements
    ChunkedGraphChunkSourceInterface {
  rootSegments: Uint64Set;
  spec: ChunkedGraphChunkSpecification;
  OPTIONS: {rootSegments: Uint64Set, spec: ChunkedGraphChunkSpecification};

  constructor(chunkManager: ChunkManager, options: {
    spec: ChunkedGraphChunkSpecification,
    rootSegments: Uint64Set
  }) {
    super(chunkManager, options);
    this.rootSegments = options.rootSegments;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['rootSegments'] = this.rootSegments.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  updateRootSegments(rpc: RPC, rootSegments: Uint64Set) {
    this.rootSegments = rootSegments;
    rpc.invoke(
        CHUNKED_GRAPH_SOURCE_UPDATE_ROOT_SEGMENTS_RPC_ID,
        {'id': this.rpcId, 'rootSegments': this.rootSegments.rpcId});
  }
}

export class ChunkedGraphLayer extends SliceViewRenderLayer {
  private graphurl: string;
  private leafRequestsStatusMessage: StatusMessage|undefined;
  leafRequestsActive = new TrackableBoolean(true, true);

  constructor(
      url: string,
      public sources: SliceViewSingleResolutionSource<ChunkedGraphChunkSource>[][],
      multiscaleSource: MultiscaleVolumeChunkSource,
      displayState: VisibleSegmentsState&SliceViewRenderLayerOptions) {
    super(multiscaleSource.chunkManager, multiscaleSource, {
      rpcTransfer: {
        'chunkManager': multiscaleSource.chunkManager.rpcId,
        'url': url,
        'visibleSegments': displayState.visibleSegments.rpcId,
        'segmentEquivalences': displayState.segmentEquivalences.rpcId,
      },
      transform: displayState.transform,
      localPosition: displayState.localPosition,
    });
    this.registerDisposer(this.leafRequestsActive.changed.add(() => {
      this.showOrHideMessage(this.leafRequestsActive.value);
    }));
    this.graphurl = url;
    this.initializeCounterpart();
  }

  getSources(_options: SliceViewSourceOptions) { // do we need to override this?
    return this.sources;
  }

  get url() {
    return this.graphurl;
  }

  get renderRatioLimit() {
    return RENDER_RATIO_LIMIT;
  }

  draw() {}

  async withErrorMessage(promise: Promise<Response>, options: {
    initialMessage: string,
    errorPrefix: string
  }): Promise<Response> {
    const status = new StatusMessage(true);
    status.setText(options.initialMessage);
    const dispose = status.dispose.bind(status);
    try {
      const response = await promise;
      dispose();
      return response;
    } catch (e) {
      if (e instanceof HttpError && e.response) {
        let msg: string;
        if (e.response.headers.get('content-type') === 'application/json') {
          msg = (await e.response.json())['message'];
        } else {
          msg = await e.response.text();
        }

        const {errorPrefix = ''} = options;
        status.setErrorMessage(errorPrefix + msg);
        status.setVisible(true);
        throw new Error(`[${e.response.status}] ${errorPrefix}${msg}`);
      }
      throw e;
    }
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

ChunkedGraphLayer.prototype.RPC_TYPE_ID = CHUNKED_GRAPH_LAYER_RPC_ID;
