/**
 * @license
 * Copyright 2025 Google Inc.
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

import "#src/kvstore/http/register_frontend.js";
import { test } from "vitest";
import { getDatasourceMetadata } from "#tests/datasource/test_util.js";
import { dataSourceProviderFixture } from "#tests/fixtures/datasource_provider.js";

declare const TEST_DATA_SERVER: string;

export const dataSourceProvider = dataSourceProviderFixture();

export function datasourceMetadataSnapshotTests(
  datasourceName: string,
  names: string[],
  basePrefix: string = `datasource/${datasourceName}/`,
) {
  test.for(names)("metadata %s", async (name, { expect }) => {
    await expect(
      await getDatasourceMetadata(
        dataSourceProvider,
        `${TEST_DATA_SERVER}${basePrefix}${name}`,
      ),
    ).toMatchFileSnapshot(
      `./metadata_snapshots/${datasourceName}/${name.replaceAll("/", "_")}.snapshot`,
    );
  });
}
