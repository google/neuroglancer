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

import {authFetch, responseIdentity} from 'neuroglancer/authentication/frontend.ts';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {CHUNKED_GRAPH_LAYER_RPC_ID, CHUNKED_GRAPH_SOURCE_UPDATE_ROOT_SEGMENTS_RPC_ID, ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface, ChunkedGraphChunkSpecification, RENDER_RATIO_LIMIT} from 'neuroglancer/sliceview/chunked_graph/base';
import {SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {RenderLayer as GenericSliceViewRenderLayer, RenderLayerOptions} from 'neuroglancer/sliceview/renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {vec3} from 'neuroglancer/util/geom';
import {verify3dVec, verifyObjectProperty} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {RPC} from 'neuroglancer/worker_rpc';

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

const SEGMENT_SELECTION_SEGMENT_ID_JSON_KEY = 'segmentId';
const SEGMENT_SELECTION_ROOT_ID_JSON_KEY = 'rootId';
const SEGMENT_SELECTION_POSITION_JSON_KEY = 'position';

export interface SegmentSelection {
  segmentId: Uint64;
  rootId: Uint64;
  position: vec3;
}

export function restoreSegmentSelection(x: any): SegmentSelection {
  return {
    segmentId: Uint64.parseString(x[SEGMENT_SELECTION_SEGMENT_ID_JSON_KEY], 10),
    rootId: Uint64.parseString(x[SEGMENT_SELECTION_ROOT_ID_JSON_KEY], 10),
    position: verifyObjectProperty(x, SEGMENT_SELECTION_POSITION_JSON_KEY, verify3dVec)
  };
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

    const promise = authFetch(
        `${url}/node/${String(selection.segmentId)}/root?int64_as_str=1${
            timestamp ? `&timestamp=${timestamp}` : ``}`,
        {}, responseIdentity, undefined, false);

    const response = await this.withErrorMessage(promise, {
      initialMessage: `Retrieving root for segment ${selection.segmentId}`,
      errorPrefix: `Could not fetch root: `
    });
    const jsonResp = await response.json();
    return Uint64.parseString(jsonResp['root_id']);
  }

  async mergeSegments(first: SegmentSelection, second: SegmentSelection): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = authFetch(
        `${url}/merge?int64_as_str=1`, {
          method: 'POST',
          body: JSON.stringify([
            [String(first.segmentId), ...first.position.values()],
            [String(second.segmentId), ...second.position.values()]
          ])
        },
        responseIdentity, undefined, false);

    const response = await this.withErrorMessage(promise, {
      initialMessage: `Merging ${first.segmentId} and ${second.segmentId}`,
      errorPrefix: 'Merge failed: '
    });
    const jsonResp = await response.json();
    return Uint64.parseString(jsonResp['new_root_ids'][0]);
  }

  async splitSegments(first: SegmentSelection[], second: SegmentSelection[]): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = authFetch(
        `${url}/split?int64_as_str=1`, {
          method: 'POST',
          body: JSON.stringify({
            'sources': first.map(x => [String(x.segmentId), ...x.position.values()]),
            'sinks': second.map(x => [String(x.segmentId), ...x.position.values()])
          })
        },
        responseIdentity, undefined, false);

    const response = await this.withErrorMessage(promise, {
      initialMessage: `Splitting ${first.length} sources from ${second.length} sinks`,
      errorPrefix: 'Split failed: '
    });
    const jsonResp = await response.json();
    const final: Uint64[] = new Array(jsonResp['new_root_ids'].length);
    for (let i = 0; i < final.length; ++i) {
      final[i] = Uint64.parseString(jsonResp['new_root_ids'][i]);
    }
    return final;
  }

  async splitPreview(first: SegmentSelection[], second: SegmentSelection[]):
      Promise<{supervoxelConnectedComponents: Uint64Set[], isSplitIllegal: boolean}> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = authFetch(
        `${url}/graph/split_preview?int64_as_str=1`, {
          method: 'POST',
          body: JSON.stringify({
            'sources': first.map(x => [String(x.segmentId), ...x.position.values()]),
            'sinks': second.map(x => [String(x.segmentId), ...x.position.values()])
          })
        },
        responseIdentity, undefined, false);

    const response = await this.withErrorMessage(promise, {
      initialMessage:
          `Calculating split preview: ${first.length} sources, and ${second.length} sinks`,
      errorPrefix: 'Split preview failed: '
    });
    const jsonResp = await response.json();
    const jsonCCKey = 'supervoxel_connected_components';
    const supervoxelConnectedComponents: Uint64Set[] = new Array(jsonResp[jsonCCKey].length);
    for (let i = 0; i < supervoxelConnectedComponents.length; i++) {
      const connectedComponent = new Array(jsonResp[jsonCCKey][i].length);
      for (let j = 0; j < jsonResp[jsonCCKey][i].length; j++) {
        connectedComponent[j] = Uint64.parseString(jsonResp[jsonCCKey][i][j], 10);
      }
      const connectedComponentSet = new Uint64Set();
      connectedComponentSet.add(connectedComponent);
      supervoxelConnectedComponents[i] = connectedComponentSet;
    }
    const jsonIllegalSplitKey = 'illegal_split';
    return {supervoxelConnectedComponents, isSplitIllegal: jsonResp[jsonIllegalSplitKey]};
  }

  async findPath(first: SegmentSelection, second: SegmentSelection): Promise<number[][]> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    const promise = authFetch(`${url}/graph/find_path?int64_as_str=1`, {
      method: 'POST',
      body: JSON.stringify([
        [String(first.segmentId), ...first.position.values()],
        [String(second.segmentId), ...second.position.values()]
      ])
    });

    const response = await this.withErrorMessage(promise, {
      initialMessage: `Finding path between ${first.segmentId} and ${second.segmentId}`,
      errorPrefix: 'Path finding failed: '
    });
    const jsonResponse = await response.json();
    const supervoxelCentroidsKey = 'centroids_list';
    const centroids = jsonResponse[supervoxelCentroidsKey];
    const missingL2IdsKey = 'failed_l2_ids';
    const missingL2Ids = jsonResponse[missingL2IdsKey];
    if (missingL2Ids && missingL2Ids.length > 0) {
      StatusMessage.showTemporaryMessage(
          'Some level 2 meshes are missing, so the path shown may have a poor level of detail.');
    }
    return centroids;
  }

  draw() {}

  async withErrorMessage(promise: Promise<Response>, options: {
    initialMessage: string,
    errorPrefix: string
  }): Promise<Response> {
    const status = new StatusMessage(true);
    status.setText(options.initialMessage);
    const dispose = status.dispose.bind(status);
    let response = await promise;
    if (response !== undefined && !(response instanceof Response)) {
      response = new Response(response);
    }
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
