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
 * @file Generic facility for providing authentication/authorization credentials.
 */

import {CancellationToken, MultipleConsumerCancellationTokenSource} from 'neuroglancer/util/cancellation';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';

/**
 * Wraps an arbitrary JSON credentials object with a generation number.
 *
 * The generation number is used for tracking whether the credentials have been updated/renewed.
 */
export interface CredentialsWithGeneration<T> {
  generation: number;
  credentials: T;
}

export abstract class CredentialsProvider<Credentials> extends RefCounted {
  /**
   * Request valid credentials.  If `invalidCredentials` is specified, it indicates that the
   * specified credentials are invalid.
   *
   * This method can be conveniently defined using the `makeCredentialsGetter` function.
   */
  abstract get:
      (invalidCredentials?: CredentialsWithGeneration<Credentials>,
       cancellationToken?: CancellationToken) => Promise<CredentialsWithGeneration<Credentials>>;
}

export function makeCachedCredentialsGetter<Credentials>(
    getUncached: (
        invalidCredentials: CredentialsWithGeneration<Credentials>|undefined,
        cancellationToken: CancellationToken) => Promise<CredentialsWithGeneration<Credentials>>) {
  let cachedCredentials: CredentialsWithGeneration<Credentials>|undefined;
  let pendingCredentials: Promise<CredentialsWithGeneration<Credentials>>|undefined;
  let pendingCancellationToken: MultipleConsumerCancellationTokenSource|undefined;
  return (invalidCredentials?: CredentialsWithGeneration<Credentials>,
          cancellationToken?: CancellationToken) => {
    if (pendingCredentials !== undefined &&
        (cachedCredentials === undefined || invalidCredentials === undefined ||
         cachedCredentials.generation !== invalidCredentials.generation)) {
      if (cachedCredentials === undefined) {
        pendingCancellationToken!.addConsumer(cancellationToken);
      }
      return pendingCredentials;
    }
    cachedCredentials = undefined;
    pendingCancellationToken = new MultipleConsumerCancellationTokenSource();
    pendingCredentials = getUncached(invalidCredentials, pendingCancellationToken)
                             .then(
                                 credentials => {
                                   cachedCredentials = credentials;
                                   pendingCancellationToken = undefined;
                                   return credentials;
                                 },
                                 reason => {
                                   if (pendingCancellationToken!.isCanceled) {
                                     pendingCancellationToken = undefined;
                                     pendingCredentials = undefined;
                                   }
                                   throw reason;
                                 });
    return pendingCredentials;
  };
}

export function makeCredentialsGetter<Credentials>(
    getWithoutGeneration: (cancellationToken: CancellationToken) => Promise<Credentials>) {
  let generation = 0;
  return makeCachedCredentialsGetter<Credentials>(
      (_invalidCredentials, cancellationToken) =>
          getWithoutGeneration(cancellationToken)
              .then(credentials => ({generation: ++generation, credentials})));
}

/**
 * Interface for obtaining a CredentialsProvider based on a string key.
 */
export interface CredentialsManager {
  getCredentialsProvider<Credentials>(key: string): Owned<CredentialsProvider<Credentials>>;
}

/**
 * CredentialsManager that supports registration.
 */
export class MapBasedCredentialsManager extends RefCounted implements CredentialsManager {
  providers = new Map<string, Owned<CredentialsProvider<any>>>();
  register<Credentials>(key: string, provider: Owned<CredentialsProvider<Credentials>>) {
    this.providers.set(key, this.registerDisposer(provider));
  }

  getCredentialsProvider<Credentials>(key: string): Owned<CredentialsProvider<Credentials>> {
    const value = this.providers.get(key);
    if (value === undefined) {
      throw new Error(`No registered credentials provider: ${JSON.stringify(key)}`);
    }
    return <CredentialsProvider<Credentials>>value.addRef();
  }
}
