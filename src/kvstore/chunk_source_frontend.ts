/**
 * @license
 * Copyright 2017 Google Inc.
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

/**
 * @file Facilities to simplify defining subclasses of ChunkSource that use a CredentialsProvider.
 */

import type {
  ChunkManager,
  ChunkSourceConstructor,
  GettableChunkSource,
} from "#src/chunk_manager/frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import type { RPC } from "#src/worker_rpc.js";

/**
 * Mixin for adding a credentialsProvider member to a ChunkSource.
 */
export function WithSharedKvStoreContext<
  TBase extends ChunkSourceConstructor<
    GettableChunkSource & { chunkManager: ChunkManager }
  >,
>(Base: TBase) {
  type WithSharedKvStoreContextOptions = InstanceType<TBase>["OPTIONS"] & {
    sharedKvStoreContext: SharedKvStoreContext;
  };
  class C extends Base {
    sharedKvStoreContext: SharedKvStoreContext;
    declare OPTIONS: WithSharedKvStoreContextOptions;
    constructor(...args: any[]) {
      super(...args);
      const options: WithSharedKvStoreContextOptions = args[1];
      this.sharedKvStoreContext = options.sharedKvStoreContext.addRef();
    }
    initializeCounterpart(rpc: RPC, options: any) {
      const { sharedKvStoreContext } = this;
      options.sharedKvStoreContext = sharedKvStoreContext.rpcId;
      super.initializeCounterpart(rpc, options);
    }
  }
  return C;
}
