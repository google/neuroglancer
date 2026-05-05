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
  CatmaidAddNodeResult,
  CatmaidDeleteNodeResult,
  CatmaidDescriptionUpdateResult,
  CatmaidEditContext,
  CatmaidInsertNodeResult,
  CatmaidMergeResult,
  CatmaidNodeSourceStateResult,
  CatmaidSplitResult,
  CatmaidSpatialSkeletonEditApi,
  CatmaidToken,
} from "#src/datasource/catmaid/api.js";
import {
  CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES,
  CatmaidClient,
  credentialsKey,
  getCatmaidSpatialSkeletonGridCellBounds,
} from "#src/datasource/catmaid/api.js";
import {
  CatmaidSkeletonSourceParameters,
  CatmaidCompleteSkeletonSourceParameters,
  CatmaidDataSourceParameters,
} from "#src/datasource/catmaid/base.js";
import { CatmaidSpatialSkeletonEditCommandSource } from "#src/datasource/catmaid/spatial_skeleton_commands.js";
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
  EditableSpatiallyIndexedSkeletonSource,
  SpatialSkeletonEditCapabilities,
  SpatialSkeletonGridCellIndex,
  SpatiallyIndexedSkeletonMetadata,
  SpatiallyIndexedSkeletonNode,
  SpatiallyIndexedSkeletonNodeBase,
} from "#src/skeleton/api.js";
import {
  SpatiallyIndexedSkeletonSource,
  SkeletonSource,
  MultiscaleSpatiallyIndexedSkeletonSource,
} from "#src/skeleton/frontend.js";
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import { DataType } from "#src/util/data_type.js";
import type { Borrowed } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import "#src/datasource/catmaid/register_credentials_provider.js";

const CATMAID_SPATIAL_SKELETON_EDIT_CAPABILITIES = {
  nodeFeatures: {
    description: true,
    trueEnd: true,
    radius: true,
    confidenceValues: CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES,
  },
} satisfies SpatialSkeletonEditCapabilities;

