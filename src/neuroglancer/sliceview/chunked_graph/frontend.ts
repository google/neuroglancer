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
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {CHUNKED_GRAPH_LAYER_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification} from 'neuroglancer/sliceview/chunked_graph/base';
import {SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {RenderLayer as GenericSliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {openHttpRequest, sendHttpJsonPostRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {RPC} from 'neuroglancer/worker_rpc';

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

export interface SegmentSelection {
  segmentId: Uint64;
  rootId: Uint64;
  position: number[];
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
}

export class ChunkedGraphLayer extends GenericSliceViewRenderLayer {
  private graphurl: string;

  constructor(
      chunkManager: ChunkManager, url: string, public sources: ChunkedGraphChunkSource[][],
      displayState: SegmentationDisplayState) {
    super(chunkManager, sources, {
      rpcTransfer: {
        'chunkManager': chunkManager.rpcId,
        'url': url,
        'rootSegments': displayState.rootSegments.rpcId,
        'visibleSegments3D': displayState.visibleSegments3D.rpcId,
        'segmentEquivalences': displayState.segmentEquivalences.rpcId
      },
      rpcType: CHUNKED_GRAPH_LAYER_RPC_ID
    });
    this.graphurl = url;
  }

  get url() {
    return this.graphurl;
  }

  getRoot(selection: SegmentSelection): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.resolve(selection.segmentId);
    }

    let promise = sendHttpRequest(
        openHttpRequest(`${url}/graph/${String(selection.segmentId)}/root`, 'GET'), 'arraybuffer');

    return this
        .withErrorMessage(promise, {
          initialMessage: `Retrieving root for segment ${selection.segmentId}`,
          errorPrefix: `Could not fetch root: `
        })
        .then(response => {
          let uint32 = new Uint32Array(response);
          return new Uint64(uint32[0], uint32[1]);
        });
  }

  mergeSegments(first: SegmentSelection, second: SegmentSelection): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    let promise = sendHttpJsonPostRequest(
        openHttpRequest(`${url}/graph/merge`, 'POST'),
        [
          [String(first.segmentId), ...first.position],
          [String(second.segmentId), ...second.position]
        ],
        'arraybuffer');

    return this
        .withErrorMessage(promise, {
          initialMessage: `Merging ${first.segmentId} and ${second.segmentId}`,
          errorPrefix: 'Merge failed: '
        })
        .then(response => {
          let uint32 = new Uint32Array(response);
          return new Uint64(uint32[0], uint32[1]);
        });
  }

  splitSegments(first: SegmentSelection[], second: SegmentSelection[]): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    let promise = sendHttpJsonPostRequest(
        openHttpRequest(`${url}/graph/split`, 'POST'), {
          'sources': first.map(x => [String(x.segmentId), ...x.position]),
          'sinks': second.map(x => [String(x.segmentId), ...x.position])
        },
        'arraybuffer');

    return this
        .withErrorMessage(promise, {
          initialMessage: `Splitting ${first.length} sinks from ${second.length} sources`,
          errorPrefix: 'Split failed: '
        })
        .then(response => {
          let uint32 = new Uint32Array(response);
          let final: Uint64[] = new Array(uint32.length / 2);
          for (let i = 0; i < uint32.length / 2; i++) {
            final[i] = new Uint64(uint32[2 * i], uint32[2 * i + 1]);
          }
          return final;
        });
  }

  draw() {}

  withErrorMessage<T>(promise: Promise<T>, options: {initialMessage: string, errorPrefix: string}):
      Promise<T> {
    let status = new StatusMessage(true);
    status.setText(options.initialMessage);
    let dispose = status.dispose.bind(status);
    promise.then(dispose, reason => {
      let msg = '';
      try {
        const errorResponse =
            JSON.parse(String.fromCharCode.apply(null, new Uint8Array(reason.response)));
        console.error(errorResponse);
        msg += errorResponse['message'];
      } catch {
      }  // Doesn't matter
      let {errorPrefix = ''} = options;
      status.setErrorMessage(errorPrefix + msg);
      status.setVisible(true);
    });
    return promise;
  }
}
