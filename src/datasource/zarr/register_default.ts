/**
 * @license
 * Copyright 2020 Google Inc.
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

import {
  registerKvStoreBasedDataProvider,
  dataSourceAutoDetectRegistry,
  registerProvider,
} from "#src/datasource/default_provider.js";
import { KvStoreBasedDataSourceLegacyUrlAdapter } from "#src/datasource/index.js";
import {
  ZarrDataSource,
  registerAutoDetectV2,
  registerAutoDetectV3,
} from "#src/datasource/zarr/frontend.js";

for (const provider of [
  new ZarrDataSource(),
  new ZarrDataSource(2),
  new ZarrDataSource(3),
]) {
  registerKvStoreBasedDataProvider(provider);
  registerProvider(new KvStoreBasedDataSourceLegacyUrlAdapter(provider));
}
registerAutoDetectV2(dataSourceAutoDetectRegistry);
registerAutoDetectV3(dataSourceAutoDetectRegistry);
