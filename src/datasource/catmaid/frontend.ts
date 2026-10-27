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

/**
 * @file Opens a catmaid:// data source with its spatially indexed skeletons,
 * editable unless the project is read-only, its segment property map and its
 * bounds. It runs on the main thread.
 */

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
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
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_edit/command_factories.js";
import type {
  DataSource,
  DataSourceProvider,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import {
  SegmentPropertyMap,
  normalizeInlineSegmentPropertyMap,
} from "#src/segmentation_display_state/property_map.js";
import {
  SkeletonEdgeDirection,
  type EditableSkeletonSource,
  type SkeletonEdge,
  type SkeletonFragment,
  type SkeletonFragmentNode,
  type SkeletonManifest,
  type SkeletonSpatialIndexMetadata,
} from "#src/skeleton/api.js";
import { SkeletonDataSourceState } from "#src/skeleton/find_path/find_path.js";
import {
  SpatiallyIndexedSkeletonSource,
  MultiscaleSpatiallyIndexedSkeletonSource,
} from "#src/skeleton/spatial/frontend.js";
import { mat4 } from "#src/util/geom.js";
import "#src/datasource/catmaid/register_credentials_provider.js";

export class CatmaidSpatiallyIndexedSkeletonSource extends WithParameters(
  WithCredentialsProvider<CatmaidToken>()(SpatiallyIndexedSkeletonSource),
  CatmaidSkeletonSourceParameters,
) {}

class CatmaidSkeletonSource
  extends CatmaidSpatialSkeletonEditCommands
  implements EditableSkeletonSource
{
  readonly confidenceValues = CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES;
  readonly edgeDirection = SkeletonEdgeDirection.CHILD_TO_PARENT;

  constructor(private readonly catmaidClient: CatmaidClient) {
    super({ getClient: () => catmaidClient });
  }

  // One compact-detail request returns a whole skeleton.
  async getSkeletonManifest(): Promise<SkeletonManifest> {
    return { fragmentKeys: ["skeleton"] };
  }

  async getSkeletonFragment(
    skeletonId: bigint,
    _fragmentKey: string,
    signal: AbortSignal,
  ): Promise<SkeletonFragment> {
    const skeletonNodes = await this.catmaidClient.getSkeleton(skeletonId, {
      signal,
    });
    const nodes: SkeletonFragmentNode[] = [];
    const edges: SkeletonEdge[] = [];
    for (const { parentNodeId, ...node } of skeletonNodes) {
      nodes.push(node);
      if (parentNodeId !== undefined) {
        edges.push({ firstNodeId: node.nodeId, secondNodeId: parentNodeId });
      }
    }
    return { nodes, edges };
  }
}

interface CatmaidLevelSourceOptions {
  readonly baseUrl: string;
  readonly projectId: number;
  readonly cacheProvider: string | undefined;
  readonly credentialsProvider: CredentialsProvider<CatmaidToken>;
}

class CatmaidMultiscaleSpatiallyIndexedSkeletonSource extends MultiscaleSpatiallyIndexedSkeletonSource {
  readonly fragmentSource: CatmaidSkeletonSource;
  readonly editableSource: CatmaidSkeletonSource | undefined;

  constructor(
    chunkManager: ChunkManager,
    metadata: SkeletonSpatialIndexMetadata,
    client: CatmaidClient,
    readonly: boolean,
    private readonly levelSourceOptions: CatmaidLevelSourceOptions,
  ) {
    super(chunkManager, metadata);
    this.fragmentSource = new CatmaidSkeletonSource(client);
    this.editableSource = readonly ? undefined : this.fragmentSource;
  }

  getSources() {
    const { baseUrl, projectId, cacheProvider, credentialsProvider } =
      this.levelSourceOptions;
    const specs = this.getLevelSpecs();
    return [
      specs.map((spec, coarseToFineIndex) => {
        const parameters = new CatmaidSkeletonSourceParameters();
        parameters.catmaidParameters = new CatmaidDataSourceParameters();
        parameters.catmaidParameters.url = baseUrl;
        parameters.catmaidParameters.projectId = projectId;
        parameters.catmaidParameters.cacheProvider = cacheProvider;
        parameters.gridIndex = coarseToFineIndex;
        parameters.catmaidLod = getCatmaidLodForSpatialIndexLevel(
          coarseToFineIndex,
          specs.length,
        );
        return {
          chunkSource: this.chunkManager.getChunkSource(
            CatmaidSpatiallyIndexedSkeletonSource,
            { parameters, spec, credentialsProvider },
          ),
          chunkToMultiscaleTransform: mat4.create(),
        };
      }),
    ];
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
      { url: baseUrl, projectId },
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

    const { bounds, spatial, readonly: sourceReadonly } = spatialIndexMetadata;
    // The model-space coordinates we emit are in nanometers, converted to meters for Neuroglancer.
    const modelSpace = makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.from([1e-9, 1e-9, 1e-9]),
      boundingBoxes: [
        {
          box: bounds,
          transform: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        },
      ],
    });

    const multiscaleSource =
      new CatmaidMultiscaleSpatiallyIndexedSkeletonSource(
        options.registry.chunkManager,
        { modelSpace, levels: spatial },
        client,
        sourceReadonly,
        { baseUrl, projectId, cacheProvider, credentialsProvider },
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
        subsource: { spatialSkeleton: multiscaleSource },
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
