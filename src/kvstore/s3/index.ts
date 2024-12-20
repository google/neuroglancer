/**
 * @license
 * Copyright 2024 Google Inc.
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
import { getS3BucketListing } from "#src/kvstore/s3/list.js";
import { encodePathForUrl } from "#src/kvstore/url.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk } from "#src/util/http_request.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export class S3KvStore implements KvStore {
  constructor(
    public baseUrl: string,
    public baseUrlForDisplay: string,
    private fetchOkImpl: FetchOk = fetchOk,
  ) {}

  stat(key: string, options: StatOptions): Promise<StatResponse | undefined> {
    const url = `${this.baseUrl}${key}`;
    return stat(this, key, url, options, this.fetchOkImpl);
  }

  read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const url = `${this.baseUrl}${key}`;
    return read(this, key, url, options, this.fetchOkImpl);
  }

  list(prefix: string, options: DriverListOptions): Promise<ListResponse> {
    const { progressListener } = options;
    using _span =
      progressListener === undefined
        ? undefined
        : new ProgressSpan(progressListener, {
            message: `Listing prefix ${this.getUrl(prefix)}`,
          });
    return getS3BucketListing(this.baseUrl, prefix, {
      fetchOkImpl: this.fetchOkImpl,
      signal: options.signal,
      progressListener,
    });
  }

  getUrl(path: string) {
    return this.baseUrlForDisplay + encodePathForUrl(path);
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}
