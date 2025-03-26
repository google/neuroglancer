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
 * @file Permits a CredentialsProvider to be shared with another thread.
 */

import type {
  CredentialsManager,
  CredentialsProvider,
  CredentialsWithGeneration,
} from "#src/credentials_provider/index.js";
import {
  CREDENTIALS_PROVIDER_RPC_ID,
  CREDENTIALS_PROVIDER_GET_RPC_ID,
  CREDENTIALS_MANAGER_RPC_ID,
  CREDENTIALS_MANAGER_GET_RPC_ID,
} from "#src/credentials_provider/shared_common.js";
import type { Owned } from "#src/util/disposable.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import type { RPC, RPCPromise } from "#src/worker_rpc.js";
import {
  registerPromiseRPC,
  registerSharedObjectOwner,
  SharedObject,
} from "#src/worker_rpc.js";

@registerSharedObjectOwner(CREDENTIALS_PROVIDER_RPC_ID)
export class SharedCredentialsProvider<Credentials>
  extends SharedObject
  implements CredentialsProvider<Credentials>
{
  constructor(
    public provider: Owned<CredentialsProvider<Credentials>>,
    rpc: RPC,
  ) {
    super();
    this.registerDisposer(provider);
    this.initializeCounterpart(rpc);
  }

  get(
    invalidCredentials?: CredentialsWithGeneration<Credentials>,
    options?: Partial<ProgressOptions>,
  ): Promise<CredentialsWithGeneration<Credentials>> {
    return this.provider.get(invalidCredentials, options);
  }
}

registerPromiseRPC(
  CREDENTIALS_PROVIDER_GET_RPC_ID,
  function (
    this: RPC,
    x: { providerId: number; invalidCredentials: any },
    progressOptions,
  ): RPCPromise<CredentialsWithGeneration<any>> {
    const obj = <SharedCredentialsProvider<any>>this.get(x.providerId);
    return obj
      .get(x.invalidCredentials, progressOptions)
      .then((credentials) => ({
        value: credentials,
      }));
  },
);

@registerSharedObjectOwner(CREDENTIALS_MANAGER_RPC_ID)
export class SharedCredentialsManager
  extends SharedObject
  implements CredentialsManager
{
  constructor(
    public base: CredentialsManager,
    rpc: RPC,
  ) {
    super();
    this.initializeCounterpart(rpc);
  }

  getCredentialsProvider<Credentials>(key: string, parameters?: any) {
    return this.base.getCredentialsProvider<Credentials>(key, parameters);
  }
}

registerPromiseRPC(
  CREDENTIALS_MANAGER_GET_RPC_ID,
  async function (
    this: RPC,
    x: {
      managerId: number;
      key: string;
      parameters: any;
      invalidCredentials: any;
    },
    progressOptions,
  ): RPCPromise<CredentialsWithGeneration<any>> {
    const manager = this.get(x.managerId) as SharedCredentialsManager;
    const provider = manager.base.getCredentialsProvider(x.key, x.parameters);
    const credentials = await provider.get(
      x.invalidCredentials,
      progressOptions,
    );
    return { value: credentials };
  },
);
