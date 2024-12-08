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
  CredentialsProvider,
  CredentialsWithGeneration,
} from "#src/credentials_provider/index.js";
import {
  CREDENTIALS_PROVIDER_RPC_ID,
  CREDENTIALS_PROVIDER_GET_RPC_ID,
} from "#src/credentials_provider/shared_common.js";
import type { Owned } from "#src/util/disposable.js";
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
    abortSignal?: AbortSignal,
  ): Promise<CredentialsWithGeneration<Credentials>> {
    return this.provider.get(invalidCredentials, abortSignal);
  }
}

registerPromiseRPC(
  CREDENTIALS_PROVIDER_GET_RPC_ID,
  function (
    this: RPC,
    x: { providerId: number; invalidCredentials: any },
    abortSignal: AbortSignal,
  ): RPCPromise<CredentialsWithGeneration<any>> {
    const obj = <SharedCredentialsProvider<any>>this.get(x.providerId);
    return obj.get(x.invalidCredentials, abortSignal).then((credentials) => ({
      value: credentials,
    }));
  },
);
