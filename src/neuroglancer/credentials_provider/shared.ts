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

import {CREDENTIALS_PROVIDER_RPC_ID, CREDENTIALS_PROVIDER_GET_RPC_ID} from 'neuroglancer/credentials_provider/shared_common';
import {CredentialsProvider, CredentialsWithGeneration} from 'neuroglancer/credentials_provider';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Owned} from 'neuroglancer/util/disposable';
import {registerPromiseRPC, registerSharedObjectOwner, RPC, RPCPromise, SharedObject} from 'neuroglancer/worker_rpc';

@registerSharedObjectOwner(CREDENTIALS_PROVIDER_RPC_ID)
export class SharedCredentialsProvider<Credentials> extends SharedObject implements
    CredentialsProvider<Credentials> {
  constructor(public provider: Owned<CredentialsProvider<Credentials>>, rpc: RPC) {
    super();
    this.registerDisposer(provider);
    this.initializeCounterpart(rpc);
  }

  get(invalidCredentials?: CredentialsWithGeneration<Credentials>,
      cancellationToken?: CancellationToken): Promise<CredentialsWithGeneration<Credentials>> {
    return this.provider.get(invalidCredentials, cancellationToken);
  }
}

registerPromiseRPC(
    CREDENTIALS_PROVIDER_GET_RPC_ID,
    function(
        this: RPC, x: {providerId: number, invalidCredentials: any}, cancellationToken: CancellationToken):
        RPCPromise<CredentialsWithGeneration<any>> {
          const obj = <SharedCredentialsProvider<any>>this.get(x.providerId);
          return obj.get(x.invalidCredentials, cancellationToken).then(credentials => ({
                                                                         value: credentials
                                                                       }));
        });
