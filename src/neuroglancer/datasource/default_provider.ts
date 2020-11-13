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
 * @file Facility for registering default data sources.
 */

import {CredentialsManager} from 'neuroglancer/credentials_provider';
import {DataSourceProvider, DataSourceProviderRegistry} from 'neuroglancer/datasource';
import {Owned} from 'neuroglancer/util/disposable';

export interface ProviderOptions {
  credentialsManager: CredentialsManager;
}

export type ProviderFactory = (options: ProviderOptions) => Owned<DataSourceProvider>;
const providerFactories = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory) {
  providerFactories.set(name, factory);
}

export function getDefaultDataSourceProvider(options: ProviderOptions) {
  const provider = new DataSourceProviderRegistry(options.credentialsManager);
  for (const [name, factory] of providerFactories) {
    provider.register(name, factory(options));
  }
  return provider;
}
