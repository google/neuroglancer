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

import {authFetch} from 'neuroglancer/authentication/frontend.ts';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {CHUNKED_GRAPH_LAYER_RPC_ID, CHUNKED_GRAPH_SOURCE_UPDATE_ROOT_SEGMENTS_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification, RENDER_RATIO_LIMIT} from 'neuroglancer/sliceview/chunked_graph/base';
import {SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {RenderLayer as GenericSliceViewRenderLayer, RenderLayerOptions} from 'neuroglancer/sliceview/renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {vec3} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {RPC} from 'neuroglancer/worker_rpc';

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

export interface SegmentSelection {
  segmentId: Uint64;
  rootId: Uint64;
  position: vec3;
}

export class ChunkedGraphChunkSource extends SliceViewChunkSource implements
    ChunkedGraphChunkSourceInterface {
  rootSegments: Uint64Set;
  spec: ChunkedGraphChunkSpecification;

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

export class ChunkedGraphLayer extends GenericSliceViewRenderLayer {
  private graphurl: string;
  private leafRequestsStatusMessage: StatusMessage|undefined;
  leafRequestsActive = new TrackableBoolean(true, true);

  constructor(
      chunkManager: ChunkManager, url: string, public sources: ChunkedGraphChunkSource[][],
      displayState: VisibleSegmentsState&RenderLayerOptions) {
    super(chunkManager, sources, {
      rpcTransfer: {
        'chunkManager': chunkManager.rpcId,
        'url': url,
        'rootSegments': displayState.rootSegments.rpcId,
        'visibleSegments3D': displayState.visibleSegments3D.rpcId,
        'segmentEquivalences': displayState.segmentEquivalences.rpcId,
      },
      rpcType: CHUNKED_GRAPH_LAYER_RPC_ID,
      transform: displayState.transform,
    });
    this.registerDisposer(this.leafRequestsActive.changed.add(() => {
      this.showOrHideMessage(this.leafRequestsActive.value);
    }));
    this.graphurl = url;
  }

  get url() {
    return this.graphurl;
  }

  get renderRatioLimit() {
    return RENDER_RATIO_LIMIT;
  }

  async getRoot(selection: SegmentSelection, timestamp?: string): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.resolve(selection.segmentId);
    }

    const promise = authFetch(`${url}/graph/${String(selection.segmentId)}/root${
        timestamp ? `?timestamp=${timestamp}` : ``}`);

    const response = await this.withErrorMessage(promise, {
      initialMessage: `Retrieving root for segment ${selection.segmentId}`,
      errorPrefix: `Could not fetch root: `
    });
    const uint32 = new Uint32Array(await response.arrayBuffer());
    return new Uint64(uint32[0], uint32[1]);
  }

  async mergeSegments(first: SegmentSelection, second: SegmentSelection): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = authFetch(`${url}/graph/merge`, {
      method: 'POST',
      body: JSON.stringify([
        [String(first.segmentId), ...first.position.values()],
        [String(second.segmentId), ...second.position.values()]
      ])
    });

    const response = await this.withErrorMessage(promise, {
      initialMessage: `Merging ${first.segmentId} and ${second.segmentId}`,
      errorPrefix: 'Merge failed: '
    });
    const uint32 = new Uint32Array(await response.arrayBuffer());
    return new Uint64(uint32[0], uint32[1]);
  }

  async splitSegments(first: SegmentSelection[], second: SegmentSelection[]): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = authFetch(`${url}/graph/split`, {
      method: 'POST',
      body: JSON.stringify({
        'sources': first.map(x => [String(x.segmentId), ...x.position.values()]),
        'sinks': second.map(x => [String(x.segmentId), ...x.position.values()])
      })
    });

    const response = await this.withErrorMessage(promise, {
      initialMessage: `Splitting ${first.length} sinks from ${second.length} sources`,
      errorPrefix: 'Split failed: '
    });
    const uint32 = new Uint32Array(await response.arrayBuffer());
    const final: Uint64[] = new Array(uint32.length / 2);
    for (let i = 0; i < uint32.length / 2; i++) {
      final[i] = new Uint64(uint32[2 * i], uint32[2 * i + 1]);
    }
    return final;
  }

  draw() {}

  async withErrorMessage(promise: Promise<Response>, options: {
    initialMessage: string,
    errorPrefix: string
  }): Promise<Response> {
    const status = new StatusMessage(true);
    status.setText(options.initialMessage);
    const dispose = status.dispose.bind(status);
    const response = await promise;
    if (response.ok) {
      dispose();
      return response;
    } else {
      let msg: string;
      try {
        msg = (await response.json())['message'];
      } catch {
        msg = await response.text();
      }
      const {errorPrefix = ''} = options;
      status.setErrorMessage(errorPrefix + msg);
      status.setVisible(true);
      throw new Error(`[${response.status}] ${errorPrefix}${msg}`);
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
