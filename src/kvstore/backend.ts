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

import "#src/credentials_provider/shared_counterpart.js";
import type { ChunkManager } from "#src/chunk_manager/backend.js";
import type { SharedCredentialsManagerCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import { KvStoreContext } from "#src/kvstore/context.js";
import {
  frontendBackendIsomorphicKvStoreProviderRegistry,
  KvStoreProviderRegistry,
} from "#src/kvstore/register.js";
import { SHARED_KVSTORE_CONTEXT_RPC_ID } from "#src/kvstore/shared_common.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

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
