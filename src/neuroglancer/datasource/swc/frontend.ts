/**
 * @license
 * Copyright 2016 Google Inc.
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
 * @file
 * Support for locally served SWC files.
 * And modified it to make a standalone SWC support.
 */

import {WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {makeCoordinateSpace, makeIdentityTransform} from 'neuroglancer/coordinate_transform';
import {CompleteUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions} from 'neuroglancer/datasource';
import {SWCSourceParameters} from 'neuroglancer/datasource/swc/base';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {completeHttpPath} from 'neuroglancer/util/http_path_completion';

class SWCSkeletonSource extends
(WithParameters(SkeletonSource, SWCSourceParameters)) {}

const urlPattern = /^((?:http|https):\/\/[^\/]+)\/([^\/]+)\/([^\/]+)$/;

export function getDataSource(options: GetDataSourceOptions): Promise<DataSource> {
  let match = options.providerUrl.match(urlPattern);
  if (match === null) {
    throw new Error(`Invalid SWC URL: ${JSON.stringify(options.providerUrl)}.`);
  }
  const baseUrl = match[1];
  const nodeKey = match[2];
  const dataInstanceKey = match[3];
  return options.chunkManager.memoize.getUncounted(
      {
        type: 'svc:MultiscaleVolumeChunkSource',
        baseUrl,
        nodeKey: nodeKey,
        dataInstanceKey,
      },
      async () => {
        const modelSpace = makeCoordinateSpace({
          rank: 3,
          names: ['x', 'y', 'z'],
          units: ['m', 'm', 'm'],
          scales: Float64Array.of(1e-6, 1e-6, 1e-6),
          boundingBoxes: [],
        });
        const dataSource: DataSource = {
          modelTransform: makeIdentityTransform(modelSpace),
          subsources: [],
        };
        dataSource.subsources.push({
          id: 'default',
          default: true,
          subsource: {
            mesh: options.chunkManager.getChunkSource(SWCSkeletonSource, {
              parameters: {
                'baseUrl': baseUrl,
                'nodeKey': nodeKey,
              }
            })
          },
        });
        return dataSource;
      });
}

export class SWCDataSource extends DataSourceProvider {
  get description() {
    return 'SWC';
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getDataSource(options);
  }

  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(options.providerUrl, options.cancellationToken);
  }
}