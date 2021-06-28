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
 * @file Implementation of a CredentialsProvider based on an input and output TrackableValue.
 */

import {AnonymousFirstCredentialsProvider, CredentialsManager, CredentialsProvider, CredentialsWithGeneration, makeCachedCredentialsGetter} from 'neuroglancer/credentials_provider';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {stableStringify} from 'neuroglancer/util/json';
import {Memoize} from 'neuroglancer/util/memoize';
import {PersistentCompoundTrackable} from 'neuroglancer/util/trackable';

class TrackableBasedCredentialsProvider<Credentials> extends CredentialsProvider<Credentials> {
  invalidCredentials = new TrackableValue<number|null|undefined>(undefined, x => x);
  validCredentials =
      new TrackableValue<CredentialsWithGeneration<Credentials>|undefined>(undefined, x => x);

  get =
      makeCachedCredentialsGetter((invalidCredentials?: CredentialsWithGeneration<Credentials>) => {
        return new Promise<CredentialsWithGeneration<Credentials>>(resolve => {
          const validCredentials = this.validCredentials.value;
          const invalidGeneration =
              invalidCredentials !== undefined ? invalidCredentials.generation : null;
          const isValidCredentials =
              (credentials: CredentialsWithGeneration<Credentials>|undefined) => {
                return credentials !== undefined && invalidGeneration !== credentials.generation;
              };
          if (isValidCredentials(validCredentials)) {
            resolve(validCredentials!);
            return;
          }
          this.invalidCredentials.value = invalidGeneration;
          let disposer: () => void;
          disposer = this.validCredentials.changed.add(() => {
            const newCredentials = this.validCredentials.value;
            if (isValidCredentials(newCredentials)) {
              disposer();
              resolve(newCredentials!);
            }
          });
        });
      });
}


class GcsCredentialsProvider extends AnonymousFirstCredentialsProvider<any> {
  constructor(baseProvider: CredentialsProvider<any>) {
    super(baseProvider, {accessToken: '', tokenType: ''});
  }
}

export class TrackableBasedCredentialsManager implements CredentialsManager {
  inputState = new PersistentCompoundTrackable();
  outputState = new PersistentCompoundTrackable();
  private memoize = new Memoize<string, CredentialsProvider<any>>();

  getCredentialsProvider<Credentials>(key: string, parameters?: any) {
    if (parameters === undefined) {
      parameters = null;
    }
    const combinedKey = stableStringify({key, parameters});
    return this.memoize.get(combinedKey, () => {
      const provider = new TrackableBasedCredentialsProvider<Credentials>();
      provider.registerDisposer(this.inputState.add(combinedKey, provider.validCredentials));
      provider.registerDisposer(this.outputState.add(combinedKey, provider.invalidCredentials));
      if (key === 'gcs') {
        return new GcsCredentialsProvider(provider);
      }
      return provider;
    });
  }
}
