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
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk } from "#src/util/http_request.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

export async function getS3BucketListing(
  bucketUrl: string,
  prefix: string,
  options: {
    delimiter?: string;
    fetchOkImpl?: FetchOk;
  } & Partial<ProgressOptions> = {},
): Promise<ListResponse> {
  const {
    delimiter = "/",
    fetchOkImpl = fetchOk,
    signal,
    progressListener,
  } = options;
  const response = await fetchOkImpl(
    `${bucketUrl}?prefix=${encodeURIComponent(prefix)}` +
      `&delimiter=${encodeURIComponent(delimiter)}`,
    /*init=*/ {
      signal: signal,
      progressListener,
    },
  );
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const namespaceResolver: XPathNSResolver = () =>
    "http://doc.s3.amazonaws.com/2006-03-01/";
  const commonPrefixNodes = doc.evaluate(
    "//CommonPrefixes/Prefix",
    doc,
    namespaceResolver,
    XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  const directories: string[] = [];
  for (let i = 0, n = commonPrefixNodes.snapshotLength; i < n; ++i) {
    const name = commonPrefixNodes.snapshotItem(i)!.textContent;
    if (name === null) continue;
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
    entries.push({ key: name });
  }
  return { directories, entries };
}
