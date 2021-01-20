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

import {makeCoordinateSpace, makeIdentityTransform} from 'neuroglancer/coordinate_transform';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {getSingleMeshSource} from 'neuroglancer/single_mesh/frontend';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';

export class VtkDataSource extends DataSourceProvider {
  get description() {
    return 'VTK mesh file';
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    const meshSource =
        await getSingleMeshSource(options.chunkManager, options.credentialsManager, options.url);
    const modelSpace = makeCoordinateSpace({
      rank: 3,
      names: ['x', 'y', 'z'],
      units: ['m', 'm', 'm'],
      scales: Float64Array.of(1e-9, 1e-9, 1e-9),
    });
    const dataSource: DataSource = {
      modelTransform: makeIdentityTransform(modelSpace),
      subsources: [{
        id: 'default',
        default: true,
        subsource: {singleMesh: meshSource},
      }],
    };
    return dataSource;
  }
  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}
