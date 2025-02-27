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

import {
  emptyValidCoordinateSpace,
  makeCoordinateSpace,
  makeIdentityTransform,
  type CoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type {
  CompleteUrlOptions,
  DataSource,
  GetDataSourceOptions,
  DataSourceProvider,
} from "#src/datasource/index.js";
import { getPrefixMatchesWithDescriptions } from "#src/util/completion.js";
import { createIdentity } from "#src/util/matrix.js";

export const localAnnotationsUrl = "local://annotations";
export const localEquivalencesUrl = "local://equivalences";

export enum LocalDataSource {
  annotations = 0,
  equivalences = 1,
}

export class LocalDataSourceProvider implements DataSourceProvider {
  get scheme() {
    return "local";
  }
  get description() {
    return "Local in-memory";
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    switch (options.url) {
      case localAnnotationsUrl: {
        const { transform } = options;
        let modelTransform: CoordinateSpaceTransform;
        if (transform === undefined) {
          const baseSpace = options.globalCoordinateSpace.value;
          const { rank, names, scales, units } = baseSpace;
          const inputSpace = makeCoordinateSpace({
            rank,
            scales,
            units,
            names: names.map((_, i) => `${i}`),
          });
          const outputSpace = makeCoordinateSpace({
            rank,
            scales,
            units,
            names,
          });
          modelTransform = {
            rank,
            sourceRank: rank,
            inputSpace,
            outputSpace,
            transform: createIdentity(Float64Array, rank + 1),
          };
        } else {
          modelTransform = makeIdentityTransform(emptyValidCoordinateSpace);
        }
        return {
          modelTransform,
          canChangeModelSpaceRank: true,
          subsources: [
            {
              id: "default",
              default: true,
              subsource: {
                local: LocalDataSource.annotations,
              },
            },
          ],
        };
      }
      case localEquivalencesUrl: {
        return {
          modelTransform: makeIdentityTransform(emptyValidCoordinateSpace),
          canChangeModelSpaceRank: false,
          subsources: [
            {
              id: "default",
              default: true,
              subsource: {
                local: LocalDataSource.equivalences,
              },
            },
          ],
        };
      }
    }
    throw new Error("Invalid local data source URL");
  }

  async completeUrl(options: CompleteUrlOptions) {
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions(
        options.providerUrl,
        [
          {
            value: "annotations",
            description: "Annotations stored in the JSON state",
          },
          {
            value: "equivalences",
            description:
              "Segmentation equivalence graph stored in the JSON state",
          },
        ],
        (x) => x.value,
        (x) => x.description,
      ),
    };
  }
}
