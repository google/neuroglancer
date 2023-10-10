/**
 * @license
 * Copyright 2023 Google Inc.
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

import {ByteRange, ByteRangeRequest, composeByteRangeRequest, ReadableKvStore, ReadOptions, ReadResponse} from 'neuroglancer/kvstore';
import {uncancelableToken} from 'neuroglancer/util/cancellation';
import {HttpError, isNotFoundError} from 'neuroglancer/util/http_request';
import {cancellableFetchSpecialOk, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

function getRangeHeader(request: ByteRangeRequest|undefined): string|undefined {
  if (request === undefined) return undefined;
  if ('suffixLength' in request) {
    return `bytes=-${request.suffixLength}`;
  }
  return `bytes=${request.offset}-${request.offset + request.length - 1}`;
}

/**
 * On Chromium, multiple concurrent byte range requests to the same URL are serialized unless the
 * cache is disabled.  Disabling the cache works around the problem.
 *
 * https://bugs.chromium.org/p/chromium/issues/detail?id=969828
 */
const byteRangeCacheMode = navigator.userAgent.indexOf('Chrome') !== -1 ? 'no-store' : 'default';

class SpecialProtocolKvStore implements ReadableKvStore {
  constructor(
      public credentialsProvider: SpecialProtocolCredentialsProvider, public baseUrl: string) {}
  async read(key: string, options: ReadOptions): Promise<ReadResponse|undefined> {
    const {cancellationToken = uncancelableToken} = options;
    let {byteRange: byteRangeRequest} = options;
    const url = this.baseUrl + key;
    for (let attempt = 0;; ++attempt) {
      try {
        const requestInit: RequestInit = {};
        const rangeHeader = getRangeHeader(byteRangeRequest);
        if (rangeHeader !== undefined) {
          requestInit.headers = {'range': rangeHeader};
          requestInit.cache = byteRangeCacheMode;
        }
        const {response, data} = await cancellableFetchSpecialOk(
            this.credentialsProvider, url, requestInit,
            async response => ({response, data: await response.arrayBuffer()}), cancellationToken);
        let byteRange: ByteRange|undefined;
        let totalSize: number|undefined;
        if (response.status === 206) {
          const contentRange = response.headers.get('content-range');
          if (contentRange === null) {
            if (byteRangeRequest !== undefined) {
              if ('suffixLength' in byteRangeRequest) {
                throw new Error(
                    `Content-range header not provided with HTTP 206 response.  Check server CORS configuration.`);
              } else {
                byteRange = {offset: byteRangeRequest.offset, length: data.byteLength};
              }
            } else {
              throw new Error(`Unexpected HTTP 206 response when no byte range specified.`);
            }
          }
          if (contentRange !== null) {
            const m = contentRange.match(/bytes ([0-9]+)-([0-9]+)\/([0-9]+|\*)/);
            if (m === null) {
              throw new Error(`Invalid content-range header: ${JSON.stringify(contentRange)}`);
            }
            const beginPos = parseInt(m[1], 10);
            const endPos = parseInt(m[2], 10);
            if (endPos !== beginPos + data.byteLength - 1) {
              throw new Error(`Length in content-range header ${
                  JSON.stringify(contentRange)} does not match content length ${data.byteLength}`);
            }
            totalSize = m[3] === '*' ? undefined : parseInt(m[3], 10);
            byteRange = {offset: beginPos, length: data.byteLength};
          }
        }
        if (byteRange === undefined) {
          byteRange = {offset: 0, length: data.byteLength};
          totalSize = data.byteLength;
        }
        return {data: new Uint8Array(data), dataRange: byteRange, totalSize};
      } catch (e) {
        if (attempt === 0 && e instanceof HttpError && e.status === 416 &&
            options.byteRange !== undefined && 'suffixLength' in options.byteRange) {
          // Some servers, such as the npm http-server package, do not support suffixLength
          // byte-range requests.
          const headResponse = await cancellableFetchSpecialOk(
              this.credentialsProvider, url, {method: 'HEAD'}, async response => response,
              cancellationToken);
          if (headResponse.status !== 200) {
            throw new Error(`Failed to determine total size in order to fetch suffix`);
          }
          const contentLength = headResponse.headers.get('content-length');
          if (contentLength === undefined) {
            throw new Error(`Failed to determine total size in order to fetch suffix`);
          }
          const contentLengthNumber = Number(contentLength);
          byteRangeRequest =
              composeByteRangeRequest({offset: 0, length: contentLengthNumber}, byteRangeRequest)
                  .outer;
          continue;
        }
        if (isNotFoundError(e)) {
          return undefined;
        }
        throw e;
      }
    }
  }
}
export function getSpecialProtocolKvStore(
    credentialsProvider: SpecialProtocolCredentialsProvider, baseUrl: string): ReadableKvStore {
  return new SpecialProtocolKvStore(credentialsProvider, baseUrl);
}
