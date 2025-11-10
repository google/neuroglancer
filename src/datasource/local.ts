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
export const localVoxelAnnotationsUrl = "local://voxel-annotations";

export enum LocalDataSource {
  annotations = 0,
  equivalences = 1,
  voxelAnnotations = 2,
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
      case localVoxelAnnotationsUrl: {
        // Voxels data source: by default, provide a fixed 3D identity model transform.
        // Rationale: Many voxel-based layers (like our demo vox layer) expect a concrete 3D
        // model space. Mirroring the global space rank/names can lead to ambiguous or rank-0
        // cases depending on viewer state. Keeping a stable 3D identity model transform here
        // reduces surprises while still allowing an explicit transform override via options.
        const { transform } = options;
        let modelTransform: CoordinateSpaceTransform;
        if (transform === undefined) {
          const inputSpace = makeCoordinateSpace({
            rank: 3,
            scales: new Float64Array([1, 1, 1]),
            units: ["", "", ""],
            names: ["x", "y", "z"],
          });
          const outputSpace = makeCoordinateSpace({
            rank: 3,
            scales: new Float64Array([1, 1, 1]),
            units: ["", "", ""],
            names: ["x", "y", "z"],
          });
          modelTransform = {
            rank: 3,
            sourceRank: 3,
            inputSpace,
            outputSpace,
            transform: createIdentity(Float64Array, 4),
          };
        } else {
          // If an explicit transform is provided, just pass through an identity over empty space,
          // consistent with other local sources.
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
                local: LocalDataSource.voxelAnnotations,
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
          {
            value: "voxel-annotations",
            description: "Voxel annotations stored in the JSON state",
          },
        ],
        (x) => x.value,
        (x) => x.description,
      ),
    };
  }
}
