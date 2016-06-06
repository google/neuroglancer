/**
 * @license
 * Copyright 2016 Google Inc.
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

import {simpleStringHash} from 'neuroglancer/util/hash';
import {makeCancellablePromise, CancellablePromise} from 'neuroglancer/util/promise';

export type RequestModifier = (request: XMLHttpRequest) => void;

export const URL_SYMBOL = Symbol('url');
export const METHOD_SYMBOL = Symbol('method');

export class HttpError extends Error {
  method: string;
  url: string;
  code: number;
  statusMessage: string;

  constructor (method: string, url: string, code: number, statusMessage: string) {
    let message = `${method} ${JSON.stringify(url)} resulted in HTTP error ${code}`;
    if (statusMessage) {
      message += `: ${statusMessage}`;
    }
    message += '.';
    super(message);
    this.name = 'HttpError';
    this.message = message;
    this.method = method;
    this.url = url;
    this.code = code;
    this.statusMessage = statusMessage;
  }

  static fromXhr(xhr: XMLHttpRequest) {
    return new HttpError((<any>xhr)[METHOD_SYMBOL], (<any>xhr)[URL_SYMBOL], xhr.status, xhr.statusText);
  }
};

export function openHttpRequest(url: string, method = 'GET') {
  let xhr = new XMLHttpRequest();
  (<any>xhr)[METHOD_SYMBOL] = method;
  (<any>xhr)[URL_SYMBOL] = url;
  xhr.open(method, url);
  return xhr;
}

export function pickShard(baseUrls: string|string[], path: string) {
  if (Array.isArray(baseUrls)) {
    let numShards = baseUrls.length;
    let shard = numShards === 1 ? 0 : Math.abs(simpleStringHash(path)) % numShards;
    return baseUrls[shard] + path;
  }
  return baseUrls + path;
}

export function openShardedHttpRequest(baseUrls: string|string[], path: string, method = 'GET') {
  let xhr = new XMLHttpRequest();
  const url = pickShard(baseUrls, path);
  (<any>xhr)[METHOD_SYMBOL] = method;
  (<any>xhr)[URL_SYMBOL] = url;
  xhr.open(method, url);
  return xhr;
}

export function sendHttpRequest(xhr: XMLHttpRequest, responseType: 'arraybuffer'): CancellablePromise<ArrayBuffer>;
export function sendHttpRequest(xhr: XMLHttpRequest, responseType: 'json'): CancellablePromise<any>;
export function sendHttpRequest(xhr: XMLHttpRequest, responseType: string): any;

export function sendHttpRequest(xhr: XMLHttpRequest, responseType: string) {
  xhr.responseType = responseType;
  return makeCancellablePromise((resolve, reject, onCancel) => {
    xhr.onloadend = function(this: XMLHttpRequest) {
      let status = this.status;
      if (status >= 200 && status < 300) {
        resolve(this.response);
      } else {
        reject(HttpError.fromXhr(xhr));
      }
    };
    onCancel(() => { xhr.abort(); });
    xhr.send();
  });
}

/**
 * Parses a URL that may have a special protocol designation into a list of base URLs and a path.
 *
 * If the protocol is 'http' or 'https', the input string is returned as a single base URL, with an
 * empty path.
 *
 * Additionally, 'gs://bucket/path' is supported for accessing Google Storage buckets.
 */
export function parseSpecialUrl(url: string): [string[], string] {
  const urlProtocolPattern = /^([^:\/]+):\/\/([^\/]+)(\/.*)?$/;
  let match = url.match(urlProtocolPattern);
  if (match === null) {
    throw new Error(`Invalid URL: ${JSON.stringify(url)}`);
  }
  const protocol = match[1];
  if (protocol === 'gs') {
    const bucket = match[2];
    const baseUrls = [
      `https://${bucket}.storage.googleapis.com`,
      `https://storage.googleapis.com/${bucket}`,
    ];
    return [baseUrls, match[3]];
  }
  return [[url], ''];
}
