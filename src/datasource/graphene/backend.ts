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

import { debounce } from "lodash-es";
import {
  WithParameters,
  withChunkManager,
  Chunk,
  ChunkSource,
} from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import type { ChunkedGraphChunkSpecification } from "#src/datasource/graphene/base.js";
import {
  getGrapheneFragmentKey,
  GRAPHENE_MESH_NEW_SEGMENT_RPC_ID,
  ChunkedGraphSourceParameters,
  MeshSourceParameters,
  CHUNKED_GRAPH_LAYER_RPC_ID,
  CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  RENDER_RATIO_LIMIT,
  isBaseSegmentId,
} from "#src/datasource/graphene/base.js";
import { decodeManifestChunk } from "#src/datasource/precomputed/backend.js";
import type { FragmentChunk, ManifestChunk } from "#src/mesh/backend.js";
import { assignMeshFragmentData, MeshSource } from "#src/mesh/backend.js";
import { decodeDraco } from "#src/mesh/draco/index.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import type {
  RenderedViewBackend,
  RenderLayerBackendAttachment,
} from "#src/render_layer_backend.js";
import { RenderLayerBackend } from "#src/render_layer_backend.js";
import { withSegmentationLayerBackendState } from "#src/segmentation_display_state/backend.js";
import { forEachVisibleSegment } from "#src/segmentation_display_state/base.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { SliceViewChunkSourceBackend } from "#src/sliceview/backend.js";
import { deserializeTransformedSources } from "#src/sliceview/backend.js";
import type {
  TransformedSource,
  SliceViewProjectionParameters,
} from "#src/sliceview/base.js";
import {
  forEachPlaneIntersectingVolumetricChunk,
  getNormalizedChunkLayout,
} from "#src/sliceview/base.js";
import { computeChunkBounds } from "#src/sliceview/volume/backend.js";
import { Uint64Set } from "#src/uint64_set.js";
import { fetchSpecialHttpByteRange } from "#src/util/byte_range_http_requests.js";
import { vec3, vec3Key } from "#src/util/geom.js";
import type {
  SpecialProtocolCredentials,
  SpecialProtocolCredentialsProvider,
} from "#src/util/special_protocol_request.js";
import { fetchSpecialOk } from "#src/util/special_protocol_request.js";
import { Uint64 } from "#src/util/uint64.js";
import {
  getBasePriority,
  getPriorityTier,
  withSharedVisibility,
} from "#src/visibility_priority/backend.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject, registerRPC } from "#src/worker_rpc.js";

function getVerifiedFragmentPromise(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  chunk: FragmentChunk,
  parameters: MeshSourceParameters,
  abortSignal: AbortSignal,
) {
  if (chunk.fragmentId && chunk.fragmentId.charAt(0) === "~") {
    const parts = chunk.fragmentId.substr(1).split(":");
    const startOffset = Number(parts[1]);
    const endOffset = startOffset + Number(parts[2]);
    return fetchSpecialHttpByteRange(
      credentialsProvider,
      `${parameters.fragmentUrl}/initial/${parts[0]}`,
      startOffset,
      endOffset,
      abortSignal,
    );
  }
  return fetchSpecialOk(
    credentialsProvider,
    `${parameters.fragmentUrl}/dynamic/${chunk.fragmentId}`,
    { signal: abortSignal },
  ).then((response) => response.arrayBuffer());
}

function getFragmentDownloadPromise(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  chunk: FragmentChunk,
  parameters: MeshSourceParameters,
  abortSignal: AbortSignal,
) {
  let fragmentDownloadPromise;
  if (parameters.sharding) {
    fragmentDownloadPromise = getVerifiedFragmentPromise(
      credentialsProvider,
      chunk,
      parameters,
      abortSignal,
    );
  } else {
    fragmentDownloadPromise = fetchSpecialOk(
      credentialsProvider,
      `${parameters.fragmentUrl}/${chunk.fragmentId}`,
      { signal: abortSignal },
    ).then((response) => response.arrayBuffer());
  }
  return fragmentDownloadPromise;
}

async function decodeDracoFragmentChunk(
  chunk: FragmentChunk,
  response: ArrayBuffer,
) {
  const rawMesh = await decodeDraco(new Uint8Array(response));
  assignMeshFragmentData(chunk, rawMesh);
}

