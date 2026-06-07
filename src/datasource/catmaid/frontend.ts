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
  getCatmaidSpatialSkeletonGridCellBounds,
} from "#src/datasource/catmaid/api.js";
import {
  CatmaidSkeletonSourceParameters,
  CatmaidCompleteSkeletonSourceParameters,
  CatmaidDataSourceParameters,
  makeCatmaidClient,
  makeCatmaidSkeletonMetadata,
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
  SpatialSkeletonConfidenceConfiguration,
  SpatialSkeletonGridCellIndex,
  SpatiallyIndexedSkeletonMetadata,
  SpatiallyIndexedSkeletonNode,
  SpatiallyIndexedSkeletonNodeBase,
} from "#src/skeleton/api.js";
import {
  SpatiallyIndexedSkeletonSource,
  SkeletonSource,
  MultiscaleSpatiallyIndexedSkeletonSource,
  SPATIAL_SKELETON_SOURCE_OPTIONS,
} from "#src/skeleton/frontend.js";
import {
  buildSpatialSkeletonGridLevels,
  type SpatialSkeletonGridLevel,
  type SpatialSkeletonGridSize,
} from "#src/skeleton/spatial_chunk_sizing.js";
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { Borrowed } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import "#src/datasource/catmaid/register_credentials_provider.js";

const CATMAID_SPATIAL_SKELETON_CONFIDENCE_CONFIGURATION = {
  values: CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES,
} satisfies SpatialSkeletonConfidenceConfiguration;

export class CatmaidSpatiallyIndexedSkeletonSource extends WithParameters(
  WithCredentialsProvider<CatmaidToken>()(SpatiallyIndexedSkeletonSource),
  CatmaidSkeletonSourceParameters,
) {
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

  getSkeleton(
    skeletonId: number,
    options?: { signal?: AbortSignal },
  ): Promise<SpatiallyIndexedSkeletonNode[]> {
    return this.client.getSkeleton(skeletonId, options);
  }

  listSkeletons(): Promise<number[]> {
    return this.client.listSkeletons();
  }

  getSpatialIndexMetadata(): Promise<SpatiallyIndexedSkeletonMetadata | null> {
    return this.client.getSpatialIndexMetadata();
  }

  fetchNodes(
    cellIndex: SpatialSkeletonGridCellIndex,
    options: {
      signal?: AbortSignal;
    } = {},
  ): Promise<SpatiallyIndexedSkeletonNodeBase[]> {
    const bounds = getCatmaidSpatialSkeletonGridCellBounds(
      cellIndex.cell,
      this.spec.chunkDataSize,
    );
    return this.client.fetchNodes(bounds, this.parameters.catmaidLod ?? 0, {
      cacheProvider: this.parameters.catmaidParameters.cacheProvider,
      signal: options.signal,
    });
  }

  getSkeletonRootNode(skeletonId: number) {
    return this.client.getSkeletonRootNode(skeletonId);
  }
}

export class CatmaidSkeletonSource extends WithParameters(
  WithCredentialsProvider<CatmaidToken>()(SkeletonSource),
  CatmaidCompleteSkeletonSourceParameters,
) {
  get vertexAttributes() {
    return this.parameters.metadata.vertexAttributes;
  }
}

export class CatmaidMultiscaleSpatiallyIndexedSkeletonSource extends MultiscaleSpatiallyIndexedSkeletonSource {
  get rank(): number {
    return 3;
  }

