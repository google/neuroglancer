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
 * @file Defines a CredentialsProvider that forwards requests to a SharedCredentialsProvider on
 * another thread.
 */

import type {
  CredentialsManager,
  CredentialsWithGeneration,
  MaybeOptionalCredentialsProvider,
} from "#src/credentials_provider/index.js";
import {
  CachingCredentialsManager,
  makeCachedCredentialsGetter,
  CredentialsProvider,
} from "#src/credentials_provider/index.js";
import {
  CREDENTIALS_MANAGER_GET_RPC_ID,
  CREDENTIALS_MANAGER_RPC_ID,
  CREDENTIALS_PROVIDER_GET_RPC_ID,
  CREDENTIALS_PROVIDER_RPC_ID,
} from "#src/credentials_provider/shared_common.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

@registerSharedObject(CREDENTIALS_PROVIDER_RPC_ID)
export class SharedCredentialsProviderCounterpart<Credentials>
  extends SharedObjectCounterpart
  implements CredentialsProvider<Credentials>
{
  get = makeCachedCredentialsGetter(
    (
      invalidCredentials: CredentialsWithGeneration<Credentials> | undefined,
      options: ProgressOptions,
    ): Promise<CredentialsWithGeneration<Credentials>> =>
      this.rpc!.promiseInvoke(
        CREDENTIALS_PROVIDER_GET_RPC_ID,
        { providerId: this.rpcId, invalidCredentials: invalidCredentials },
        { signal: options.signal, progressListener: options.progressListener },
      ),
  );
}

export function WithSharedCredentialsProviderCounterpart<Credentials>() {
  return <TBase extends { new (...args: any[]): SharedObjectCounterpart }>(
    Base: TBase,
  ) =>
    class extends Base {
      credentialsProvider: MaybeOptionalCredentialsProvider<Credentials>;
      constructor(...args: any[]) {
        super(...args);
        const options = args[1];
        this.credentialsProvider = this.rpc!.getOptionalRef<
          SharedCredentialsProviderCounterpart<Exclude<Credentials, undefined>>
        >(options.credentialsProvider) as any;
      }
    };
}

class ProxyCredentialsProvider<
  Credentials,
> extends CredentialsProvider<Credentials> {
  constructor(
    public rpc: RPC,
    public managerId: number,
    public key: string,
    public parameters?: any,
  ) {
    super();
  }
  get = makeCachedCredentialsGetter(
    (
      invalidCredentials: CredentialsWithGeneration<Credentials> | undefined,
      options: ProgressOptions,
    ): Promise<CredentialsWithGeneration<Credentials>> =>
      this.rpc.promiseInvoke(
        CREDENTIALS_MANAGER_GET_RPC_ID,
        {
          managerId: this.managerId,
          key: this.key,
          parameters: this.parameters,
          invalidCredentials: invalidCredentials,
        },
        { signal: options.signal, progressListener: options.progressListener },
      ),
  );
}

@registerSharedObject(CREDENTIALS_MANAGER_RPC_ID)
export class SharedCredentialsManagerCounterpart
  extends SharedObjectCounterpart
  implements CredentialsManager
{
  private impl: CachingCredentialsManager<CredentialsManager> =
    new CachingCredentialsManager(this.makeBaseCredentialsManager());

  private makeBaseCredentialsManager(): CredentialsManager {
    return {
      getCredentialsProvider: <Credentials>(key: string, parameters?: any) =>
        new ProxyCredentialsProvider<Credentials>(
          this.rpc!,
          this.rpcId!,
          key,
          parameters,
        ),
    };
  }

  getCredentialsProvider<Credentials>(key: string, parameters?: any) {
    return this.impl.getCredentialsProvider<Credentials>(key, parameters);
  }
}
