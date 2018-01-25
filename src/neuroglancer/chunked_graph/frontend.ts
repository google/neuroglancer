/**
 * @license
 * Copyright 2017 The Neuroglancer Authors
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
import {CHUNKED_GRAPH_LAYER_RPC_ID, ChunkedGraphSource as ChunkedGraphSourceInterface} from 'neuroglancer/chunked_graph/base';
import {ChunkedGraphChunkSpecification, ChunkedGraphSourceOptions} from 'neuroglancer/chunked_graph/base';
import {SegmentSelection, SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SliceView, SliceViewChunkSource, MultiscaleSliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {RenderLayer as GenericSliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {openHttpRequest, sendHttpRequest, sendHttpJsonPostRequest, HttpError} from 'neuroglancer/util/http_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {ShaderProgram} from 'neuroglancer/webgl/shader';
import {RPC, SharedObject, RpcId} from 'neuroglancer/worker_rpc';

export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

export interface SegmentSelection {
  segment: Uint64;
  root: Uint64;
  position: number[];
}

export class ChunkedGraphChunkSource extends SliceViewChunkSource implements
    ChunkedGraphSourceInterface {
  spec: ChunkedGraphChunkSpecification;
  rootSegments: Uint64Set;

  constructor(chunkManager: ChunkManager, options: {
      spec: ChunkedGraphChunkSpecification, rootSegments: Uint64Set}) {
    super(chunkManager, options);
    this.rootSegments = options.rootSegments;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['rootSegments'] = this.rootSegments.rpcId;
    super.initializeCounterpart(rpc, options);
  }
}

export interface MultiscaleChunkedGraphSource extends MultiscaleSliceViewChunkSource {
  getSources: (options: ChunkedGraphSourceOptions) => ChunkedGraphChunkSource[][];
}

export class ChunkedGraphLayer extends GenericSliceViewRenderLayer {
  private graphurl: string;
  shader: ShaderProgram|undefined = undefined;
  shaderUpdated = true;
  rpcId: RpcId|null = null;

  constructor(
      chunkManager: ChunkManager,
      graphurl: string,
      public sources: ChunkedGraphChunkSource[][],
      displayState: SegmentationDisplayState) {
    super(chunkManager, sources);
    this.graphurl = graphurl;
    let sharedObject = this.registerDisposer(new SharedObject());
    sharedObject.RPC_TYPE_ID = CHUNKED_GRAPH_LAYER_RPC_ID;
    sharedObject.initializeCounterpart(this.chunkManager.rpc!, {
        'chunkManager': this.chunkManager.rpcId,
        'url': this.url,
        'sources': this.sourceIds,
        'rootSegments': displayState.rootSegments.rpcId,
        'visibleSegments3D': displayState.visibleSegments3D.rpcId,
        'segmentEquivalences': displayState.segmentEquivalences.rpcId,
      }
    );
    this.rpcId = sharedObject.rpcId;

    this.setReady(true);
  }

  get url() {
    return this.graphurl;
  }

  getRoot(segment: Uint64): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.resolve(segment);
    }

    let promise = sendHttpRequest(openHttpRequest(`${url}/1.0/segment/${segment}/root`), 'arraybuffer');

    return promise.then(response => {
      if (response.byteLength === 0) {
        throw new Error(`Agglomeration for segment ${segment} is too large to show.`);
      } else {
        let uint32 = new Uint32Array(response);
        return new Uint64(uint32[0], uint32[1]);
      }
    }).catch((e: HttpError) => {
      console.log(`Could not retrieve root for segment ${segment}`);
      console.error(e);
      return Promise.reject(e);
    });
  }

  mergeSegments(first: SegmentSelection, second: SegmentSelection): Promise<Uint64> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    let promise = sendHttpJsonPostRequest(openHttpRequest(`${url}/1.0/graph/merge`, 'POST'),
      [
        [String(first.segmentId), ...first.position], [String(second.segmentId), ...second.position]
      ],
      'arraybuffer');

    return promise.then(response => {
      let uint32 = new Uint32Array(response);
      return new Uint64(uint32[0], uint32[1]);
    }).catch((e: HttpError) => {
      console.log(`Could not retrieve merge result of segments ${first.segmentId} and ${second.segmentId}.`);
      console.error(e);
      return Promise.reject(e);
    });
  }

  splitSegments(first: SegmentSelection[], second: SegmentSelection[]): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.reject(GRAPH_SERVER_NOT_SPECIFIED);
    }

    let promise = sendHttpJsonPostRequest(openHttpRequest(`${url}/1.0/graph/split`, 'POST'),
      {
        'sources': first.map(x => [String(x.segmentId), ...x.position]),
        'sinks': second.map(x => [String(x.segmentId), ...x.position])
      },
      'arraybuffer');

    return promise.then(response => {
      let uint32 = new Uint32Array(response);
      let final: Uint64[] = new Array(uint32.length / 2);
      for (let i = 0; i < uint32.length / 2; i++) {
        final[i] = new Uint64(uint32[2 * i], uint32[2 * i + 1]);
      }
      return final;
    }).catch((e: HttpError) => {
      console.log(`Could not retrieve split result.`);// of segments ${first} and ${second}.`);
      console.error(e);
      return Promise.reject(e);
    });
  }

  beginSlice(_sliceView: SliceView) {
    let shader = this.shader!;
    shader.bind();
    return shader;
  }

  endSlice() {}

  defineShader() {}

  draw() {}
}