  private gridLevels: SpatialSkeletonGridLevel[];

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    private baseUrl: string,
    private projectId: number,
    private credentialsProvider: CredentialsProvider<CatmaidToken>,
    private coordinateScaleFactorsInMeters: Float32Array,
    private lowerBoundsInNanometers: Float32Array,
    private upperBoundsInNanometers: Float32Array,
    gridCellSizes: SpatialSkeletonGridSize[],
    private cacheProvider?: string,
    private sourceReadonly = true,
  ) {
    super(chunkManager);
    this.gridLevels = buildSpatialSkeletonGridLevels(gridCellSizes);
  }

  getSpatialSkeletonGridSizes(): SpatialSkeletonGridSize[] {
    // Report grid sizes in physical meters (nm × meters-per-nm) so the
    // resolution widget + auto-LOD target are unit-consistent (the
    // widget formats the spatial scale as meters).
    const [mx, my, mz] = this.coordinateScaleFactorsInMeters;
    return this.gridLevels.map(({ size }) => ({
      x: size.x * mx,
      y: size.y * my,
      z: size.z * mz,
    }));
  }

  getPerspectiveSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    const sources = this.getSources(SPATIAL_SKELETON_SOURCE_OPTIONS);
    return sources.length > 0 ? sources[0] : [];
  }

  getSliceViewPanelSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    return this.getPerspectiveSources();
  }

  getSources(
    _options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[][] {
    const sources: SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] =
      [];

    for (const [
      gridIndex,
      { size: gridCellSize, lod },
    ] of this.gridLevels.entries()) {
      const chunkDataSize = Uint32Array.from([
        gridCellSize.x,
        gridCellSize.y,
        gridCellSize.z,
      ]);

      const chunkLayoutTransform = mat4.create();
      mat4.fromScaling(
        chunkLayoutTransform,
        vec3.fromValues(
          this.coordinateScaleFactorsInMeters[0],
          this.coordinateScaleFactorsInMeters[1],
          this.coordinateScaleFactorsInMeters[2],
        ),
      );

      const chunkLayout = new ChunkLayout(
        vec3.fromValues(chunkDataSize[0], chunkDataSize[1], chunkDataSize[2]),
        chunkLayoutTransform,
        3,
      );

      const spec = {
        ...makeSliceViewChunkSpecification({
          rank: 3,
          chunkDataSize,
          lowerVoxelBound: this.lowerBoundsInNanometers,
          upperVoxelBound: this.upperBoundsInNanometers,
        }),
        chunkLayout,
      };

      const parameters = new CatmaidSkeletonSourceParameters();
      parameters.catmaidParameters = new CatmaidDataSourceParameters();
      parameters.catmaidParameters.url = this.baseUrl;
      parameters.catmaidParameters.projectId = this.projectId;
      parameters.catmaidParameters.cacheProvider = this.cacheProvider;
      parameters.catmaidParameters.readonly = this.sourceReadonly;
      parameters.gridIndex = gridIndex;
      parameters.catmaidLod = lod;
      parameters.metadata = makeCatmaidSkeletonMetadata();

      const chunkSource = this.chunkManager.getChunkSource(
        CatmaidSpatiallyIndexedSkeletonSource,
        { parameters, spec, credentialsProvider: this.credentialsProvider },
      );

      // CATMAID grid cell sizes are already expressed in project-space nanometers.
      // Use identity here; additional relative scaling would double-apply grid size
      // and can skew per-grid visible chunk counts and requests.
      const chunkToMultiscaleTransform = mat4.create();
      sources.push({
        chunkSource,
        chunkToMultiscaleTransform,
      });
    }

    return [sources];
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

    // Remove scheme if present to handle "catmaid://"
    let cleanUrl = providerUrl;
    if (cleanUrl.startsWith("catmaid://")) {
      cleanUrl = cleanUrl.substring("catmaid://".length);
    }

    const lastSlash = cleanUrl.lastIndexOf("/");
    if (lastSlash === -1) {
      throw new Error(
        "Invalid CATMAID URL. Expected format: catmaid://<base_url>/<project_id>",
      );
    }

    const projectIdStr = cleanUrl.substring(lastSlash + 1);
    const projectId = parseInt(projectIdStr);
    if (isNaN(projectId)) {
      throw new Error(`Invalid project ID: ${projectIdStr}`);
    }

    let baseUrl = cleanUrl.substring(0, lastSlash);
    if (!baseUrl.startsWith("http")) {
      baseUrl = "https://" + baseUrl;
    }

    const credentialsProvider =
      options.registry.credentialsManager.getCredentialsProvider(
        credentialsKey,
        { serverUrl: baseUrl },
      ) as CredentialsProvider<CatmaidToken>;

    const client = makeCatmaidClient(
      { url: baseUrl, projectId, readonly: true },
      credentialsProvider,
    );

    // Fetch metadata-derived values through the generic source interface.
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
    const gridCellSizes = spatial.map(({ chunkSize }) => ({
      x: Number(chunkSize[0]),
      y: Number(chunkSize[1]),
      z: Number(chunkSize[2]),
    }));

    // The model-space coordinates we emit are in nanometers, converted to meters for Neuroglancer.
    const coordinateScaleFactors = Float64Array.from([1e-9, 1e-9, 1e-9]);

    // Bounds and chunk sizes are represented in project-space nanometers.
    const lowerBounds = Float64Array.from(projectLowerBounds);
    const upperBounds = Float64Array.from(projectUpperBounds);

    const modelSpace = makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: coordinateScaleFactors,
      boundingBoxes: [
        {
          box: {
            lowerBounds,
            upperBounds,
          },
          transform: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        },
      ],
    });

    const rank = 3;

    const lowerCoordinateBound = new Float32Array(rank);
    const upperCoordinateBound = new Float32Array(rank);
    for (let i = 0; i < rank; ++i) {
      lowerCoordinateBound[i] = lowerBounds[i];
      upperCoordinateBound[i] = upperBounds[i];
    }

    // Create multiscale skeleton source to get individual sources
    const multiscaleSource =
      new CatmaidMultiscaleSpatiallyIndexedSkeletonSource(
        options.registry.chunkManager,
        baseUrl,
        projectId,
        credentialsProvider,
        new Float32Array(coordinateScaleFactors),
        lowerCoordinateBound,
        upperCoordinateBound,
        gridCellSizes,
        cacheProvider,
        sourceReadonly,
      );
    // Create complete skeleton source (non-chunked)
    const completeSkeletonParameters =
      new CatmaidCompleteSkeletonSourceParameters();
    completeSkeletonParameters.catmaidParameters =
      new CatmaidDataSourceParameters();
    completeSkeletonParameters.catmaidParameters.url = baseUrl;
    completeSkeletonParameters.catmaidParameters.projectId = projectId;
    completeSkeletonParameters.url = providerUrl;
    completeSkeletonParameters.metadata = makeCatmaidSkeletonMetadata();

    const completeSkeletonSource = options.registry.chunkManager.getChunkSource(
      CatmaidSkeletonSource,
      { parameters: completeSkeletonParameters, credentialsProvider },
    );

    // Create SegmentPropertyMap
    const ids = new BigUint64Array(skeletonIds.length);
    for (let i = 0; i < skeletonIds.length; ++i) {
      ids[i] = BigInt(skeletonIds[i]);
    }

    const propertyMap = new SegmentPropertyMap({
      inlineProperties: normalizeInlineSegmentPropertyMap({
        ids,
        properties: [],
      }),
    });

    const subsources = [
      {
        id: "skeletons-chunked",
        default: true,
        subsource: { mesh: multiscaleSource },
      },
      {
        id: "skeletons",
        default: false,
        subsource: { mesh: completeSkeletonSource },
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
    };
  }
}
