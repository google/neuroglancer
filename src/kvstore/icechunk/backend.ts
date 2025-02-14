/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { getListResponseFromSnapshot } from "#src/kvstore/icechunk/list.js";
import {
  resolveRefSpec,
  getSnapshot,
} from "#src/kvstore/icechunk/metadata_cache.js";
import { read, stat } from "#src/kvstore/icechunk/read.js";
import type { Snapshot } from "#src/kvstore/icechunk/snapshot.js";
import type { RefSpec } from "#src/kvstore/icechunk/url.js";
import { getIcechunkUrl } from "#src/kvstore/icechunk/url.js";
import type {
  DriverListOptions,
  DriverReadOptions,
  KvStore,
  ListResponse,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

export class IcechunkKvStore implements KvStore {
  constructor(
    public sharedKvStoreContext: SharedKvStoreContextCounterpart,
    public baseUrl: string,
    public refSpec: RefSpec | undefined,
  ) {}

  private snapshot: Snapshot | undefined;

  private async getSnapshot(options: Partial<ProgressOptions>) {
    let { snapshot } = this;
    if (snapshot === undefined) {
      const snapshotId = await resolveRefSpec(
        this.sharedKvStoreContext,
        this.baseUrl,
        this.refSpec ?? { branch: "main" },
        options,
      );
      snapshot = this.snapshot = await getSnapshot(
        this.sharedKvStoreContext,
        this.baseUrl,
        snapshotId,
        options,
      );
    }
    return snapshot;
  }

  getUrl(key: string) {
    return getIcechunkUrl(this, key);
  }

  async stat(
    key: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const snapshot = await this.getSnapshot(options);
    return stat(
      this.sharedKvStoreContext,
      this.baseUrl,
      snapshot,
      key,
      options,
    );
  }

  async read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const snapshot = await this.getSnapshot(options);
    return read(
      this.sharedKvStoreContext,
      this.baseUrl,
      snapshot,
      key,
      options,
    );
  }

  async list(
    prefix: string,
    options: DriverListOptions,
  ): Promise<ListResponse> {
    const snapshot = await this.getSnapshot(options);
    return getListResponseFromSnapshot(snapshot, prefix);
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}