export class CatmaidSpatiallyIndexedSkeletonSource
  extends WithParameters(
    WithCredentialsProvider<CatmaidToken>()(SpatiallyIndexedSkeletonSource),
    CatmaidSkeletonSourceParameters,
  )
  implements
    CatmaidSpatialSkeletonEditApi,
    EditableSpatiallyIndexedSkeletonSource
{
  private readonly editableSpatialSkeletonEditCommandSource =
    new CatmaidSpatialSkeletonEditCommandSource();
  private client_?: CatmaidClient;

  get spatialSkeletonReadOnly() {
    return this.parameters.catmaidParameters.spatialSkeletonsReadOnly === true;
  }

  get spatialSkeletonEditCapabilities() {
    return this.spatialSkeletonReadOnly
      ? undefined
      : CATMAID_SPATIAL_SKELETON_EDIT_CAPABILITIES;
  }

  get spatialSkeletonEditCommandSource() {
    return this.spatialSkeletonReadOnly
      ? undefined
      : this.editableSpatialSkeletonEditCommandSource;
  }

  private ensureSpatialSkeletonEditable() {
    if (this.spatialSkeletonReadOnly) {
      throw new Error("CATMAID spatial skeleton source is read-only.");
    }
  }

  private get client() {
    let client = this.client_;
    if (client !== undefined) {
      return client;
    }
    const catmaidParameters = this.parameters.catmaidParameters;
    client = new CatmaidClient(
      catmaidParameters.url,
      catmaidParameters.projectId,
      this.credentialsProvider,
    );
    this.client_ = client;
    return client;
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
      cacheProvider?: string;
      lod?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<SpatiallyIndexedSkeletonNodeBase[]> {
    const bounds = getCatmaidSpatialSkeletonGridCellBounds(
      cellIndex.cell,
      this.spec.chunkDataSize,
    );
    return this.client.fetchNodesInBoundingBox(
      bounds,
      options.lod ?? this.parameters.catmaidLod ?? 0,
      options,
    );
  }

  getSkeletonRootNode(skeletonId: number) {
    return this.client.getSkeletonRootNode(skeletonId);
  }

  addNode(
    skeletonId: number,
    x: number,
    y: number,
    z: number,
    parentId?: number,
    editContext?: CatmaidEditContext,
  ): Promise<CatmaidAddNodeResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.addNode(skeletonId, x, y, z, parentId, editContext);
  }

  insertNode(
    skeletonId: number,
    x: number,
    y: number,
    z: number,
    parentId: number,
    childNodeIds: readonly number[],
    editContext?: CatmaidEditContext,
  ): Promise<CatmaidInsertNodeResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.insertNode(
      skeletonId,
      x,
      y,
      z,
      parentId,
      childNodeIds,
      editContext,
    );
  }

  moveNode(
    nodeId: number,
    x: number,
    y: number,
    z: number,
    editContext?: CatmaidEditContext,
  ): Promise<CatmaidNodeSourceStateResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.moveNode(nodeId, x, y, z, editContext);
  }

  deleteNode(
    nodeId: number,
    options: {
      childNodeIds?: readonly number[];
      editContext?: CatmaidEditContext;
    },
  ): Promise<CatmaidDeleteNodeResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.deleteNode(nodeId, options);
  }

  rerootSkeleton(nodeId: number, editContext?: CatmaidEditContext) {
    this.ensureSpatialSkeletonEditable();
    return this.client.rerootSkeleton(nodeId, editContext);
  }

  updateDescription(
    nodeId: number,
    description: string,
  ): Promise<CatmaidDescriptionUpdateResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.updateDescription(nodeId, description);
  }

  toggleTrueEnd(
    nodeId: number,
    nextIsTrueEnd: boolean,
  ): Promise<CatmaidNodeSourceStateResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.toggleTrueEnd(nodeId, nextIsTrueEnd);
  }

  updateRadius(
    nodeId: number,
    radius: number,
    editContext?: CatmaidEditContext,
  ): Promise<CatmaidNodeSourceStateResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.updateRadius(nodeId, radius, editContext);
  }

  updateConfidence(
    nodeId: number,
    confidence: number,
    editContext?: CatmaidEditContext,
  ): Promise<CatmaidNodeSourceStateResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.updateConfidence(nodeId, confidence, editContext);
  }

  mergeSkeletons(
    fromNodeId: number,
    toNodeId: number,
    editContext?: CatmaidEditContext,
  ): Promise<CatmaidMergeResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.mergeSkeletons(fromNodeId, toNodeId, editContext);
  }

  splitSkeleton(
    nodeId: number,
    editContext?: CatmaidEditContext,
  ): Promise<CatmaidSplitResult> {
    this.ensureSpatialSkeletonEditable();
    return this.client.splitSkeleton(nodeId, editContext);
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

  private sortedGridCellSizes: Array<{ x: number; y: number; z: number }>;

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    private baseUrl: string,
    private projectId: number,
    private credentialsProvider: CredentialsProvider<CatmaidToken>,
    private coordinateScaleFactorsInMeters: Float32Array,
    private lowerBoundsInNanometers: Float32Array,
    private upperBoundsInNanometers: Float32Array,
    gridCellSizes: Array<{ x: number; y: number; z: number }>,
    private cacheProvider?: string,
    private spatialSkeletonsReadOnly = false,
  ) {
    super(chunkManager);
    this.sortedGridCellSizes = [...gridCellSizes].sort(
      (a, b) => Math.min(b.x, b.y, b.z) - Math.min(a.x, a.y, a.z),
    );
  }

  getSpatialSkeletonGridSizes(): Array<{ x: number; y: number; z: number }> {
    return this.sortedGridCellSizes;
  }

  getPerspectiveSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    const sources = this.getSources({} as any);
    return sources.length > 0 ? sources[0] : [];
  }

  getSliceViewPanelSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    return this.getPerspectiveSources();
  }

  getSources(
    _options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[][] {
    void _options;
    const sources: SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] =
      [];

    // Sorted by minimum dimension (Descending: Large/Coarse -> Small/Fine)
    const sortedGridSizes = this.sortedGridCellSizes;

    const lastGridIndex = sortedGridSizes.length - 1;
    for (const [gridIndex, gridCellSize] of sortedGridSizes.entries()) {
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
      parameters.catmaidParameters.spatialSkeletonsReadOnly =
        this.spatialSkeletonsReadOnly;
      parameters.gridIndex = gridIndex;
      parameters.catmaidLod =
        lastGridIndex <= 0 ? 0 : gridIndex / lastGridIndex;
      parameters.metadata = {
        transform: mat4.create(),
        vertexAttributes: new Map([
          ["segment", { dataType: DataType.UINT32, numComponents: 1 }],
        ]),
        sharding: undefined,
      };

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

    const client = new CatmaidClient(baseUrl, projectId, credentialsProvider);

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
      readOnly,
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
        readOnly,
      );
    // Create complete skeleton source (non-chunked)
    const completeSkeletonParameters =
      new CatmaidCompleteSkeletonSourceParameters();
    completeSkeletonParameters.catmaidParameters =
      new CatmaidDataSourceParameters();
    completeSkeletonParameters.catmaidParameters.url = baseUrl;
    completeSkeletonParameters.catmaidParameters.projectId = projectId;
    completeSkeletonParameters.url = providerUrl;
    completeSkeletonParameters.metadata = {
      transform: mat4.create(),
      vertexAttributes: new Map([
        ["segment", { dataType: DataType.UINT32, numComponents: 1 }],
      ]),
      sharding: undefined,
    };

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