@registerSharedObject()
export class GrapheneMeshSource extends WithParameters(
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    MeshSource,
  ),
  MeshSourceParameters,
) {
  manifestRequestCount = new Map<string, number>();
  newSegments = new Uint64Set();

  addNewSegment(segment: Uint64) {
    const { newSegments } = this;
    newSegments.add(segment);
    const TEN_MINUTES = 1000 * 60 * 10;
    setTimeout(() => {
      newSegments.delete(segment);
    }, TEN_MINUTES);
  }

  async download(chunk: ManifestChunk, abortSignal: AbortSignal) {
    const { parameters, newSegments, manifestRequestCount } = this;
    if (isBaseSegmentId(chunk.objectId, parameters.nBitsForLayerId)) {
      return decodeManifestChunk(chunk, { fragments: [] });
    }
    const url = `${parameters.manifestUrl}/manifest`;
    const manifestUrl = `${url}/${chunk.objectId}:${parameters.lod}?verify=1&prepend_seg_ids=1`;
    await fetchSpecialOk(this.credentialsProvider, manifestUrl, {
      signal: abortSignal,
    })
      .then((response) => response.json())
      .then((response) => {
        const chunkIdentifier = manifestUrl;
        if (newSegments.has(chunk.objectId)) {
          const requestCount =
            (manifestRequestCount.get(chunkIdentifier) || 0) + 1;
          manifestRequestCount.set(chunkIdentifier, requestCount);
          setTimeout(
            () => {
              this.chunkManager.queueManager.updateChunkState(
                chunk,
                ChunkState.QUEUED,
              );
            },
            2 ** requestCount * 1000,
          );
        } else {
          manifestRequestCount.delete(chunkIdentifier);
        }
        return decodeManifestChunk(chunk, response);
      });
  }

  async downloadFragment(chunk: FragmentChunk, abortSignal: AbortSignal) {
    const { parameters } = this;
    const response = await getFragmentDownloadPromise(
      undefined,
      chunk,
      parameters,
      abortSignal,
    );
    await decodeDracoFragmentChunk(chunk, response);
  }

  getFragmentKey(objectKey: string | null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
  }
}

export class ChunkedGraphChunk extends Chunk {
  chunkGridPosition: Float32Array;
  source: GrapheneChunkedGraphChunkSource | null = null;
  segment: Uint64;
  leaves: Uint64[] = [];
  chunkDataSize: Uint32Array | null;

  initializeVolumeChunk(key: string, chunkGridPosition: Float32Array) {
    super.initialize(key);
    this.chunkGridPosition = Float32Array.from(chunkGridPosition);
  }

  initializeChunkedGraphChunk(
    key: string,
    chunkGridPosition: Float32Array,
    segment: Uint64,
  ) {
    this.initializeVolumeChunk(key, chunkGridPosition);
    this.chunkDataSize = null;
    this.systemMemoryBytes = 16;
    this.gpuMemoryBytes = 0;
    this.segment = segment;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = 16; // this.segment
    this.systemMemoryBytes += 16 * this.leaves.length;
    this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY_WORKER);
    if (this.priorityTier < ChunkPriorityTier.RECENT) {
      this.source!.chunkManager.scheduleUpdateChunkPriorities();
    }
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.leaves = [];
  }
}

function decodeChunkedGraphChunk(leaves: string[]) {
  const final: Uint64[] = new Array(leaves.length);
  for (let i = 0; i < final.length; ++i) {
    final[i] = Uint64.parseString(leaves[i]);
  }
  return final;
}

