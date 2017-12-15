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

import {SegmentSelection} from 'neuroglancer/segmentation_display_state/frontend';
import {openHttpRequest, sendHttpRequest, sendHttpJsonPostRequest, HttpError} from 'neuroglancer/util/http_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject, RPC, SharedObject} from 'neuroglancer/worker_rpc';

export const CHUNKED_GRAPH_SERVER_RPC_ID = 'ChunkedGraphServer';
export const GRAPH_SERVER_NOT_SPECIFIED = Symbol('Graph Server Not Specified.');

export interface SegmentSelection {
  segment: Uint64;
  root: Uint64;
  position: number[];
}

@registerSharedObject(CHUNKED_GRAPH_SERVER_RPC_ID)
export class ChunkedGraph extends SharedObject {
  private graphurl: string;

  constructor(rpc: RPC, options: any = {}) {
    super();
    this.graphurl = options['url'];
    this.initializeCounterpart(rpc, options);
  }

  get url() {
    return this.graphurl;
  }

  initializeCounterpart(rpc: RPC, options: any = {}) {
    options['url'] = this.graphurl;
    super.initializeCounterpart(rpc, options);
  }

  disposed() {
    super.disposed();
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

  getLeaves(segment: Uint64): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.resolve([segment]);
    }

    let promise = sendHttpRequest(openHttpRequest(`${url}/1.0/segment/${segment}/leaves`), 'arraybuffer');

    return promise.then(response => {
      let uint32 = new Uint32Array(response);
      let final: Uint64[] = new Array(uint32.length / 2);
      for (let i = 0; i < uint32.length / 2; i++) {
        final[i] = new Uint64(uint32[2 * i], uint32[2 * i + 1]);
      }
      return final;
    }).catch((e: HttpError) => {
      console.log(`Could not retrieve connected components for segment ${segment}`);
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
}
