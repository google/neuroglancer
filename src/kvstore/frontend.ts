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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { SharedCredentialsManager } from "#src/credentials_provider/shared.js";
import { KvStoreContext } from "#src/kvstore/context.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import {
  frontendBackendIsomorphicKvStoreProviderRegistry,
  KvStoreProviderRegistry,
} from "#src/kvstore/register.js";
import { SHARED_KVSTORE_CONTEXT_RPC_ID } from "#src/kvstore/shared_common.js";
import { registerSharedObjectOwner, SharedObject } from "#src/worker_rpc.js";

@registerSharedObjectOwner(SHARED_KVSTORE_CONTEXT_RPC_ID)
export class SharedKvStoreContext
  extends SharedObject
  implements SharedKvStoreContextBase
{
  kvStoreContext = new KvStoreContext();

  constructor(
    public chunkManager: ChunkManager,
    public credentialsManager: SharedCredentialsManager,
  ) {
    super();
    this.initializeCounterpart(chunkManager.rpc!, {
      chunkManager: chunkManager.rpcId,
      credentialsManager: credentialsManager.rpcId,
    });
    frontendBackendIsomorphicKvStoreProviderRegistry.applyToContext(this);
    frontendOnlyKvStoreProviderRegistry.applyToContext(this);
  }
}

export const frontendOnlyKvStoreProviderRegistry =
  new KvStoreProviderRegistry<SharedKvStoreContext>();
