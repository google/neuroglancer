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

import type { CredentialsManager } from "#src/credentials_provider/index.js";
import { AutoDetectRegistry } from "#src/kvstore/auto_detect.js";
import type {
  BaseKvStoreProvider,
  KvStoreAdapterProvider,
  KvStoreContext,
} from "#src/kvstore/context.js";
import type { StringMemoize } from "#src/util/memoize.js";
import type { RPC, RpcId } from "#src/worker_rpc.js";

export interface SharedKvStoreContextBase {
  kvStoreContext: KvStoreContext;
  credentialsManager: CredentialsManager;
  chunkManager: { memoize: StringMemoize };
  rpc: RPC | null;
  rpcId: RpcId | null;
}

export class KvStoreProviderRegistry<
  SharedKvStoreContext extends SharedKvStoreContextBase,
> {
  baseKvStoreProviders: Array<
    (context: SharedKvStoreContext) => BaseKvStoreProvider
  > = [];
  kvStoreAdapterProviders: Array<
    (context: SharedKvStoreContext) => KvStoreAdapterProvider
  > = [];
  autoDetectRegistry = new AutoDetectRegistry();

  registerBaseKvStoreProvider(
    provider: (context: SharedKvStoreContext) => BaseKvStoreProvider,
  ) {
    this.baseKvStoreProviders.push(provider);
  }

  registerKvStoreAdapterProvider(
    provider: (context: SharedKvStoreContext) => KvStoreAdapterProvider,
  ) {
    this.kvStoreAdapterProviders.push(provider);
  }

  applyToContext(context: SharedKvStoreContext) {
    const { kvStoreContext } = context;
    for (const key of [
      "baseKvStoreProviders",
      "kvStoreAdapterProviders",
    ] as const) {
      const map = kvStoreContext[key];
      for (const providerFactory of this[key]) {
        const provider = providerFactory(context);
        const { scheme } = provider;
        if (map.has(scheme)) {
          throw new Error(`Duplicate kvstore scheme ${scheme}`);
        }
        map.set(scheme, provider as any);
      }
    }
    this.autoDetectRegistry.copyTo(context.kvStoreContext.autoDetectRegistry);
  }
}

export const frontendBackendIsomorphicKvStoreProviderRegistry =
  new KvStoreProviderRegistry<SharedKvStoreContextBase>();
