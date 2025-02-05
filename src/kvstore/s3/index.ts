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
import {
  getS3BucketListing,
  listS3CompatibleUrl,
} from "#src/kvstore/s3/list.js";
import { joinBaseUrlAndPath } from "#src/kvstore/url.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk } from "#src/util/http_request.js";
import type { StringMemoize } from "#src/util/memoize.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export class S3KvStore implements KvStore {
  constructor(
    private memoize: StringMemoize,
    public baseUrl: string,
    public baseUrlForDisplay: string,
    private knownToBeVirtualHostedStyle: boolean,
    private fetchOkImpl: FetchOk = fetchOk,
  ) {}

  stat(key: string, options: StatOptions): Promise<StatResponse | undefined> {
    const url = joinBaseUrlAndPath(this.baseUrl, key);
    return stat(this, key, url, options, this.fetchOkImpl);
  }

  read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const url = joinBaseUrlAndPath(this.baseUrl, key);
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
    if (this.knownToBeVirtualHostedStyle) {
      return getS3BucketListing(
        this.baseUrl,
        prefix,
        this.fetchOkImpl,
        options,
      );
    }
    return listS3CompatibleUrl(
      joinBaseUrlAndPath(this.baseUrl, prefix),
      this.baseUrlForDisplay,
      this.memoize,
      this.fetchOkImpl,
      options,
    );
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
