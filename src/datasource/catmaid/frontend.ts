/**
 * @license
 * Copyright 2026 Google Inc.
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

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
} from "#src/coordinate_transform.js";
import { WithCredentialsProvider } from "#src/credentials_provider/chunk_source_frontend.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import type {
  CatmaidClient,
  CatmaidToken,
} from "#src/datasource/catmaid/api.js";
import {
  CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES,
  credentialsKey,
} from "#src/datasource/catmaid/api.js";
import {
  CatmaidSkeletonSourceParameters,
  CatmaidDataSourceParameters,
  getCatmaidLodForSpatialIndexLevel,
  makeCatmaidClient,
  parseCatmaidUrl,
} from "#src/datasource/catmaid/base.js";
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_commands.js";
import type {
  DataSource,
  DataSourceProvider,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import {
  SegmentPropertyMap,
  normalizeInlineSegmentPropertyMap,
} from "#src/segmentation_display_state/property_map.js";
import type {
  SkeletonConfidenceConfiguration,
  SkeletonFragment,
  SkeletonManifest,
  SkeletonFragmentSource,
} from "#src/skeleton/api.js";
import { SkeletonDataSourceState } from "#src/skeleton/find_path.js";
import {
  SpatiallyIndexedSkeletonSource,
  MultiscaleSpatiallyIndexedSkeletonSource,
} from "#src/skeleton/frontend.js";
import "#src/datasource/catmaid/register_credentials_provider.js";

const CATMAID_SPATIAL_SKELETON_CONFIDENCE_CONFIGURATION = {
  values: CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES,
} satisfies SkeletonConfidenceConfiguration;

export class CatmaidSpatiallyIndexedSkeletonSource
  extends WithParameters(
    WithCredentialsProvider<CatmaidToken>()(SpatiallyIndexedSkeletonSource),
    CatmaidSkeletonSourceParameters,
  )
  implements SkeletonFragmentSource
{
  private readonly spatialSkeletonEditCommands =
    new CatmaidSpatialSkeletonEditCommands({
      getClient: () => this.client,
    });
  private client_?: CatmaidClient;

  get readonly() {
    return this.parameters.catmaidParameters.readonly !== false;
  }

  get spatialSkeletonConfidenceConfiguration() {
    return this.readonly
      ? undefined
      : CATMAID_SPATIAL_SKELETON_CONFIDENCE_CONFIGURATION;
  }

  get optimisticEditing() {
    return this.editableSpatialSkeletonEditCommands?.optimisticEditing;
  }

  private get editableSpatialSkeletonEditCommands() {
    return this.readonly ? undefined : this.spatialSkeletonEditCommands;
  }

  get addNodesCommand() {
    return this.editableSpatialSkeletonEditCommands?.addNodesCommand;
  }

  get insertNodesCommand() {
    return this.editableSpatialSkeletonEditCommands?.insertNodesCommand;
  }

  get moveNodesCommand() {
    return this.editableSpatialSkeletonEditCommands?.moveNodesCommand;
  }

  get deleteNodesCommand() {
    return this.editableSpatialSkeletonEditCommands?.deleteNodesCommand;
  }

  get rerootCommand() {
    return this.editableSpatialSkeletonEditCommands?.rerootCommand;
  }

  get editNodeDescriptionCommand() {
    return this.editableSpatialSkeletonEditCommands?.editNodeDescriptionCommand;
  }

  get editNodeTrueEndCommand() {
    return this.editableSpatialSkeletonEditCommands?.editNodeTrueEndCommand;
  }

  get editNodeRadiusCommand() {
    return this.editableSpatialSkeletonEditCommands?.editNodeRadiusCommand;
  }

  get editNodeConfidenceCommand() {
    return this.editableSpatialSkeletonEditCommands?.editNodeConfidenceCommand;
  }

  get mergeSkeletonsCommand() {
    return this.editableSpatialSkeletonEditCommands?.mergeSkeletonsCommand;
  }

  get splitSkeletonsCommand() {
    return this.editableSpatialSkeletonEditCommands?.splitSkeletonsCommand;
  }

  private get client() {
    return (this.client_ ??= makeCatmaidClient(
      this.parameters.catmaidParameters,
      this.credentialsProvider,
    ));
  }

  // One compact-detail request returns a whole skeleton.
  async getSkeletonManifest(): Promise<SkeletonManifest> {
    return { fragmentKeys: ["skeleton"] };
  }

  async getSkeletonFragment(
    skeletonId: bigint,
    _fragmentKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<SkeletonFragment> {
    return { nodes: await this.client.getSkeleton(skeletonId, options) };
  }
}

export class CatmaidDataSourceProvider implements DataSourceProvider {
  get scheme() {
    return "catmaid";
  }

  get description() {
    return "CATMAID";
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    const { providerUrl } = options;
    const state = new SkeletonDataSourceState(options.state);

    const { baseUrl, projectId } = parseCatmaidUrl(providerUrl);

    const credentialsProvider =
      options.registry.credentialsManager.getCredentialsProvider(
        credentialsKey,
        { serverUrl: baseUrl },
      ) as CredentialsProvider<CatmaidToken>;

    const client = makeCatmaidClient(
      {
        url: baseUrl,
        projectId,
        readonly: true,
      },
      credentialsProvider,
    );

    // Fetch project metadata, cache-provider configuration, and skeleton IDs concurrently.
    const [spatialIndexMetadata, cacheProvider, skeletonIds] =
      await Promise.all([
        options.registry.chunkManager.memoize.getAsync(
          { type: "catmaid:spatial-index-metadata", baseUrl, projectId },
          options,
          () => client.getSpatialIndexMetadata(),
        ),
        options.registry.chunkManager.memoize.getAsync(
          { type: "catmaid:cache-provider", baseUrl, projectId },
          options,
          () => client.getCacheProvider(),
        ),
        options.registry.chunkManager.memoize.getAsync(
          { type: "catmaid:skeletons", baseUrl, projectId },
          options,
          () => client.listSkeletons(),
        ),
      ]);

    if (spatialIndexMetadata === null) {
      throw new Error("Failed to fetch CATMAID spatial index metadata");
    }

    const {
      lowerBounds: projectLowerBounds,
      upperBounds: projectUpperBounds,
      spatial,
      readonly: sourceReadonly,
    } = spatialIndexMetadata;
    // The model-space coordinates we emit are in nanometers, converted to meters for Neuroglancer.
    const modelSpace = makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.from([1e-9, 1e-9, 1e-9]),
      boundingBoxes: [
        {
          box: {
            lowerBounds: Float64Array.from(projectLowerBounds),
            upperBounds: Float64Array.from(projectUpperBounds),
          },
          transform: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        },
      ],
    });

    const multiscaleSource = new MultiscaleSpatiallyIndexedSkeletonSource(
      options.registry.chunkManager,
      { coordinateSpace: modelSpace, spatial },
      ({ coarseToFineIndex, levelCount, spec }) => {
        const parameters = new CatmaidSkeletonSourceParameters();
        parameters.catmaidParameters = new CatmaidDataSourceParameters();
        parameters.catmaidParameters.url = baseUrl;
        parameters.catmaidParameters.projectId = projectId;
        parameters.catmaidParameters.cacheProvider = cacheProvider;
        parameters.catmaidParameters.readonly = sourceReadonly;
        parameters.gridIndex = coarseToFineIndex;
        parameters.catmaidLod = getCatmaidLodForSpatialIndexLevel(
          coarseToFineIndex,
          levelCount,
        );
        return options.registry.chunkManager.getChunkSource(
          CatmaidSpatiallyIndexedSkeletonSource,
          { parameters, spec, credentialsProvider },
        );
      },
    );
    // Create SegmentPropertyMap
    const ids = BigUint64Array.from(skeletonIds);

    const propertyMap = new SegmentPropertyMap({
      inlineProperties: normalizeInlineSegmentPropertyMap({
        ids,
        properties: [],
      }),
    });

    const subsources = [
      {
        id: "skeletons",
        default: true,
        subsource: { mesh: multiscaleSource },
        layerRuntimeStateDisposal: {
          kind: "spatiallyIndexedSkeleton",
        },
      },
      {
        id: "properties",
        default: true,
        subsource: { segmentPropertyMap: propertyMap },
      },
      {
        id: "bounds",
        default: true,
        subsource: {
          staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(
            modelSpace.bounds,
          ),
        },
      },
    ];

    return {
      modelTransform: makeIdentityTransform(modelSpace),
      subsources,
      state,
    };
  }
}
