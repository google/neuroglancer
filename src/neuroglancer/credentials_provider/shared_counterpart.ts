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

import {CredentialsProvider, CredentialsWithGeneration, makeCachedCredentialsGetter, MaybeOptionalCredentialsProvider} from 'neuroglancer/credentials_provider';
import {CREDENTIALS_PROVIDER_GET_RPC_ID, CREDENTIALS_PROVIDER_RPC_ID} from 'neuroglancer/credentials_provider/shared_common';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {registerSharedObject, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';


@registerSharedObject(CREDENTIALS_PROVIDER_RPC_ID)
export class SharedCredentialsProviderCounterpart<Credentials> extends SharedObjectCounterpart
    implements CredentialsProvider<Credentials> {
  get = makeCachedCredentialsGetter(
      (invalidCredentials?: CredentialsWithGeneration<Credentials>,
       cancellationToken?: CancellationToken) =>
          this.rpc!.promiseInvoke(
              CREDENTIALS_PROVIDER_GET_RPC_ID,
              {providerId: this.rpcId, invalidCredentials: invalidCredentials}, cancellationToken));
}

export function WithSharedCredentialsProviderCounterpart<Credentials>() {
  return function<TBase extends{new (...args: any[]): SharedObjectCounterpart}>(Base: TBase) {
    return class extends Base {
      credentialsProvider: MaybeOptionalCredentialsProvider<Credentials>;
      constructor(...args: any[]) {
        super(...args);
        const options = args[1];
        this.credentialsProvider =
            this.rpc!.getOptionalRef<
                SharedCredentialsProviderCounterpart<Exclude<Credentials, undefined>>>(
                options['credentialsProvider']) as any;
      }
    };
  };
}
