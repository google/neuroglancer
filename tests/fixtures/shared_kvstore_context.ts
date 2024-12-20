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

import { getDefaultCredentialsManager } from "#src/credentials_provider/default_manager.js";
import { SharedCredentialsManager } from "#src/credentials_provider/shared.js";
import { DataManagementContext } from "#src/data_management_context.js";
import { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import type { GL } from "#src/webgl/context.js";
import { fixture, type Fixture } from "#tests/fixtures/fixture.js";
import { glFixture } from "#tests/fixtures/gl";

export function sharedKvStoreContextFixture(
  gl: Fixture<GL> = glFixture(),
): Fixture<SharedKvStoreContext> {
  return fixture(async (stack) => {
    const dataContext = new DataManagementContext(
      /*gl=*/ await gl(),
      /*frameNumberCounter=*/ undefined as any,
    );
    stack.defer(() => dataContext.dispose());

    const sharedCredentialsManager = dataContext.registerDisposer(
      new SharedCredentialsManager(
        getDefaultCredentialsManager(),
        dataContext.rpc,
      ),
    );

    const sharedKvStoreContext = new SharedKvStoreContext(
      dataContext.chunkManager,
      sharedCredentialsManager,
    );
    stack.defer(() => sharedKvStoreContext.dispose());

    return sharedKvStoreContext;
  });
}
