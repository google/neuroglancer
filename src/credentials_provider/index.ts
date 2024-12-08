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

import { raceWithAbort, SharedAbortController } from "#src/util/abort.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { StringMemoize } from "#src/util/memoize.js";

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
  abstract get: (
    invalidCredentials?: CredentialsWithGeneration<Credentials>,
    abortSignal?: AbortSignal | undefined,
  ) => Promise<CredentialsWithGeneration<Credentials>>;
}

export function makeCachedCredentialsGetter<Credentials>(
  getUncached: (
    invalidCredentials: CredentialsWithGeneration<Credentials> | undefined,
    abortSignal: AbortSignal,
  ) => Promise<CredentialsWithGeneration<Credentials>>,
) {
  let cachedCredentials: CredentialsWithGeneration<Credentials> | undefined;
  let pendingCredentials:
    | Promise<CredentialsWithGeneration<Credentials>>
    | undefined;
  let pendingAbortController: SharedAbortController | undefined;
  return (
    invalidCredentials?: CredentialsWithGeneration<Credentials>,
    abortSignal?: AbortSignal,
  ) => {
    if (
      pendingCredentials !== undefined &&
      (cachedCredentials === undefined ||
        invalidCredentials === undefined ||
        cachedCredentials.generation !== invalidCredentials.generation)
    ) {
      if (cachedCredentials === undefined) {
        pendingAbortController!.addConsumer(abortSignal);
      }
      return raceWithAbort(pendingCredentials, abortSignal);
    }
    cachedCredentials = undefined;
    pendingAbortController = new SharedAbortController();
    pendingCredentials = getUncached(
      invalidCredentials,
      pendingAbortController.signal,
    ).then(
      (credentials) => {
        cachedCredentials = credentials;
        pendingAbortController![Symbol.dispose]();
        pendingAbortController = undefined;
        return credentials;
      },
      (reason) => {
        pendingAbortController![Symbol.dispose]();
        if (pendingAbortController?.signal.aborted) {
          pendingAbortController = undefined;
          pendingCredentials = undefined;
        }
        throw reason;
      },
    );
    return pendingCredentials;
  };
}

export function makeCredentialsGetter<Credentials>(
  getWithoutGeneration: (abortSignal: AbortSignal) => Promise<Credentials>,
) {
  let generation = 0;
  return makeCachedCredentialsGetter<Credentials>(
    (_invalidCredentials, abortSignal) =>
      getWithoutGeneration(abortSignal).then((credentials) => ({
        generation: ++generation,
        credentials,
      })),
  );
}

/**
 * Interface for obtaining a CredentialsProvider based on a string key.
 */
export interface CredentialsManager {
  getCredentialsProvider<Credentials>(
    key: string,
    parameters?: any,
  ): Owned<CredentialsProvider<Credentials>>;
}

export type ProviderGetter<Credentials> = (
  parameters: any,
  credentialsManager: CredentialsManager,
) => Owned<CredentialsProvider<Credentials>>;

/**
 * CredentialsManager that supports registration.
 */
export class MapBasedCredentialsManager implements CredentialsManager {
  providers = new Map<
    string,
    (
      parameters: any,
      credentialsManager: CredentialsManager,
    ) => Owned<CredentialsProvider<any>>
  >();
  topLevelManager: CredentialsManager = this;
  register<Credentials>(
    key: string,
    providerGetter: ProviderGetter<Credentials>,
  ) {
    this.providers.set(key, providerGetter);
  }

  getCredentialsProvider<Credentials>(
    key: string,
    parameters?: any,
  ): Owned<CredentialsProvider<Credentials>> {
    const getter = this.providers.get(key);
    if (getter === undefined) {
      throw new Error(
        `No registered credentials provider: ${JSON.stringify(key)}`,
      );
    }
    return getter(parameters, this.topLevelManager);
  }
}

/**
 * CredentialsManager that wraps another and caches the CredentialsProvider objects.
 */
export class CachingCredentialsManager<Base extends CredentialsManager>
  extends RefCounted
  implements CredentialsManager
{
  memoize = new StringMemoize();

  constructor(public base: Base) {
    super();
  }

  getCredentialsProvider<Credentials>(
    key: string,
    parameters?: any,
  ): Owned<CredentialsProvider<Credentials>> {
    return this.memoize.get({ key, parameters }, () =>
      this.registerDisposer(
        this.base.getCredentialsProvider<Credentials>(key, parameters).addRef(),
      ),
    );
  }
}

export class CachingMapBasedCredentialsManager extends CachingCredentialsManager<MapBasedCredentialsManager> {
  constructor() {
    super(new MapBasedCredentialsManager());
    this.base.topLevelManager = this;
  }

  register<Credentials>(
    key: string,
    providerGetter: ProviderGetter<Credentials>,
  ) {
    this.base.register(key, providerGetter);
  }
}

export type MaybeOptionalCredentialsProvider<T> = T extends undefined
  ? undefined
  : CredentialsProvider<Exclude<T, undefined>>;

export class AnonymousFirstCredentialsProvider<
  T,
> extends CredentialsProvider<T> {
  private anonymous = true;
  constructor(
    private baseProvider: CredentialsProvider<T>,
    private anonymousCredentials: T,
  ) {
    super();
  }

  get = makeCachedCredentialsGetter(
    (invalidCredentials?: CredentialsWithGeneration<T>) => {
      if (this.anonymous && invalidCredentials === undefined) {
        return Promise.resolve({
          generation: -10,
          credentials: this.anonymousCredentials,
        });
      }
      this.anonymous = false;
      return this.baseProvider.get(invalidCredentials);
    },
  );
}
