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

import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import type { DriverListOptions, ListResponse } from "#src/kvstore/index.js";
import { ReadableS3KvStore } from "#src/kvstore/s3/common.js";
import {
  getS3BucketListing,
  listS3CompatibleUrl,
} from "#src/kvstore/s3/list.js";
import { joinBaseUrlAndPath } from "#src/kvstore/url.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

export class S3KvStore extends ReadableS3KvStore<SharedKvStoreContext> {
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
      this.sharedKvStoreContext.chunkManager.memoize,
      this.fetchOkImpl,
      options,
    );
  }
}
