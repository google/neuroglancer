/**
 * @license
 * Copyright 2017 Google Inc.
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

import {getToken, Token} from 'neuroglancer/datasource/boss/api_implementation';
import {HttpError, openShardedHttpRequest} from 'neuroglancer/util/http_request';
import {CancellationToken, uncancelableToken, CANCELED} from 'neuroglancer/util/cancellation';

export var numPendingRequests = 0;

export interface HttpHeader {
    key: string;
    value: string
}

export interface HttpCall {
  method: 'GET'|'POST';
  path: string;
  responseType: XMLHttpRequestResponseType;
  payload?: string;
  headers?: HttpHeader[];
}

export function makeRequest(
    baseUrls: string|string[], httpCall: HttpCall, cancellationToken?: CancellationToken): Promise<ArrayBuffer>;
export function makeRequest(
    baseUrls: string|string[], httpCall: HttpCall, cancellationToken?: CancellationToken): Promise<any>;
export function makeRequest(
    baseUrls: string|string[], httpCall: HttpCall, cancellationToken?: CancellationToken): any;

export function makeRequest(
    baseUrls: string|string[], httpCall: HttpCall, cancellationToken: CancellationToken = uncancelableToken): any {
  /**
   * undefined means request not yet attempted.  null means request
   * cancelled.
   */
  let xhr: XMLHttpRequest|undefined|null = undefined;
  return new Promise<any>((resolve, reject) => { 
    const abort = () => {
      let origXhr = xhr;
      xhr = null;
      if (origXhr != null) {
        origXhr.abort();
      }
      reject(CANCELED);
    } 
    cancellationToken.add(abort);
    function start(token: Token) {
      if (xhr === null) {
        --numPendingRequests;
        return;
      }
      xhr = openShardedHttpRequest(baseUrls, httpCall.path, httpCall.method);
      xhr.responseType = httpCall.responseType;
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (httpCall.headers !== undefined) {
          for (let i=0; i<httpCall.headers.length; i++) {
              let header = httpCall.headers[i];
              xhr.setRequestHeader(header.key, header.value);
          }
      }
      xhr.onloadend = function(this: XMLHttpRequest) {
        if (xhr === null) {
          --numPendingRequests;
          return;
        }
        let status = this.status;
        if (status >= 200 && status < 300) {
          --numPendingRequests;
          resolve(this.response);
        } else if (status === 403 || status === 401) {
          // Authorization needed.
          getToken(token).then(start);
        } else if (status === 504) {
          // Gateway timeout can occur if the server takes too long to reply.  Retry.
          getToken().then(start);
        } else {
          --numPendingRequests;
          cancellationToken.remove(abort);
          reject(HttpError.fromXhr(this));
        }
      };
      xhr.send(httpCall.payload);
    }
    getToken().then(start);
  });
}
