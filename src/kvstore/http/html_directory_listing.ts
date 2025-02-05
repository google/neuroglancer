/**
 * @license
 * Copyright 2019 Google Inc.
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

import {
  type ListEntry,
  type DriverListOptions,
  type ListResponse,
  normalizeListResponse,
} from "#src/kvstore/index.js";
import { isS3ListResponse } from "#src/kvstore/s3/list.js";
import { encodePathForUrl, extractQueryAndFragment } from "#src/kvstore/url.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk } from "#src/util/http_request.js";
import {
  ProgressSpan,
  type ProgressOptions,
} from "#src/util/progress_listener.js";

/**
 * Obtains a directory listing from a server that supports HTML directory listings.
 */
export async function getHtmlDirectoryListing(
  url: string,
  options: {
    fetchOkImpl?: FetchOk;
  } & Partial<ProgressOptions> = {},
): Promise<string[]> {
  const baseUrl = extractQueryAndFragment(url).base;
  const { fetchOkImpl = fetchOk, signal, progressListener } = options;
  const response = await fetchOkImpl(
    url,
    /*init=*/ {
      headers: { accept: "text/html" },
      signal: signal,
      progressListener,
    },
  );
  const contentType = response.headers.get("content-type");
  if (contentType === null || /\btext\/html\b/i.exec(contentType) === null) {
    throw new Error(`HTML directory listing not supported`);
  }
  const text = await response.text();
  // Verify that the response is a not an S3 ListObjects response. Per
  // https://github.com/getmoto/moto/issues/8560, moto responds with
  // `content-type: text/html`.
  if (isS3ListResponse(text)) {
    throw new Error(
      `HTML directory listing not supported, S3-compatible API detected`,
    );
  }
  const doc = new DOMParser().parseFromString(text, "text/html");
  const nodes = doc.evaluate(
    "//a/@href",
    doc,
    null,
    XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  const results = new Set<string>();
  for (let i = 0, n = nodes.snapshotLength; i < n; ++i) {
    const node = nodes.snapshotItem(i)!;
    const href = node.textContent;
    if (href === null) continue;
    const withoutQuery = extractQueryAndFragment(href).base;
    if (withoutQuery) {
      const resolvedUrl = new URL(withoutQuery, baseUrl).toString();
      if (resolvedUrl.startsWith(baseUrl) && resolvedUrl !== baseUrl) {
        results.add(resolvedUrl);
      }
    }
  }
  return Array.from(results);
}

export async function listFromHtmlDirectoryListing(
  baseUrl: string,
  prefix: string,
  fetchOkImpl: FetchOk,
  options: DriverListOptions,
): Promise<ListResponse> {
  const { progressListener } = options;
  using _span =
    progressListener &&
    new ProgressSpan(progressListener, {
      message: `Requesting HTML directory listing for ${baseUrl}`,
    });
  const { base, queryAndFragment } = extractQueryAndFragment(baseUrl);
  const baseAndPrefix = base + encodePathForUrl(prefix);
  const fullUrl = baseAndPrefix + queryAndFragment;
  const m = fullUrl.match(/^([a-z]+:\/\/.*\/)([^/?#]*)$/);
  if (m === null) {
    throw new Error(`Invalid HTTP URL: ${fullUrl}`);
  }
  const [, directoryUrl] = m;
  const listing = await getHtmlDirectoryListing(
    directoryUrl + queryAndFragment,
    {
      fetchOkImpl,
      signal: options.signal,
      progressListener: options.progressListener,
    },
  );
  const entries: ListEntry[] = [];
  const directories: string[] = [];
  for (const entry of listing) {
    if (!entry.startsWith(baseAndPrefix)) continue;
    const p = decodeURIComponent(entry.substring(base.length));
    if (p.endsWith("/")) {
      directories.push(p.substring(0, p.length - 1));
    } else {
      entries.push({ key: p });
    }
  }
  return normalizeListResponse({ entries, directories });
}
