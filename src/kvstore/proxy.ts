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

import type { CompletionResult } from "#src/kvstore/context.js";
import type {
  ByteRange,
  DriverListOptions,
  DriverReadOptions,
  ListResponse,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import type { SharedKvStoreContextBase } from "#src/kvstore/register.js";
import {
  LIST_RPC_ID,
  READ_RPC_ID,
  STAT_RPC_ID,
  COMPLETE_URL_RPC_ID,
} from "#src/kvstore/shared_common.js";
import {
  finalPipelineUrlComponent,
  parsePipelineUrlComponent,
} from "#src/kvstore/url.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

export function proxyStat(
  sharedKvStoreContext: SharedKvStoreContextBase,
  url: string,
  options: StatOptions,
): Promise<StatResponse | undefined> {
  return sharedKvStoreContext.rpc!.promiseInvoke<StatResponse | undefined>(
    STAT_RPC_ID,
    { sharedKvStoreContext: sharedKvStoreContext.rpcId, url },
    { signal: options.signal, progressListener: options.progressListener },
  );
}

registerPromiseRPC(
  STAT_RPC_ID,
  async function (
    this: RPC,
    options: { sharedKvStoreContext: number; url: string },
    progressOptions,
  ) {
    const sharedKvStoreContext: SharedKvStoreContextBase = this.get(
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

export async function proxyRead(
  sharedKvStoreContext: SharedKvStoreContextBase,
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
    const sharedKvStoreContext: SharedKvStoreContextBase = this.get(
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

export function proxyList(
  sharedKvStoreContext: SharedKvStoreContextBase,
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

registerPromiseRPC(
  LIST_RPC_ID,
  async function (
    this: RPC,
    options: { sharedKvStoreContext: number; url: string },
    progressOptions,
  ) {
    const sharedKvStoreContext: SharedKvStoreContextBase = this.get(
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

export function proxyCompleteUrl(
  sharedKvStoreContext: SharedKvStoreContextBase,
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

registerPromiseRPC(
  COMPLETE_URL_RPC_ID,
  async function (
    this: RPC,
    options: { sharedKvStoreContext: number; url: string },
    progressOptions,
  ) {
    const sharedKvStoreContext: SharedKvStoreContextBase = this.get(
      options.sharedKvStoreContext,
    );
    const { kvStoreContext } = sharedKvStoreContext;
    const { url } = options;
    const finalComponent = finalPipelineUrlComponent(url);
    let result: CompletionResult | undefined;
    if (finalComponent === url) {
      // Base kvstore
      const parsedUrl = parsePipelineUrlComponent(finalComponent);
      const provider = kvStoreContext.getBaseKvStoreProvider(parsedUrl);
      if (provider.completeUrl !== undefined) {
        result = await provider.completeUrl({
          url: parsedUrl,
          ...progressOptions,
        });
      }
    } else {
      const adapterUrl = parsePipelineUrlComponent(finalComponent);
      const provider = kvStoreContext.getKvStoreAdapterProvider(adapterUrl);
      const baseUrl = url.slice(0, url.length - finalComponent.length - 1);
      const base = kvStoreContext.getKvStore(baseUrl);
      if (provider.completeUrl !== undefined) {
        result = await provider.completeUrl({
          url: adapterUrl,
          base,
          ...progressOptions,
        });
      }
    }
    return {
      value: result,
    };
  },
);

export abstract class ProxyReadableKvStore<Key> {
  constructor(public sharedKvStoreContext: SharedKvStoreContextBase) {}

  abstract getUrl(key: Key): string;

  stat(key: Key, options: StatOptions): Promise<StatResponse | undefined> {
    return proxyStat(this.sharedKvStoreContext, this.getUrl(key), options);
  }
  read(
    key: Key,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    return proxyRead(this.sharedKvStoreContext, this.getUrl(key), options);
  }
}

export abstract class ProxyKvStore extends ProxyReadableKvStore<string> {
  list(prefix: string, options: DriverListOptions): Promise<ListResponse> {
    return proxyList(this.sharedKvStoreContext, this.getUrl(prefix), options);
  }
}
