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
import { ReadableHttpKvStore } from "#src/kvstore/http/common.js";
import { listFromHtmlDirectoryListing } from "#src/kvstore/http/html_directory_listing.js";
import type { DriverListOptions, ListResponse } from "#src/kvstore/index.js";
import { getS3UrlKind, listS3CompatibleUrl } from "#src/kvstore/s3/list.js";
import { joinBaseUrlAndPath } from "#src/kvstore/url.js";

export class HttpKvStore extends ReadableHttpKvStore<SharedKvStoreContext> {
  list(prefix: string, options: DriverListOptions): Promise<ListResponse> {
    const { memoize } = this.sharedKvStoreContext.chunkManager;
    const s3UrlKind = getS3UrlKind(memoize, this.baseUrlForDisplay);
    if (s3UrlKind === null) {
      return listFromHtmlDirectoryListing(
        this.baseUrl,
        prefix,
        this.fetchOkImpl,
        options,
      );
    }
    if (s3UrlKind !== undefined) {
      return listS3CompatibleUrl(
        joinBaseUrlAndPath(this.baseUrl, prefix),
        this.baseUrlForDisplay,
        memoize,
        this.fetchOkImpl,
        options,
      );
    }
    return Promise.any([
      listFromHtmlDirectoryListing(
        this.baseUrl,
        prefix,
        this.fetchOkImpl,
        options,
      ),
      listS3CompatibleUrl(
        joinBaseUrlAndPath(this.baseUrl, prefix),
        this.baseUrlForDisplay,
        memoize,
        this.fetchOkImpl,
        options,
      ),
    ]);
  }
}
