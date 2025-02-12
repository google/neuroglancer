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

import type { ListEntry, ListResponse } from "#src/kvstore/index.js";
import { encodePathForUrl, getBaseHttpUrlAndPath } from "#src/kvstore/url.js";
import type { FetchOk } from "#src/util/http_request.js";
import type { StringMemoize } from "#src/util/memoize.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

const EXPECTED_XML_NAMESPACE_URIS = [
  "http://doc.s3.amazonaws.com/2006-03-01/",
  "http://s3.amazonaws.com/doc/2006-03-01/",
];

function isValidListObjectsResponse(documentElement: Element): boolean {
  return (
    EXPECTED_XML_NAMESPACE_URIS.includes(documentElement.namespaceURI!) &&
    documentElement.tagName === "ListBucketResult"
  );
}

export function isS3ListResponse(text: string): boolean {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch {
    return false;
  }
  return isValidListObjectsResponse(doc.documentElement);
}

export async function getS3BucketListing(
  bucketUrl: string,
  prefix: string,
  fetchOkImpl: FetchOk,
  options: Partial<ProgressOptions>,
): Promise<ListResponse> {
  const delimiter = "/";
  try {
    const response = await fetchOkImpl(
      `${bucketUrl}?list-type=2&prefix=${encodeURIComponent(prefix)}` +
        `&delimiter=${encodeURIComponent(delimiter)}&encoding-type=url`,
      /*init=*/ {
        headers: { accept: "application/xml,text/xml" },
        signal: options.signal,
        progressListener: options.progressListener,
      },
    );
    const contentType = response.headers.get("content-type");
    // Per https://github.com/getmoto/moto/issues/8560, also allow text/html.
    if (
      contentType === null ||
      /\b(application\/xml|text\/xml|text\/html)\b/i.exec(contentType) === null
    ) {
      throw new Error(`Expected XML content-type but received: ${contentType}`);
    }
    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const { documentElement } = doc;
    if (!isValidListObjectsResponse(documentElement)) {
      throw new Error(
        `Received unexpected XML root element <${documentElement.tagName} xmlns="${documentElement.namespaceURI}">`,
      );
    }
    const namespaceURI = documentElement.namespaceURI!;
    const namespaceResolver: XPathNSResolver = () => namespaceURI;
    const commonPrefixNodes = doc.evaluate(
      "//CommonPrefixes/Prefix",
      doc,
      namespaceResolver,
      XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const directories: string[] = [];
    for (let i = 0, n = commonPrefixNodes.snapshotLength; i < n; ++i) {
      let name = commonPrefixNodes.snapshotItem(i)!.textContent;
      if (name === null) continue;
      name = decodeURIComponent(name);
      // Exclude delimiter from end of `name`.
      directories.push(name.substring(0, name.length - delimiter.length));
    }

    const entries: ListEntry[] = [];
    const contents = doc.evaluate(
      "//Contents/Key",
      doc,
      namespaceResolver,
      XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    for (let i = 0, n = contents.snapshotLength; i < n; ++i) {
      const name = contents.snapshotItem(i)!.textContent;
      if (name === null) continue;
      entries.push({ key: decodeURIComponent(name) });
    }
    return { directories, entries };
  } catch (e) {
    throw new Error(`S3-compatible listing not supported`, { cause: e });
  }
}

function getVirtualHostedStyleListing(
  url: string,
  fetchOkImpl: FetchOk,
  options: Partial<ProgressOptions>,
): Promise<ListResponse> {
  const { baseUrl, path } = getBaseHttpUrlAndPath(url);
  return getS3BucketListing(baseUrl, path, fetchOkImpl, options);
}

function parsePathStyleUrl(url: string):
  | {
      bucketUrl: string;
      bucket: string;
      prefix: string;
    }
  | undefined {
  const u = new URL(url);
  const m = u.pathname.match(/^\/([^/]+)(?:\/(.*))$/)!;
  if (m === null) {
    return undefined;
  }
  const [, bucket, path] = m;
  return {
    bucketUrl: `${u.origin}/${bucket}/${u.search}`,
    bucket: decodeURIComponent(bucket),
    prefix: decodeURIComponent(path),
  };
}

async function getPathStyleListing(
  url: string,
  fetchOkImpl: FetchOk,
  options: Partial<ProgressOptions>,
): Promise<ListResponse> {
  const parsed = parsePathStyleUrl(url);
  if (parsed === undefined) {
    throw new Error(
      `Path-style S3 URL ${JSON.stringify(url)} must specify bucket`,
    );
  }
  const { bucketUrl, bucket, prefix } = parsed;
  const response = await getS3BucketListing(
    bucketUrl,
    prefix,
    fetchOkImpl,
    options,
  );
  const bucketPrefix = encodePathForUrl(bucket) + "/";
  return {
    entries: response.entries.map((entry) => ({
      key: bucketPrefix + entry.key,
    })),
    directories: response.directories.map((name) => bucketPrefix + name),
  };
}

export type S3UrlKind = "virtual" | "path";

// Map of known S3-compatible servers, indicating the URL type.
//
// The key is the origin / base URL.
//
// A value of `null` indicates that S3-style listing is not supported.
function getUrlKindCache(memoize: StringMemoize) {
  return memoize.getUncounted(
    "s3:urlkind",
    () => new Map<string, S3UrlKind | null>(),
  );
}

// Lists an S3-compatible URL.
//
// Both virtual hosted-style URLS `https://{host}/{path}` and
// `https://{host}/{bucket}/{path}` are supported.
export async function listS3CompatibleUrl(
  url: string,
  origin: string,
  memoize: StringMemoize,
  fetchOkImpl: FetchOk,
  options: Partial<ProgressOptions>,
): Promise<ListResponse> {
  const cache = getUrlKindCache(memoize);
  const urlKind = cache.get(origin);
  if (urlKind === "virtual") {
    return await getVirtualHostedStyleListing(url, fetchOkImpl, options);
  }
  if (urlKind === "path") {
    return await getPathStyleListing(url, fetchOkImpl, options);
  }
  if (urlKind !== null) {
    try {
      const { result, urlKind } = await Promise.any([
        getVirtualHostedStyleListing(url, fetchOkImpl, options).then(
          (result) => ({
            result,
            urlKind: "virtual" as const,
          }),
        ),
        getPathStyleListing(url, fetchOkImpl, options).then((result) => ({
          result,
          urlKind: "path" as const,
        })),
      ]);
      cache.set(origin, urlKind);
      return result;
    } catch (e) {
      options.signal?.throwIfAborted();
      cache.set(origin, null);
      throw new Error(
        `Neither virtual hosted nor path-style S3 listing supported`,
        { cause: e },
      );
    }
  }
  throw new Error(`Neither virtual hosted nor path-style S3 listing supported`);
}

export function getS3UrlKind(
  memoize: StringMemoize,
  origin: string,
): S3UrlKind | null | undefined {
  return getUrlKindCache(memoize).get(origin);
}
