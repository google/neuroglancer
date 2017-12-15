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

import {openHttpRequest, sendHttpRequest, HttpError} from 'neuroglancer/util/http_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

export const CHUNKED_GRAPH_SERVER_RPC_ID = 'ChunkedGraphServer';

@registerSharedObject(CHUNKED_GRAPH_SERVER_RPC_ID)
export class ChunkedGraph extends SharedObjectCounterpart {
  private graphurl: string;

  constructor(rpc: RPC, options: any = {}) {
    super();
    this.graphurl = options['url'];
    super.initializeSharedObject(rpc, options['id']);
  }

  get url() {
    return this.graphurl;
  }

  disposed() {
    super.disposed();
  }

  getChildren(segment: Uint64): Promise<Uint64[]> {
    const {url} = this;
    if (url === '') {
      return Promise.resolve([segment]);
    }

    let promise = sendHttpRequest(openHttpRequest(`${url}/1.0/segment/${segment}/children`), 'arraybuffer');
    return promise.then(response => {
      let uint32 = new Uint32Array(response);
      let final: Uint64[] = new Array(uint32.length / 2);
      for (let i = 0; i < uint32.length / 2; i++) {
        final[i] = new Uint64(uint32[2 * i], uint32[2 * i + 1]);
      }
      return final;
    }).catch((e: HttpError) => {
      console.log(`Could not retrieve children for segment ${segment}`);
      console.error(e);
      return Promise.reject(e);
    });
  }
}
