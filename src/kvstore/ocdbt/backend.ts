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

import "#src/kvstore/proxy.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type {
  DriverListOptions,
  DriverReadOptions,
  KvStore,
  ListResponse,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import type { Key } from "#src/kvstore/ocdbt/key.js";
import { listRoot } from "#src/kvstore/ocdbt/list.js";
import {
  findEntryInRoot,
  readFromLeafNodeEntry,
} from "#src/kvstore/ocdbt/read.js";
import { getRoot } from "#src/kvstore/ocdbt/read_version.js";
import { getOcdbtUrl } from "#src/kvstore/ocdbt/url.js";
import { type VersionSpecifier } from "#src/kvstore/ocdbt/version_specifier.js";
import type { BtreeGenerationReference } from "#src/kvstore/ocdbt/version_tree.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

export class OcdbtKvStore implements KvStore {
  constructor(
    public sharedKvStoreContext: SharedKvStoreContextCounterpart,
    public baseUrl: string,
    public version: VersionSpecifier | undefined,
  ) {}

  private root: BtreeGenerationReference | undefined;

  private async getRoot(options: Partial<ProgressOptions>) {
    let { root } = this;
    if (root === undefined) {
      root = this.root = await getRoot(
        this.sharedKvStoreContext,
        this.baseUrl,
        this.version,
        options,
      );
    }
    return root;
  }

  getUrl(key: string) {
    return getOcdbtUrl(this, key);
  }

  async stat(
    key: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const root = await this.getRoot(options);
    const encodedKey = new TextEncoder().encode(key) as Key;
    const entry = await findEntryInRoot(
      this.sharedKvStoreContext,
      root,
      encodedKey,
      options,
    );
    if (entry === undefined) return undefined;
    const { value } = entry;
    const totalSize = Number(value.length);
    return { totalSize };
  }

  async read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const root = await this.getRoot(options);
    const encodedKey = new TextEncoder().encode(key) as Key;
    const entry = await findEntryInRoot(
      this.sharedKvStoreContext,
      root,
      encodedKey,
      options,
    );
    if (entry === undefined) return undefined;
    return await readFromLeafNodeEntry(
      this.sharedKvStoreContext,
      entry,
      options,
    );
  }

  async list(
    prefix: string,
    options: DriverListOptions,
  ): Promise<ListResponse> {
    const root = await this.getRoot(options);
    const encodedPrefix = new TextEncoder().encode(prefix) as Key;
    return await listRoot(
      this.sharedKvStoreContext,
      root,
      encodedPrefix,
      options,
    );
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}
