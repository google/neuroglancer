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

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {assignMeshFragmentData, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {getGrapheneFragmentKey, responseIdentity} from 'neuroglancer/datasource/graphene/base';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {isNotFoundError, responseArrayBuffer, responseJson} from 'neuroglancer/util/http_request';
import {cancellableFetchSpecialOk, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject} from 'neuroglancer/worker_rpc';
import {ChunkedGraphSourceParameters, MeshSourceParameters} from 'neuroglancer/datasource/graphene/base';
import {decodeManifestChunk} from 'neuroglancer/datasource/precomputed/backend';
import {fetchSpecialHttpByteRange} from 'neuroglancer/util/byte_range_http_requests';
import debounce from 'lodash/debounce';
import {withChunkManager, Chunk, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {TransformedSource, forEachPlaneIntersectingVolumetricChunk, getNormalizedChunkLayout, SliceViewProjectionParameters} from 'neuroglancer/sliceview/base';
import {CHUNKED_GRAPH_LAYER_RPC_ID, ChunkedGraphChunkSpecification, CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, RENDER_RATIO_LIMIT} from 'neuroglancer/datasource/graphene/base';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {registerRPC, RPC} from 'neuroglancer/worker_rpc';

import { deserializeTransformedSources, SliceViewChunkSourceBackend } from 'neuroglancer/sliceview/backend';
import { getBasePriority, getPriorityTier, withSharedVisibility } from 'neuroglancer/visibility_priority/backend';
import {isBaseSegmentId} from 'neuroglancer/datasource/graphene/base';
import { withSegmentationLayerBackendState } from 'neuroglancer/segmentation_display_state/backend';
import { RenderedViewBackend, RenderLayerBackend, RenderLayerBackendAttachment } from 'neuroglancer/render_layer_backend';
import { SharedWatchableValue } from 'neuroglancer/shared_watchable_value';
import { DisplayDimensionRenderInfo } from 'neuroglancer/navigation_state';
import { forEachVisibleSegment } from 'neuroglancer/segmentation_display_state/base';
import { computeChunkBounds } from 'neuroglancer/sliceview/volume/backend';

function getVerifiedFragmentPromise(
    credentialsProvider: SpecialProtocolCredentialsProvider,
    chunk: FragmentChunk,
    parameters: MeshSourceParameters,
    cancellationToken: CancellationToken) {
  if (chunk.fragmentId && chunk.fragmentId.charAt(0) === '~') {
    let parts = chunk.fragmentId.substr(1).split(':');
    let startOffset: Uint64|number, endOffset: Uint64|number;
    startOffset = Number(parts[1]);
    endOffset = startOffset+Number(parts[2]);
    return fetchSpecialHttpByteRange(credentialsProvider,
      `${parameters.fragmentUrl}/initial/${parts[0]}`,
      startOffset,
      endOffset,
      cancellationToken
    );
  }
  return cancellableFetchSpecialOk(
    credentialsProvider,
    `${parameters.fragmentUrl}/dynamic/${chunk.fragmentId}`, {}, responseArrayBuffer,
    cancellationToken);
}

function getFragmentDownloadPromise(
    credentialsProvider: SpecialProtocolCredentialsProvider,
    chunk: FragmentChunk,
    parameters: MeshSourceParameters,
    cancellationToken: CancellationToken) {
  let fragmentDownloadPromise;
  if (parameters.sharding){
    fragmentDownloadPromise = getVerifiedFragmentPromise(credentialsProvider, chunk, parameters, cancellationToken);
  } else {
    fragmentDownloadPromise = cancellableFetchSpecialOk(
      credentialsProvider,
      `${parameters.fragmentUrl}/${chunk.fragmentId}`, {}, responseArrayBuffer,
      cancellationToken);
  }
  return fragmentDownloadPromise;
}

async function decodeDracoFragmentChunk(
    chunk: FragmentChunk, response: ArrayBuffer) {
  const m = await import(/* webpackChunkName: "draco" */ 'neuroglancer/mesh/draco');
  const rawMesh = await m.decodeDraco(new Uint8Array(response));
  assignMeshFragmentData(chunk, rawMesh);
}

@registerSharedObject() export class GrapheneMeshSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(MeshSource), MeshSourceParameters)) {
  async download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    if (isBaseSegmentId(chunk.objectId, parameters.nBitsForLayerId)) {
      return decodeManifestChunk(chunk, {fragments: []});
    }
    let url = `${parameters.manifestUrl}/manifest`;
    let manifestUrl = `${url}/${chunk.objectId}:${parameters.lod}?verify=1&prepend_seg_ids=1`;

