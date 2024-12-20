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

import type { SharedCredentialsManager } from "#src/credentials_provider/shared.js";
import type {
  DataSourceProvider,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import { DataSourceRegistry } from "#src/datasource/index.js";
import { LocalDataSourceProvider } from "#src/datasource/local.js";
import { AutoDetectRegistry } from "#src/kvstore/auto_detect.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";

export interface ProviderOptions {
  credentialsManager: SharedCredentialsManager;
  kvStoreContext: SharedKvStoreContext;
}

const providers: DataSourceProvider[] = [];
const kvStoreBasedProviders: KvStoreBasedDataSourceProvider[] = [];
export const dataSourceAutoDetectRegistry = new AutoDetectRegistry();

export function registerProvider(provider: DataSourceProvider) {
  providers.push(provider);
}

export function registerKvStoreBasedDataProvider(
  provider: KvStoreBasedDataSourceProvider,
) {
  kvStoreBasedProviders.push(provider);
}

export function getDefaultDataSourceProvider(options: ProviderOptions) {
  const registry = new DataSourceRegistry(options.kvStoreContext);
  registry.register(new LocalDataSourceProvider());
  for (const provider of providers) {
    registry.register(provider);
  }
  for (const provider of kvStoreBasedProviders) {
    registry.registerKvStoreBasedProvider(provider);
  }
  options.kvStoreContext.kvStoreContext.autoDetectRegistry.copyTo(
    registry.autoDetectRegistry,
  );
  dataSourceAutoDetectRegistry.copyTo(registry.autoDetectRegistry);
  return registry;
}
