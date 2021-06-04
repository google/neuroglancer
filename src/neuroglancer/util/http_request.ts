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

import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {Uint64} from 'neuroglancer/util/uint64';

export class HttpError extends Error {
  url: string;
  status: number;
  statusText: string;

  constructor(url: string, status: number, statusText: string) {
    let message = `Fetching ${JSON.stringify(url)} resulted in HTTP error ${status}`;
    if (statusText) {
      message += `: ${statusText}`;
    }
    message += '.';
    super(message);
    this.name = 'HttpError';
    this.message = message;
    this.url = url;
    this.status = status;
    this.statusText = statusText;
  }

  static fromResponse(response: Response) {
    return new HttpError(response.url, response.status, response.statusText);
  }

  static fromRequestError(input: RequestInfo, error: unknown) {
    if (error instanceof TypeError) {
      let url: string;
      if (typeof input === 'string') {
        url = input;
      } else {
        url = input.url;
      }
      return new HttpError(url, 0, 'Network or CORS error');
    }
    return error;
  }
}

/**
 * Issues a `fetch` request.
 *
 * If the request fails due to an HTTP status outside `[200, 300)`, throws an `HttpError`.  If the
 * request fails due to a network or CORS restriction, throws an `HttpError` with a `status` of `0`.
 */
export async function fetchOk(input: RequestInfo, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw HttpError.fromRequestError(input, error);
  }
  if (!response.ok) throw HttpError.fromResponse(response);
  return response;
}

export function responseArrayBuffer(response: Response): Promise<ArrayBuffer> {
  return response.arrayBuffer();
}

export function responseJson(response: Response): Promise<any> {
  return response.json();
}

export type ResponseTransform<T> = (response: Response) => Promise<T>;

/**
 * Issues a `fetch` request in the same way as `fetchOk`, and returns the result of the promise
 * returned by `transformResponse`.
 *
 * Additionally, the request may be cancelled through `cancellationToken`.
 *
 * The `transformResponse` function should not do anything with the `Response` object after its
 * result becomes ready; otherwise, cancellation may not work as expected.
 */
export async function cancellableFetchOk<T>(
    input: RequestInfo, init: RequestInit, transformResponse: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  if (cancellationToken === uncancelableToken) {
    const response = await fetchOk(input, init);
    return await transformResponse(response);
  }
  const abortController = new AbortController();
  const unregisterCancellation = cancellationToken.add(() => abortController.abort());
  try {
    const response = await fetchOk(input, {...init, signal: abortController.signal});
    return await transformResponse(response);
  } finally {
    unregisterCancellation();
  }
}

const tempUint64 = new Uint64();

export function getByteRangeHeader(startOffset: Uint64|number, endOffset: Uint64|number) {
  let endOffsetStr: string;
  if (typeof endOffset === 'number') {
    endOffsetStr = `${endOffset - 1}`;
  } else {
    Uint64.decrement(tempUint64, endOffset);
    endOffsetStr = tempUint64.toString();
  }
  return {'Range': `bytes=${startOffset}-${endOffsetStr}`};
}

export function parseUrl(url: string): {protocol: string, host: string, path: string} {
  const urlProtocolPattern = /^([^:\/]+):\/\/([^\/]+)((?:\/.*)?)$/;
  let match = url.match(urlProtocolPattern);
  if (match === null) {
    throw new Error(`Invalid URL: ${JSON.stringify(url)}`);
  }
  return {protocol: match[1], host: match[2], path: match[3]};
}

export function isNotFoundError(e: any) {
  if (!(e instanceof HttpError)) return false;
  // Treat CORS errors (0) or 403 as not found.  S3 returns 403 if the file does not exist because
  // permissions are per-file.
  return (e.status === 0 || e.status === 403 || e.status === 404);
}
