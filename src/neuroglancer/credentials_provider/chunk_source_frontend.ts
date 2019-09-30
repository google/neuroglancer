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

import {ChunkManager, ChunkSourceConstructor} from 'neuroglancer/chunk_manager/frontend';
import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {SharedCredentialsProvider} from 'neuroglancer/credentials_provider/shared';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {getObjectId} from 'neuroglancer/util/object_id';
import {RPC, SharedObject} from 'neuroglancer/worker_rpc';

/**
 * Returns a counterpart ref to be sent to the backend to retrieve a
 * SharedCredentialsProviderCounterpart that forwards to `credentialsProvider`.
 */
export function getCredentialsProviderCounterpart<Credentials>(
    chunkManager: ChunkManager, credentialsProvider: Borrowed<CredentialsProvider<Credentials>>) {
  const sharedCredentialsProvider = chunkManager.memoize.get(
      {type: 'getSharedCredentialsProvider', credentialsProvider: getObjectId(credentialsProvider)},
      () => new SharedCredentialsProvider(credentialsProvider.addRef(), chunkManager.rpc!));
  const counterpartRef = sharedCredentialsProvider.addCounterpartRef();
  sharedCredentialsProvider.dispose();
  return counterpartRef;
}

/**
 * Mixin for adding a credentialsProvider member to a ChunkSource.
 */
export function WithCredentialsProvider<Credentials>() {
  return function<BaseOptions, TBase extends ChunkSourceConstructor<
                      BaseOptions, SharedObject&{chunkManager: ChunkManager}>>(Base: TBase) {
    type Options = BaseOptions&{credentialsProvider: Borrowed<CredentialsProvider<Credentials>>};
    return class extends Base {
      credentialsProvider: Owned<CredentialsProvider<Credentials>>;
      constructor(...args: any[]) {
        super(...args);
        const options: Options = args[1];
        this.credentialsProvider = options.credentialsProvider.addRef();
      }
      initializeCounterpart(rpc: RPC, options: any) {
        options['credentialsProvider'] =
            getCredentialsProviderCounterpart(this.chunkManager, this.credentialsProvider);
        super.initializeCounterpart(rpc, options);
      }
      static encodeOptions(options: Options) {
        const encoding = super.encodeOptions(options);
        encoding.credentialsProvider = getObjectId(options.credentialsProvider);
        return encoding;
      }
    };
  };
}
