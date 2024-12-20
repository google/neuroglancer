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

import type { ChunkManager } from "#src/chunk_manager/backend.js";
import type { SharedCredentialsManagerCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import { KvStoreContext } from "#src/kvstore/context.js";
import {
  frontendBackendIsomorphicKvStoreProviderRegistry,
  KvStoreProviderRegistry,
} from "#src/kvstore/register.js";
import {
  LIST_RPC_ID,
  READ_RPC_ID,
  SHARED_KVSTORE_CONTEXT_RPC_ID,
  STAT_RPC_ID,
} from "#src/kvstore/shared_common.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerPromiseRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";
import type { ByteRange } from ".";

@registerSharedObject(SHARED_KVSTORE_CONTEXT_RPC_ID)
export class SharedKvStoreContextCounterpart extends SharedObjectCounterpart {
  kvStoreContext: KvStoreContext;

  chunkManager: ChunkManager;
  credentialsManager: SharedCredentialsManagerCounterpart;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.chunkManager = rpc.get(options.chunkManager) as ChunkManager;
    this.credentialsManager = rpc.get(
      options.credentialsManager,
    ) as SharedCredentialsManagerCounterpart;
    this.kvStoreContext = new KvStoreContext();
    frontendBackendIsomorphicKvStoreProviderRegistry.applyToContext(this);
    backendOnlyKvStoreProviderRegistry.applyToContext(this);
  }
}

export const backendOnlyKvStoreProviderRegistry =
  new KvStoreProviderRegistry<SharedKvStoreContextCounterpart>();

export function WithSharedKvStoreContextCounterpart<
  TBase extends { new (...args: any[]): SharedObjectCounterpart },
>(Base: TBase) {
  return class extends Base {
    sharedKvStoreContext: SharedKvStoreContextCounterpart;
    constructor(...args: any[]) {
      super(...args);
      const options = args[1];
      this.sharedKvStoreContext = this.rpc!.get(options.sharedKvStoreContext);
    }
  };
}

registerPromiseRPC(
  STAT_RPC_ID,
  async function (
    this: RPC,
    options: { sharedKvStoreContext: number; url: string },
    progressOptions,
  ) {
    const sharedKvStoreContext: SharedKvStoreContextCounterpart = this.get(
      options.sharedKvStoreContext,
    );
    return {
      value: await sharedKvStoreContext.kvStoreContext.stat(
        options.url,
        progressOptions,
      ),
    };
  },
);

registerPromiseRPC(
  READ_RPC_ID,
  async function (
    this: RPC,
    options: {
      sharedKvStoreContext: number;
      url: string;
      byteRange?: ByteRange;
      throwIfMissing?: boolean;
    },
    progressOptions,
  ) {
    const sharedKvStoreContext: SharedKvStoreContextCounterpart = this.get(
      options.sharedKvStoreContext,
    );
    const readResponse = await sharedKvStoreContext.kvStoreContext.read(
      options.url,
      {
        ...progressOptions,
        byteRange: options.byteRange,
        throwIfMissing: options.throwIfMissing,
      },
    );
    if (readResponse === undefined) {
      return { value: undefined };
    }
    const arrayBuffer = await readResponse.response.arrayBuffer();
    return {
      value: {
        data: arrayBuffer,
        offset: readResponse.offset,
        totalSize: readResponse.totalSize,
      },
      transfers: [arrayBuffer],
    };
  },
);

registerPromiseRPC(
  LIST_RPC_ID,
  async function (
    this: RPC,
    options: { sharedKvStoreContext: number; url: string },
    progressOptions,
  ) {
    const sharedKvStoreContext: SharedKvStoreContextCounterpart = this.get(
      options.sharedKvStoreContext,
    );
    const { store, path } = sharedKvStoreContext.kvStoreContext.getKvStore(
      options.url,
    );
    return {
      value: await store.list!(path, progressOptions),
    };
  },
);