    await cancellableFetchSpecialOk(this.credentialsProvider, manifestUrl, {}, responseJson, cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  async downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;

    try {
      const response = await getFragmentDownloadPromise(
        undefined, chunk, parameters, cancellationToken);
      await decodeDracoFragmentChunk(chunk, response);
    } catch (e) {
      if (isNotFoundError(e)) {
        chunk.source!.removeChunk(chunk);
      }
      Promise.reject(e);
    }
  }

  getFragmentKey(objectKey: string|null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
  }
}

export class ChunkedGraphChunk extends Chunk {
  backendOnly = true;
  chunkGridPosition: Float32Array;
  source: GrapheneChunkedGraphChunkSource|null = null;
  segment: Uint64;
  leaves: Uint64[] = [];
  chunkDataSize: Uint32Array|null;

  initializeVolumeChunk(key: string, chunkGridPosition: Float32Array) {
    super.initialize(key);
    this.chunkGridPosition = Float32Array.from(chunkGridPosition);
  }

  initializeChunkedGraphChunk(key: string, chunkGridPosition: Float32Array, segment: Uint64) {
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

@registerSharedObject() export class GrapheneChunkedGraphChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(ChunkSource), ChunkedGraphSourceParameters)) {
  spec: ChunkedGraphChunkSpecification;
  chunks: Map<string, ChunkedGraphChunk>;
  tempChunkDataSize: Uint32Array;
  tempChunkPosition: Float32Array;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
    const rank = this.spec.rank;
    this.tempChunkDataSize = new Uint32Array(rank);
    this.tempChunkPosition = new Float32Array(rank);
  }

  async download(chunk: ChunkedGraphChunk, cancellationToken: CancellationToken): Promise<void> {
    let {parameters} = this;
    let chunkPosition = this.computeChunkBounds(chunk);
    let chunkDataSize = chunk.chunkDataSize!;
    let bounds = `${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
        `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
        `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;

    const request = cancellableFetchSpecialOk(this.credentialsProvider,
        `${parameters.url}/${chunk.segment}/leaves?int64_as_str=1&bounds=${bounds}`, {}, responseIdentity,
        cancellationToken);
    await this.withErrorMessage(
        request, `Fetching leaves of segment ${chunk.segment} in region ${bounds}: `)
      .then(res => res.json())
      .then(res => {
        chunk.leaves = decodeChunkedGraphChunk(res['leaf_ids'])
      })
      .catch(err => console.error(err));
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

  async withErrorMessage(promise: Promise<Response>, errorPrefix: string): Promise<Response> {
    const response = await promise;
    if (response.ok) {
      return response;
    } else {
      let msg: string;
      try {
        msg = (await response.json())['message'];
      } catch {
        msg = await response.text();
      }
      throw new Error(`[${response.status}] ${errorPrefix}${msg}`);
    }
  }
}

interface ChunkedGraphRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSource?: TransformedSource<
      ChunkedGraphLayer, GrapheneChunkedGraphChunkSource>;
}

const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();

@registerSharedObject(CHUNKED_GRAPH_LAYER_RPC_ID)
export class ChunkedGraphLayer extends withSegmentationLayerBackendState
(withSharedVisibility(withChunkManager(RenderLayerBackend))) {
  source: GrapheneChunkedGraphChunkSource;
  localPosition: SharedWatchableValue<Float32Array>;
  leafRequestsActive: SharedWatchableValue<boolean>;
  nBitsForLayerId: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(rpc.getRef<GrapheneChunkedGraphChunkSource>(options['source']));
    this.localPosition = rpc.get(options.localPosition);
    this.leafRequestsActive = rpc.get(options.leafRequestsActive);
    this.nBitsForLayerId = rpc.get(options.nBitsForLayerId);

    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateChunkPriorities();
      this.debouncedupdateDisplayState();
    }));
  }

  attach(attachment: RenderLayerBackendAttachment<RenderedViewBackend, ChunkedGraphRenderLayerAttachmentState>): void {
    const scheduleUpdateChunkPriorities = () => this.chunkManager.scheduleUpdateChunkPriorities();
    const {view} = attachment;
    attachment.registerDisposer(scheduleUpdateChunkPriorities);
    attachment.registerDisposer(
        view.projectionParameters.changed.add(scheduleUpdateChunkPriorities));
    attachment.registerDisposer(view.visibility.changed.add(scheduleUpdateChunkPriorities));
    attachment.state = {
      displayDimensionRenderInfo: view.projectionParameters.value.displayDimensionRenderInfo,
    };
  }

  // Used for the sliceview to set a limit on when to
  // make get_leaves to the ChunkedGraph
  get renderRatioLimit() {
    return RENDER_RATIO_LIMIT;
  }

  private updateChunkPriorities() {
    const {source, chunkManager} = this;
    chunkManager.registerLayer(this);
    for (const attachment of this.attachments.values()) {
      const {view} = attachment;
      const visibility = view.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) {
        continue;
      }

      const attachmentState = attachment.state! as ChunkedGraphRenderLayerAttachmentState;
      const {transformedSource: tsource} = attachmentState;
      const projectionParameters = view.projectionParameters.value as SliceViewProjectionParameters;

      if (!tsource) {
        continue;
      }

      const pixelSize = projectionParameters.pixelSize * 1.1;
      const smallestVoxelSize = tsource.effectiveVoxelSize;
      this.leafRequestsActive.value = this.renderRatioLimit >= pixelSize / Math.min(...smallestVoxelSize);
      if (!this.leafRequestsActive.value) {
        continue;
      }

      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility);

      const {chunkLayout} = tsource;
      const {size, finiteRank} = chunkLayout;

      const chunkSize = tempChunkSize;
      const localCenter = tempCenter;
      vec3.copy(chunkSize, size);
      for (let i = finiteRank; i < 3; ++i) {
        chunkSize[i] = 0;
        localCenter[i] = 0;
      }
      const {centerDataPosition} = projectionParameters;
      chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);

      forEachPlaneIntersectingVolumetricChunk(
        projectionParameters, this.localPosition.value, tsource,
        getNormalizedChunkLayout(projectionParameters, chunkLayout),
          positionInChunks => {
        vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
        const priority = -vec3.distance(localCenter, tempChunkPosition);
        const {curPositionInChunks} = tsource;

        forEachVisibleSegment(this, (segment, _) => {
          if (isBaseSegmentId(segment, this.nBitsForLayerId.value)) return; // TODO maybe support highBitRepresentation?
          const chunk = source.getChunk(curPositionInChunks, segment.clone());
          chunkManager.requestChunk(chunk, priorityTier, basePriority + priority);
          ++this.numVisibleChunksNeeded;
          if (chunk.state === ChunkState.GPU_MEMORY) {
            ++this.numVisibleChunksAvailable;
          }
        });
      });
    }
  }

  private forEachSelectedRootWithLeaves(
    callback: (rootObjectKey: string, leaves: Uint64[]) => void) {
      const {source} = this;

      for (const chunk of source.chunks.values()) {
        if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER &&
            chunk.priorityTier < ChunkPriorityTier.RECENT) {
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
        capacities.set(rootObjectKey, capacities.get(rootObjectKey)! + leaves.length);
      }
    });

    // Collect unique leaves
    this.forEachSelectedRootWithLeaves((rootObjectKey, leaves) => {
      if (!visibleLeaves.has(rootObjectKey)) {
        visibleLeaves.set(rootObjectKey, new Uint64Set());
        visibleLeaves.get(rootObjectKey)!.reserve(capacities.get(rootObjectKey)!);
        visibleLeaves.get(rootObjectKey)!.add(Uint64.parseString(rootObjectKey));
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
      const filteredLeaves = [...leaves].filter(x => !this.segmentEquivalences.has(x));

      const rootInt = Uint64.parseString(root);

      for (const leaf of filteredLeaves) {
        this.segmentEquivalences.link(rootInt, leaf);
      }
    }
  }
}

registerRPC(CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, function(x) {
  const view = this.get(x.view) as RenderedViewBackend;
  const layer = this.get(x.layer) as ChunkedGraphLayer;
  const attachment = layer.attachments.get(view)! as
      RenderLayerBackendAttachment<RenderedViewBackend, ChunkedGraphRenderLayerAttachmentState>;
  attachment.state!.transformedSource = deserializeTransformedSources<
      SliceViewChunkSourceBackend, ChunkedGraphLayer>(
      this, x.sources, layer)[0][0] as unknown as TransformedSource<
      ChunkedGraphLayer, GrapheneChunkedGraphChunkSource>;
  attachment.state!.displayDimensionRenderInfo = x.displayDimensionRenderInfo;
  layer.chunkManager.scheduleUpdateChunkPriorities();
});