@registerSharedObject()
export class GrapheneChunkedGraphChunkSource extends WithParameters(
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    ChunkSource,
  ),
  ChunkedGraphSourceParameters,
) {
  spec: ChunkedGraphChunkSpecification;
  declare chunks: Map<string, ChunkedGraphChunk>;
  tempChunkDataSize: Uint32Array;
  tempChunkPosition: Float32Array;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
    const rank = this.spec.rank;
    this.tempChunkDataSize = new Uint32Array(rank);
    this.tempChunkPosition = new Float32Array(rank);
  }

  async download(
    chunk: ChunkedGraphChunk,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const { parameters } = this;
    const chunkPosition = this.computeChunkBounds(chunk);
    const chunkDataSize = chunk.chunkDataSize!;
    const bounds =
      `${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
      `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
      `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;

    const request = fetchSpecialOk(
      this.credentialsProvider,
      `${parameters.url}/${chunk.segment}/leaves?int64_as_str=1&bounds=${bounds}`,
      { signal: abortSignal },
    );
    await this.withErrorMessage(
      request,
      `Fetching leaves of segment ${chunk.segment} in region ${bounds}: `,
    )
      .then((res) => res.json())
      .then((res) => {
        chunk.leaves = decodeChunkedGraphChunk(res.leaf_ids);
      })
      .catch((err) => console.error(err));
  }

  getChunk(chunkGridPosition: Float32Array, segment: Uint64) {
    const key = `${vec3Key(chunkGridPosition)}-${segment}`;
    let chunk = <ChunkedGraphChunk>this.chunks.get(key);

    if (chunk === undefined) {
      chunk = this.getNewChunk_(ChunkedGraphChunk);
      chunk.initializeChunkedGraphChunk(key, chunkGridPosition, segment);
      this.addChunk(chunk);
    }
    return chunk;
  }

  computeChunkBounds(chunk: ChunkedGraphChunk) {
    return computeChunkBounds(this, chunk);
  }

  async withErrorMessage(
    promise: Promise<Response>,
    errorPrefix: string,
  ): Promise<Response> {
    const response = await promise;
    if (response.ok) {
      return response;
    }
    let msg: string;
    try {
      msg = (await response.json()).message;
    } catch {
      msg = await response.text();
    }
    throw new Error(`[${response.status}] ${errorPrefix}${msg}`);
  }
}

interface ChunkedGraphRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSource?: TransformedSource<
    ChunkedGraphLayer,
    GrapheneChunkedGraphChunkSource
  >;
}

const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();

@registerSharedObject(CHUNKED_GRAPH_LAYER_RPC_ID)
export class ChunkedGraphLayer extends withSegmentationLayerBackendState(
  withSharedVisibility(withChunkManager(RenderLayerBackend)),
) {
  source: GrapheneChunkedGraphChunkSource;
  localPosition: SharedWatchableValue<Float32Array>;
  leafRequestsActive: SharedWatchableValue<boolean>;
  nBitsForLayerId: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(
      rpc.getRef<GrapheneChunkedGraphChunkSource>(options.source),
    );
    this.localPosition = rpc.get(options.localPosition);
    this.leafRequestsActive = rpc.get(options.leafRequestsActive);
    this.nBitsForLayerId = rpc.get(options.nBitsForLayerId);

    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() => {
        this.updateChunkPriorities();
        this.debouncedupdateDisplayState();
      }),
    );
  }

  attach(
    attachment: RenderLayerBackendAttachment<
      RenderedViewBackend,
      ChunkedGraphRenderLayerAttachmentState
    >,
  ): void {
    const scheduleUpdateChunkPriorities = () =>
      this.chunkManager.scheduleUpdateChunkPriorities();
    const { view } = attachment;
    attachment.registerDisposer(scheduleUpdateChunkPriorities);
    attachment.registerDisposer(
      view.projectionParameters.changed.add(scheduleUpdateChunkPriorities),
    );
    attachment.registerDisposer(
      view.visibility.changed.add(scheduleUpdateChunkPriorities),
    );
    attachment.state = {
      displayDimensionRenderInfo:
        view.projectionParameters.value.displayDimensionRenderInfo,
    };
  }

  // Used for the sliceview to set a limit on when to
  // make get_leaves to the ChunkedGraph
  get renderRatioLimit() {
    return RENDER_RATIO_LIMIT;
  }

  private updateChunkPriorities() {
    const { source, chunkManager } = this;
    chunkManager.registerLayer(this);
    for (const attachment of this.attachments.values()) {
      const { view } = attachment;
      const visibility = view.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) {
        continue;
      }

      const attachmentState =
        attachment.state! as ChunkedGraphRenderLayerAttachmentState;
      const { transformedSource: tsource } = attachmentState;
      const projectionParameters = view.projectionParameters
        .value as SliceViewProjectionParameters;

      if (!tsource) {
        continue;
      }

      const pixelSize = projectionParameters.pixelSize * 1.1;
      const smallestVoxelSize = tsource.effectiveVoxelSize;
      this.leafRequestsActive.value =
        this.renderRatioLimit >= pixelSize / Math.min(...smallestVoxelSize);
      if (!this.leafRequestsActive.value) {
        continue;
      }

      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility);

      const { chunkLayout } = tsource;
      const { size, finiteRank } = chunkLayout;

      const chunkSize = tempChunkSize;
      const localCenter = tempCenter;
      vec3.copy(chunkSize, size);
      for (let i = finiteRank; i < 3; ++i) {
        chunkSize[i] = 0;
        localCenter[i] = 0;
      }
      const { centerDataPosition } = projectionParameters;
      chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);

      forEachPlaneIntersectingVolumetricChunk(
        projectionParameters,
        this.localPosition.value,
        tsource,
        getNormalizedChunkLayout(projectionParameters, chunkLayout),
        (positionInChunks) => {
          vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
          const priority = -vec3.distance(localCenter, tempChunkPosition);
          const { curPositionInChunks } = tsource;

          forEachVisibleSegment(this, (segment, _) => {
            if (isBaseSegmentId(segment, this.nBitsForLayerId.value)) return; // TODO maybe support highBitRepresentation?
            const chunk = source.getChunk(curPositionInChunks, segment.clone());
            chunkManager.requestChunk(
              chunk,
              priorityTier,
              basePriority + priority,
              ChunkState.SYSTEM_MEMORY_WORKER,
            );
            ++this.numVisibleChunksNeeded;
            if (chunk.state === ChunkState.GPU_MEMORY) {
              ++this.numVisibleChunksAvailable;
            }
          });
        },
      );
    }
  }

  private forEachSelectedRootWithLeaves(
    callback: (rootObjectKey: string, leaves: Uint64[]) => void,
  ) {
    const { source } = this;

    for (const chunk of source.chunks.values()) {
      if (
        chunk.state === ChunkState.SYSTEM_MEMORY_WORKER &&
        chunk.priorityTier < ChunkPriorityTier.RECENT
      ) {
        if (this.visibleSegments.has(chunk.segment) && chunk.leaves.length) {
          callback(chunk.segment.toString(), chunk.leaves);
        }
      }
    }
  }

  private debouncedupdateDisplayState = debounce(() => {
    this.updateDisplayState();
  }, 100);

  private updateDisplayState() {
    const visibleLeaves = new Map<string, Uint64Set>();
    const capacities = new Map<string, number>();

    // Reserve
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!capacities.has(rootObjectKey)) {
        capacities.set(rootObjectKey, leaves.length);
      } else {
        capacities.set(
          rootObjectKey,
          capacities.get(rootObjectKey)! + leaves.length,
        );
      }
    });

    // Collect unique leaves
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!visibleLeaves.has(rootObjectKey)) {
        visibleLeaves.set(rootObjectKey, new Uint64Set());
        visibleLeaves
          .get(rootObjectKey)!
          .reserve(capacities.get(rootObjectKey)!);
        visibleLeaves
          .get(rootObjectKey)!
          .add(Uint64.parseString(rootObjectKey));
      }
      visibleLeaves.get(rootObjectKey)!.add(leaves);
    });

    for (const [root, leaves] of visibleLeaves) {
      // TODO: Delete segments not visible anymore from segmentEquivalences - requires a faster data
      // structure, though.

      /*if (this.segmentEquivalences.has(Uint64.parseString(root))) {
        this.segmentEquivalences.delete([...this.segmentEquivalences.setElements(Uint64.parseString(root))].filter(x
      => !leaves.has(x) && !this.visibleSegments.has(x)));
      }*/
      const filteredLeaves = [...leaves].filter(
        (x) => !this.segmentEquivalences.has(x),
      );

      const rootInt = Uint64.parseString(root);

      for (const leaf of filteredLeaves) {
        this.segmentEquivalences.link(rootInt, leaf);
      }
    }
  }
}

registerRPC(CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, function (x) {
  const view = this.get(x.view) as RenderedViewBackend;
  const layer = this.get(x.layer) as ChunkedGraphLayer;
  const attachment = layer.attachments.get(
    view,
  )! as RenderLayerBackendAttachment<
    RenderedViewBackend,
    ChunkedGraphRenderLayerAttachmentState
  >;
  attachment.state!.transformedSource = deserializeTransformedSources<
    SliceViewChunkSourceBackend,
    ChunkedGraphLayer
  >(this, x.sources, layer)[0][0] as unknown as TransformedSource<
    ChunkedGraphLayer,
    GrapheneChunkedGraphChunkSource
  >;
  attachment.state!.displayDimensionRenderInfo = x.displayDimensionRenderInfo;
  layer.chunkManager.scheduleUpdateChunkPriorities();
});

registerRPC(GRAPHENE_MESH_NEW_SEGMENT_RPC_ID, function (x) {
  const obj = <GrapheneMeshSource>this.get(x.rpcId);
  obj.addNewSegment(Uint64.parseString(x.segment));
});
