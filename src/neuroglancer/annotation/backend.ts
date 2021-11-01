/**
 * @license
 * Copyright 2018 Google Inc.
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

import {Annotation, AnnotationId, fixAnnotationAfterStructuredCloning, SerializedAnnotations} from 'neuroglancer/annotation';
import {ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, ANNOTATION_COMMIT_UPDATE_RPC_ID, ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID, ANNOTATION_PERSPECTIVE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, ANNOTATION_REFERENCE_ADD_RPC_ID, ANNOTATION_REFERENCE_DELETE_RPC_ID, ANNOTATION_RENDER_LAYER_RPC_ID, ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, ANNOTATION_SPATIALLY_INDEXED_RENDER_LAYER_RPC_ID, ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID, AnnotationGeometryChunkSpecification, forEachVisibleAnnotationChunk} from 'neuroglancer/annotation/base';
import {Chunk, ChunkManager, ChunkRenderLayerBackend, ChunkSource, withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {DisplayDimensionRenderInfo, displayDimensionRenderInfosEqual} from 'neuroglancer/navigation_state';
import {RenderedViewBackend, RenderLayerBackend, RenderLayerBackendAttachment} from 'neuroglancer/render_layer_backend';
import {receiveVisibleSegmentsState} from 'neuroglancer/segmentation_display_state/backend';
import {forEachVisibleSegment, getObjectKey, onTemporaryVisibleSegmentsStateChanged, onVisibleSegmentsStateChanged, VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {deserializeTransformedSources, SCALE_PRIORITY_MULTIPLIER, SliceViewChunk, SliceViewChunkSourceBackend} from 'neuroglancer/sliceview/backend';
import {TransformedSource} from 'neuroglancer/sliceview/base';
import {registerNested, WatchableValue} from 'neuroglancer/trackable_value';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Borrowed} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';
import {getBasePriority, getPriorityTier, withSharedVisibility} from 'neuroglancer/visibility_priority/backend';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const ANNOTATION_METADATA_CHUNK_PRIORITY = 200;
const ANNOTATION_SEGMENT_FILTERED_CHUNK_PRIORITY = 60;

export class AnnotationMetadataChunk extends Chunk {
  annotation: Annotation|undefined|null;
  freeSystemMemory() {
    this.annotation = undefined;
  }
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg.annotation = this.annotation;
  }
  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = 0;
    super.downloadSucceeded();
  }
}

export class AnnotationGeometryData implements SerializedAnnotations {
  data: Uint8Array;
  typeToOffset: number[];
  typeToIds: string[][];
  typeToIdMaps: Map<string, number>[];

  serialize(msg: any, transfers: any[]) {
    msg.data = this.data;
    msg.typeToOffset = this.typeToOffset;
    msg.typeToIds = this.typeToIds;
    msg.typeToIdMaps = this.typeToIdMaps;
    transfers.push(this.data.buffer);
  }

  get numBytes() {
    return this.data.byteLength;
  }
}

function GeometryChunkMixin<TBase extends {new (...args: any[]): Chunk}>(Base: TBase) {
  class C extends Base {
    data: AnnotationGeometryData|undefined;
    serialize(msg: any, transfers: any[]) {
      super.serialize(msg, transfers);
      const {data} = this;
      if (data !== undefined) {
        data.serialize(msg, transfers);
        this.data = undefined;
      }
    }

    downloadSucceeded() {
      const {data} = this;
      this.systemMemoryBytes = this.gpuMemoryBytes = data === undefined ? 0 : data.numBytes;
      super.downloadSucceeded();
    }

    freeSystemMemory() {
      this.data = undefined;
    }
  }
  return C;
}

export class AnnotationGeometryChunk extends GeometryChunkMixin
(SliceViewChunk) {
  source: AnnotationGeometryChunkSourceBackend;
}

export class AnnotationSubsetGeometryChunk extends GeometryChunkMixin
(Chunk) {
  source: AnnotationSubsetGeometryChunkSource;
  objectId: Uint64;
}

@registerSharedObject(ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID)
class AnnotationMetadataChunkSource extends ChunkSource {
  parent: Borrowed<AnnotationSource>|undefined = undefined;
  getChunk(id: string) {
    const {chunks} = this;
    let chunk = chunks.get(id);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(AnnotationMetadataChunk);
      chunk.initialize(id);
      this.addChunk(chunk);
    }
    return chunk;
  }

  download(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    return this.parent!.downloadMetadata(chunk, cancellationToken);
  }
}

export class AnnotationGeometryChunkSourceBackend extends
    SliceViewChunkSourceBackend<AnnotationGeometryChunkSpecification, AnnotationGeometryChunk> {
  parent: Borrowed<AnnotationSource>;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parent = rpc.get(options.parent);
  }
}
AnnotationGeometryChunkSourceBackend.prototype.chunkConstructor = AnnotationGeometryChunk;


@registerSharedObject(ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID)
class AnnotationSubsetGeometryChunkSource extends ChunkSource {
  parent: Borrowed<AnnotationSource>|undefined = undefined;
  chunks: Map<string, AnnotationSubsetGeometryChunk>;
  relationshipIndex: number;
  getChunk(objectId: Uint64) {
    const key = getObjectKey(objectId);
    const {chunks} = this;
    let chunk = chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(AnnotationSubsetGeometryChunk);
      chunk.initialize(key);
      chunk.objectId = objectId.clone();
      this.addChunk(chunk);
    }
    return chunk;
  }
  download(chunk: AnnotationSubsetGeometryChunk, cancellationToken: CancellationToken) {
    return this.parent!.downloadSegmentFilteredGeometry(
        chunk, this.relationshipIndex, cancellationToken);
  }
}

export interface AnnotationSource {
  // TODO(jbms): Move this declaration to class definition below and declare abstract once
  // TypeScript supports mixins with abstract classes.
  downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken):
      Promise<void>;
  downloadSegmentFilteredGeometry(
      chunk: AnnotationSubsetGeometryChunk, relationshipIndex: number,
      cancellationToken: CancellationToken): Promise<void>;
}

export class AnnotationSource extends SharedObjectCounterpart {
  references = new Set<AnnotationId>();
  chunkManager: Borrowed<ChunkManager>;
  metadataChunkSource: AnnotationMetadataChunkSource;
  segmentFilteredSources: AnnotationSubsetGeometryChunkSource[];
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const chunkManager = this.chunkManager = <ChunkManager>rpc.get(options.chunkManager);
    const metadataChunkSource = this.metadataChunkSource = this.registerDisposer(
        rpc.getRef<AnnotationMetadataChunkSource>(options.metadataChunkSource));
    this.segmentFilteredSources = (options.segmentFilteredSource as any[]).map((x, i) => {
      const source = this.registerDisposer(rpc.getRef<AnnotationSubsetGeometryChunkSource>(x));
      source.parent = this;
      source.relationshipIndex = i;
      return source;
    });
    metadataChunkSource.parent = this;
    this.registerDisposer(
        chunkManager.recomputeChunkPriorities.add(() => this.recomputeChunkPriorities()));
  }

  private recomputeChunkPriorities() {
    const {chunkManager, metadataChunkSource} = this;
    for (const id of this.references) {
      chunkManager.requestChunk(
          metadataChunkSource.getChunk(id), ChunkPriorityTier.VISIBLE,
          ANNOTATION_METADATA_CHUNK_PRIORITY);
    }
  }

  add(annotation: Annotation): Promise<AnnotationId> {
    annotation;
    throw new Error('Not implemented');
  }
  delete(id: AnnotationId): Promise<void> {
    id;
    throw new Error('Not implemented');
  }
  update(id: AnnotationId, newAnnotation: Annotation): Promise<void> {
    id;
    newAnnotation;
    throw new Error('Not implemented');
  }
}

registerRPC(ANNOTATION_REFERENCE_ADD_RPC_ID, function(x: any) {
  const obj = <AnnotationSource>this.get(x.id);
  obj.references.add(x.annotation);
  obj.chunkManager.scheduleUpdateChunkPriorities();
});

registerRPC(ANNOTATION_REFERENCE_DELETE_RPC_ID, function(x: any) {
  const obj = <AnnotationSource>this.get(x.id);
  obj.references.delete(x.annotation);
  obj.chunkManager.scheduleUpdateChunkPriorities();
});

registerRPC(ANNOTATION_COMMIT_UPDATE_RPC_ID, function(x: any) {
  const obj = <AnnotationSource>this.get(x.id);
  const annotationId: AnnotationId|undefined = x.annotationId;
  const newAnnotation: Annotation|null = fixAnnotationAfterStructuredCloning(x.newAnnotation);

  let promise: Promise<Annotation|null>;
  if (annotationId === undefined) {
    promise = obj.add(newAnnotation!).then(id => ({...newAnnotation!, id}));
  } else if (newAnnotation === null) {
    promise = obj.delete(annotationId).then(() => null);
  } else {
    promise = obj.update(annotationId, newAnnotation).then(() => newAnnotation);
  }
  // FIXME: Handle new chunks requested prior to update but not yet sent to frontend.
  promise.then(
      result => {
        if (!obj.wasDisposed) {
          this.invoke(ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, {
            id: obj.rpcId,
            annotationId: annotationId || newAnnotation!.id,
            newAnnotation: result
          });
        }
      },
      (error: Error) => {
        if (!obj.wasDisposed) {
          this.invoke(ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, {
            id: obj.rpcId,
            annotationId: annotationId || (newAnnotation && newAnnotation.id),
            error: error.message
          });
        }
      });
});

interface AnnotationRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSources: TransformedSource<
      AnnotationSpatiallyIndexedRenderLayerBackend, AnnotationGeometryChunkSourceBackend>[][];
}

@registerSharedObject(ANNOTATION_SPATIALLY_INDEXED_RENDER_LAYER_RPC_ID)
class AnnotationSpatiallyIndexedRenderLayerBackend extends withChunkManager
(RenderLayerBackend) {
  localPosition: SharedWatchableValue<Float32Array>;
  renderScaleTarget: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
    this.localPosition = rpc.get(options.localPosition);
    const scheduleUpdateChunkPriorities = () => this.chunkManager.scheduleUpdateChunkPriorities();
    this.registerDisposer(this.localPosition.changed.add(scheduleUpdateChunkPriorities));
    this.registerDisposer(this.renderScaleTarget.changed.add(scheduleUpdateChunkPriorities));
    this.registerDisposer(
        this.chunkManager.recomputeChunkPriorities.add(() => this.recomputeChunkPriorities()));
  }

  attach(
      attachment:
          RenderLayerBackendAttachment<RenderedViewBackend, AnnotationRenderLayerAttachmentState>) {
    const scheduleUpdateChunkPriorities = () => this.chunkManager.scheduleUpdateChunkPriorities();
    const {view} = attachment;
    attachment.registerDisposer(scheduleUpdateChunkPriorities);
    attachment.registerDisposer(
        view.projectionParameters.changed.add(scheduleUpdateChunkPriorities));
    attachment.registerDisposer(view.visibility.changed.add(scheduleUpdateChunkPriorities));
    attachment.state = {
      displayDimensionRenderInfo: view.projectionParameters.value.displayDimensionRenderInfo,
      transformedSources: [],
    };
  }

  private recomputeChunkPriorities() {
    this.chunkManager.registerLayer(this);
    for (const attachment of this.attachments.values()) {
      const {view} = attachment;
      const visibility = view.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) {
        continue;
      }
      const attachmentState = attachment.state! as AnnotationRenderLayerAttachmentState;
      const {transformedSources, displayDimensionRenderInfo} = attachmentState;
      if (transformedSources.length === 0) continue;
      const viewDisplayDimensionRenderInfo =
          view.projectionParameters.value.displayDimensionRenderInfo;
      if (displayDimensionRenderInfo !== viewDisplayDimensionRenderInfo) {
        if (!displayDimensionRenderInfosEqual(
                displayDimensionRenderInfo, viewDisplayDimensionRenderInfo)) {
          continue;
        }
        attachmentState.displayDimensionRenderInfo = viewDisplayDimensionRenderInfo;
      }
      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility);

      const projectionParameters = view.projectionParameters.value;

      const {chunkManager} = this;
      forEachVisibleAnnotationChunk(
          projectionParameters, this.localPosition.value, this.renderScaleTarget.value,
          transformedSources[0], () => {}, (tsource, scaleIndex) => {
            const chunk = (tsource.source as AnnotationGeometryChunkSourceBackend)
                              .getChunk(tsource.curPositionInChunks);
            ++this.numVisibleChunksNeeded;
            // FIXME: calculate priority
            if (chunk.state === ChunkState.GPU_MEMORY) {
              ++this.numVisibleChunksAvailable;
            }
            let priority = 0;
            chunkManager.requestChunk(
                chunk, priorityTier,
                basePriority + priority + SCALE_PRIORITY_MULTIPLIER * scaleIndex);
          });
    }
  }
}
AnnotationSpatiallyIndexedRenderLayerBackend;

registerRPC(ANNOTATION_PERSPECTIVE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, function(x) {
  const view = this.get(x.view) as RenderedViewBackend;
  const layer = this.get(x.layer) as AnnotationSpatiallyIndexedRenderLayerBackend;
  const attachment = layer.attachments.get(view)! as
      RenderLayerBackendAttachment<RenderedViewBackend, AnnotationRenderLayerAttachmentState>;
  attachment.state!.transformedSources = deserializeTransformedSources<
      AnnotationGeometryChunkSourceBackend, AnnotationSpatiallyIndexedRenderLayerBackend>(
      this, x.sources, layer);
  attachment.state!.displayDimensionRenderInfo = x.displayDimensionRenderInfo;
  layer.chunkManager.scheduleUpdateChunkPriorities();
});

type AnnotationLayerSegmentationState = VisibleSegmentsState|undefined|null;


@registerSharedObject(ANNOTATION_RENDER_LAYER_RPC_ID)
class AnnotationLayerSharedObjectCounterpart extends withSharedVisibility
(withChunkManager(ChunkRenderLayerBackend)) {
  source: AnnotationSource;

  segmentationStates: WatchableValue<AnnotationLayerSegmentationState[]|undefined>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = rpc.get(options.source);
    this.segmentationStates =
        new WatchableValue(this.getSegmentationState(options.segmentationStates));

    const scheduleUpdateChunkPriorities = () => this.chunkManager.scheduleUpdateChunkPriorities();
    this.registerDisposer(registerNested((context, states) => {
      if (states === undefined) return;
      for (const state of states) {
        if (state == null) continue;
        onVisibleSegmentsStateChanged(context, state, scheduleUpdateChunkPriorities);
        onTemporaryVisibleSegmentsStateChanged(context, state, scheduleUpdateChunkPriorities);
      }
      scheduleUpdateChunkPriorities();
    }, this.segmentationStates));
    this.registerDisposer(
        this.chunkManager.recomputeChunkPriorities.add(() => this.recomputeChunkPriorities()));
  }

  private recomputeChunkPriorities() {
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    const {segmentationStates: {value: states}, source: {segmentFilteredSources}} = this;
    if (states === undefined) return;
    const {chunkManager} = this;
    chunkManager.registerLayer(this);
    const numRelationships = states.length;
    for (let i = 0; i < numRelationships; ++i) {
      const state = states[i];
      if (state == null) {
        continue;
      }
      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility);
      const source = segmentFilteredSources[i];
      forEachVisibleSegment(state, objectId => {
        const chunk = source.getChunk(objectId);
        ++this.numVisibleChunksNeeded;
        if (chunk.state === ChunkState.GPU_MEMORY) {
          ++this.numVisibleChunksAvailable;
        }
        chunkManager.requestChunk(
            chunk, priorityTier, basePriority + ANNOTATION_SEGMENT_FILTERED_CHUNK_PRIORITY);
      });
    }
  }

  getSegmentationState(msg: any[]|undefined): AnnotationLayerSegmentationState[]|undefined {
    if (msg === undefined) return undefined;
    return msg.map(x => {
      if (x == null) {
        return x as (undefined | null);
      }
      return receiveVisibleSegmentsState(this.rpc!, x);
    });
  }
}
AnnotationLayerSharedObjectCounterpart;

registerRPC(ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, function(x) {
  const obj = <AnnotationLayerSharedObjectCounterpart>this.get(x.id);
  obj.segmentationStates.value = obj.getSegmentationState(x.segmentationStates);
});
