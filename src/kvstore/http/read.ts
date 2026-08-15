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

import { composeByteRangeRequest } from "#src/kvstore/byte_range/file_handle.js";
import type {
  ByteRange,
  DriverReadOptions,
  ReadableKvStore,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { KvStoreFileHandle, NotFoundError } from "#src/kvstore/index.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk, HttpError, isNotFoundError } from "#src/util/http_request.js";
import type { ProgressListener } from "#src/util/progress_listener.js";

function getRangeHeader(request: ByteRange | undefined): string | undefined {
  if (request === undefined) return undefined;
  return `bytes=${request.offset}-${request.offset + request.length - 1}`;
}

/**
 * On Chromium, multiple concurrent byte range requests to the same URL are serialized unless the
 * cache is disabled.  Disabling the cache works around the problem.
 *
 * https://bugs.chromium.org/p/chromium/issues/detail?id=969828
 */
const byteRangeCacheMode =
  navigator.userAgent.indexOf("Chrome") !== -1 ? "no-store" : "default";

function wasRedirectedToDirectoryListing(url: string, response: Response) {
  return new URL(url).pathname + "/" === new URL(response.url).pathname;
}

function parse206ContentRangeHeader(contentRange: string) {
  const m = contentRange.match(/bytes ([0-9]+)-([0-9]+)\/([0-9]+|\*)/);
  if (m === null) {
    throw new Error(
      `Invalid content-range header: ${JSON.stringify(contentRange)}`,
    );
  }
  const offset = parseInt(m[1], 10);
  const endPos = parseInt(m[2], 10);
  let totalSize: number | undefined;
  if (m[3] !== "*") {
    totalSize = parseInt(m[3], 10);
  }
  const length = endPos - offset + 1;
  return { offset, length, totalSize };
}

export async function read<Key>(
  store: ReadableKvStore<Key>,
  key: Key,
  url: string,
  options: DriverReadOptions,
  fetchOkImpl: FetchOk = fetchOk,
): Promise<ReadResponse | undefined> {
  let resolvedByteRange: ByteRange | undefined;
  try {
    const { byteRange: byteRangeRequest } = options;
    let rangeHeader: string | undefined;
    // The HTTP spec supports suffixLength requests directly via "Range:
    // bytes=-N" requests, which avoids the need for a separate HEAD request.
    // However, per
    // https://fetch.spec.whatwg.org/#cors-safelisted-request-header a suffix
    // length byte range request header will always trigger an OPTIONS preflight
    // request, which would otherwise be avoided. This negates the benefit of
    // using a suffixLength request directly. Additionally, some servers such as
    // the npm http-server package and https://uk1s3.embassy.ebi.ac.uk/ do not
    // correctly handle suffixLength requests or do not correctly handle CORS
    // preflight requests. To avoid those issues, always just issue a separate
    // HEAD request to determine the length.
    if (byteRangeRequest !== undefined) {
      if ("suffixLength" in byteRangeRequest) {
        const statResponse = await stat(store, key, url, options, fetchOkImpl);
        if (statResponse === undefined) return undefined;
        const { totalSize } = statResponse;
        if (totalSize === undefined) {
          throw new Error(
            `Failed to determine total size of ${store.getUrl(key)} in order to fetch suffix ${JSON.stringify(byteRangeRequest)}`,
          );
        }
        resolvedByteRange = composeByteRangeRequest(
          { offset: 0, length: totalSize },
          byteRangeRequest,
        ).outer;
        if (resolvedByteRange.length === 0) {
          // Skip zero-byte read, since totalSize is already known.
          return {
            ...resolvedByteRange,
            totalSize,
            response: new Response(new Uint8Array(0)),
          };
        }
        rangeHeader = getRangeHeader(resolvedByteRange);
      } else {
        resolvedByteRange = byteRangeRequest;
        if (resolvedByteRange.length === 0) {
          // The HTTP range header does not support zero-length byte range
          // requests.
          //
          // Convert zero-length byte range to length-1 byte range, and then
          // discard the response. If the requested offset is 0, and the file is
          // empty, then this will result in a 416 Range Not Satisfiable
          // response.
          rangeHeader = getRangeHeader({
            offset: Math.max(resolvedByteRange.offset - 1, 0),
            length: 1,
          });
        } else {
          rangeHeader = getRangeHeader(resolvedByteRange);
        }
      }
    }
    const requestInit: RequestInit & { progressListener?: ProgressListener } = {
      signal: options.signal,
      progressListener: options.progressListener,
    };
    if (rangeHeader !== undefined) {
      requestInit.headers = { range: rangeHeader };
      requestInit.cache = byteRangeCacheMode;
    }
    let response = await fetchOkImpl(url, requestInit);
    if (wasRedirectedToDirectoryListing(url, response)) {
      return undefined;
    }
    let offset: number | undefined;
    let length: number | undefined;
    let totalSize: number | undefined;
    if (response.status === 206) {
      const contentRange = response.headers.get("content-range");
      if (contentRange === null) {
        // Content-range should always be sent, but some buggy servers don't
        // send it.
        if (resolvedByteRange !== undefined) {
          offset = resolvedByteRange.offset;
        } else {
          throw new Error(
            "Unexpected HTTP 206 response when no byte range specified.",
          );
        }
      }
      if (contentRange !== null) {
        ({ offset, length, totalSize } =
          parse206ContentRangeHeader(contentRange));
      }
    } else {
      length = totalSize = getBodyLength(response.headers);
    }
    if (offset === undefined) {
      offset = 0;
    }
    if (length === undefined) {
      length = getBodyLength(response.headers);
    }
    if (resolvedByteRange?.length === 0) {
      response = new Response(new Uint8Array(0));
      offset = resolvedByteRange.offset;
      length = 0;
    }
    return {
      response,
      offset,
      length,
      totalSize,
    };
  } catch (e) {
    if (
      e instanceof HttpError &&
      e.status === 416 &&
      resolvedByteRange?.length === 0 &&
      resolvedByteRange.offset === 0
    ) {
      return {
        response: new Response(new Uint8Array(0)),
        offset: 0,
        length: 0,
        totalSize: 0,
      };
    }
    return handleThrowIfMissing(store, key, options, e);
  }
}

function getBodyLength(headers: Headers): number | undefined {
  const contentLength = headers.get("content-length");
  const contentEncoding = headers.get("content-encoding");
  if (contentEncoding === null && contentLength !== null) {
    const size = Number(contentLength);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid content-length: {contentLength}`);
    }
    return size;
  }
  return undefined;
}

function handleThrowIfMissing<Key>(
  store: ReadableKvStore<Key>,
  key: Key,
  options: { throwIfMissing?: boolean },
  error: unknown,
) {
  if (isNotFoundError(error)) {
    if (options.throwIfMissing === true) {
      throw new NotFoundError(new KvStoreFileHandle(store, key), {
        cause: error,
      });
    }
    return undefined;
  }
  throw error;
}

export async function stat<Key>(
  store: ReadableKvStore<Key>,
  key: Key,
  url: string,
  options: StatOptions,
  fetchOkImpl: FetchOk = fetchOk,
): Promise<StatResponse | undefined> {
  // First try HEAD request.
  try {
    const response = await fetchOkImpl(url, {
      method: "HEAD",
      signal: options.signal,
      progressListener: options.progressListener,
    });
    if (wasRedirectedToDirectoryListing(url, response)) return undefined;
    return { totalSize: getBodyLength(response.headers) };
  } catch (e) {
    if (
      e instanceof HttpError &&
      (e.status === 405 /* method not allowed */ ||
        e.status === 501) /* not implemented */
    ) {
      // HEAD may not be supported, use GET with one byte range instead.
      //
      // For example,
      // https://data-proxy.ebrains.eu/api/v1/buckets/localizoom/14122_mPPC_BDA_s186.tif/14122_mPPC_BDA_s186.dzi
      // returns HTTP 405 Method Not Allowed in response to HEAD requests.
      //
      // Servers are not supposed to return 501 for HEAD requests
      // (https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/501), but
      // some do anyway:
      //
      // https://github.com/google/neuroglancer/issues/704
    } else {
      return handleThrowIfMissing(store, key, options, e);
    }
  }

  // Try GET with one-byte range instead.
  try {
    const response = await fetchOkImpl(url, {
      signal: options.signal,
      progressListener: options.progressListener,
      headers: { range: "bytes=0-0" },
    });
    if (wasRedirectedToDirectoryListing(url, response)) return undefined;
    let totalSize: number | undefined;
    if (response.status === 200) {
      totalSize = getBodyLength(response.headers);
    } else {
      const contentRange = response.headers.get("content-range");
      if (contentRange !== null) {
        ({ totalSize } = parse206ContentRangeHeader(contentRange));
      }
    }
    return { totalSize };
  } catch (e) {
    if (e instanceof HttpError && e.status === 416) {
      return { totalSize: 0 };
    }
    return handleThrowIfMissing(store, key, options, e);
  }
}
