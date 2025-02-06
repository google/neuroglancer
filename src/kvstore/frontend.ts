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
import type { CompletionResult } from "#src/kvstore/context.js";
import { KvStoreContext } from "#src/kvstore/context.js";
import type {
  DriverListOptions,
  DriverReadOptions,
  ListResponse,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import {
  frontendBackendIsomorphicKvStoreProviderRegistry,
  KvStoreProviderRegistry,
} from "#src/kvstore/register.js";
import {
  LIST_RPC_ID,
  READ_RPC_ID,
  SHARED_KVSTORE_CONTEXT_RPC_ID,
  STAT_RPC_ID,
  COMPLETE_URL_RPC_ID,
} from "#src/kvstore/shared_common.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
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

export function proxyStatToBackendKvStore(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: StatOptions,
): Promise<StatResponse | undefined> {
  return sharedKvStoreContext.rpc!.promiseInvoke<StatResponse | undefined>(
    STAT_RPC_ID,
    { sharedKvStoreContext: sharedKvStoreContext.rpcId, url },
    { signal: options.signal, progressListener: options.progressListener },
  );
}

export async function proxyReadToBackendKvStore(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: DriverReadOptions,
): Promise<ReadResponse | undefined> {
  const response = await sharedKvStoreContext.rpc!.promiseInvoke<
    | { data: ArrayBuffer; offset: number; totalSize: number | undefined }
    | undefined
  >(
    READ_RPC_ID,
    {
      sharedKvStoreContext: sharedKvStoreContext.rpcId,
      url,
      byteRange: options.byteRange,
      throwIfMissing: options.throwIfMissing,
    },
    { signal: options.signal, progressListener: options.progressListener },
  );
  if (response === undefined) return undefined;
  return {
    response: new Response(response.data),
    offset: response.offset,
    length: response.data.byteLength,
    totalSize: response.totalSize,
  };
}

export function proxyListToBackendKvStore(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: DriverListOptions,
): Promise<ListResponse> {
  return sharedKvStoreContext.rpc!.promiseInvoke<ListResponse>(
    LIST_RPC_ID,
    {
      sharedKvStoreContext: sharedKvStoreContext.rpcId,
      url,
    },
    { signal: options.signal, progressListener: options.progressListener },
  );
}

export function proxyCompleteUrlToBackendKvStore(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<CompletionResult> {
  return sharedKvStoreContext.rpc!.promiseInvoke<CompletionResult>(
    COMPLETE_URL_RPC_ID,
    {
      sharedKvStoreContext: sharedKvStoreContext.rpcId,
      url,
    },
    { signal: options.signal, progressListener: options.progressListener },
  );
}

export abstract class ProxyReadableKvStore<Key> {
  constructor(public sharedKvStoreContext: SharedKvStoreContext) {}

  abstract getUrl(key: Key): string;

  stat(key: Key, options: StatOptions): Promise<StatResponse | undefined> {
    return proxyStatToBackendKvStore(
      this.sharedKvStoreContext,
      this.getUrl(key),
      options,
    );
  }
  read(
    key: Key,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    return proxyReadToBackendKvStore(
      this.sharedKvStoreContext,
      this.getUrl(key),
      options,
    );
  }
}

export abstract class ProxyKvStore extends ProxyReadableKvStore<string> {
  list(prefix: string, options: DriverListOptions): Promise<ListResponse> {
    return proxyListToBackendKvStore(
      this.sharedKvStoreContext,
      this.getUrl(prefix),
      options,
    );
  }
}
