/**
 * @license
 * Copyright 2024 Google Inc.
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

import { getDefaultDataSourceProvider } from "#src/datasource/default_provider.js";
import { type DataSourceRegistry } from "#src/datasource/index.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { fixture, type Fixture } from "#tests/fixtures/fixture.js";
import { sharedKvStoreContextFixture } from "./shared_kvstore_context";

export function dataSourceProviderFixture(
  sharedKvStoreContext: Fixture<SharedKvStoreContext> = sharedKvStoreContextFixture(),
): Fixture<DataSourceRegistry> {
  return fixture(async (stack) => {
    const kvStoreContext = await sharedKvStoreContext();
    const provider = getDefaultDataSourceProvider({
      kvStoreContext,
      credentialsManager: kvStoreContext.credentialsManager,
    });
    stack.defer(() => provider.dispose());
    return provider;
  });
}
