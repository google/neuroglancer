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

import { listFromHtmlDirectoryListing } from "#src/kvstore/http/html_directory_listing.js";
import { read, stat } from "#src/kvstore/http/read.js";
import type {
  KvStore,
  DriverListOptions,
  ListResponse,
  DriverReadOptions,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { extractQueryAndFragment } from "#src/kvstore/url.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk } from "#src/util/http_request.js";

function joinBaseUrlAndPath(baseUrl: string, path: string) {
  const { base, queryAndFragment } = extractQueryAndFragment(baseUrl);
  return base + path + queryAndFragment;
}

export class HttpKvStore implements KvStore {
  constructor(
    public baseUrl: string,
    public baseUrlForDisplay: string = baseUrl,
    public fetchOkImpl: FetchOk = fetchOk,
  ) {}

  stat(key: string, options: StatOptions): Promise<StatResponse | undefined> {
    return stat(
      this,
      key,
      joinBaseUrlAndPath(this.baseUrl, key),
      options,
      this.fetchOkImpl,
    );
  }

  read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    return read(
      this,
      key,
      joinBaseUrlAndPath(this.baseUrl, key),
      options,
      this.fetchOkImpl,
    );
  }

  list(prefix: string, options: DriverListOptions): Promise<ListResponse> {
    return listFromHtmlDirectoryListing(this.baseUrl, prefix, options);
  }

  getUrl(path: string) {
    return joinBaseUrlAndPath(this.baseUrlForDisplay, path);
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}

export function getBaseUrlAndPath(url: string) {
  const parsed = new URL(url);
  if (parsed.hash) {
    throw new Error("fragment not supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("basic auth credentials not supported");
  }
  return {
    baseUrl: `${parsed.origin}/${parsed.search}`,
    path: decodeURI(parsed.pathname.substring(1)),
  };
}
