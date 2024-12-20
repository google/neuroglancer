/**
 * @license
 * Copyright 2019 Google Inc.
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
  makeCoordinateSpace,
  makeIdentityTransform,
} from "#src/coordinate_transform.js";
import type {
  DataSource,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import { ensureEmptyUrlSuffix } from "#src/kvstore/url.js";
import { getSingleMeshSource } from "#src/single_mesh/frontend.js";

export class VtkDataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "vtk";
  }
  get description() {
    return "VTK mesh";
  }
  get singleFile() {
    return true;
  }

  async get(options: GetKvStoreBasedDataSourceOptions): Promise<DataSource> {
    ensureEmptyUrlSuffix(options.url);
    const meshSource = await getSingleMeshSource(
      options.registry.sharedKvStoreContext,
      options.kvStoreUrl,
      options,
    );
    const modelSpace = makeCoordinateSpace({
      rank: 3,
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.of(1e-9, 1e-9, 1e-9),
    });
    const dataSource: DataSource = {
      modelTransform: makeIdentityTransform(modelSpace),
      subsources: [
        {
          id: "default",
          default: true,
          subsource: { singleMesh: meshSource },
        },
      ],
    };
    return dataSource;
  }
}
