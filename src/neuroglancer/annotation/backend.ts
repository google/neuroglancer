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

import {Annotation, AnnotationId, deserializeAnnotation, SerializedAnnotations} from 'neuroglancer/annotation';
import {ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, ANNOTATION_COMMIT_UPDATE_RPC_ID, ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID, ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID, ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID, ANNOTATION_REFERENCE_ADD_RPC_ID, ANNOTATION_REFERENCE_DELETE_RPC_ID, ANNOTATION_RENDER_LAYER_RPC_ID, ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID, AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {Chunk, ChunkManager, ChunkSource, withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier} from 'neuroglancer/chunk_manager/base';
import {PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/backend';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {SliceViewChunk, SliceViewChunkSourceBackend} from 'neuroglancer/sliceview/backend';
import {registerNested, WatchableValue} from 'neuroglancer/trackable_value';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Borrowed} from 'neuroglancer/util/disposable';
import {kZeroVec} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {getBasePriority, getPriorityTier} from 'neuroglancer/visibility_priority/backend';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/backend';
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
  segmentListIndex: Uint32Array;
  segmentList: Uint32Array;

  serialize(msg: any, transfers: any[]) {
    msg.data = this.data;
    msg.typeToOffset = this.typeToOffset;
    msg.typeToIds = this.typeToIds;
    msg.segmentList = this.segmentList;
    msg.segmentListIndex = this.segmentListIndex;
    transfers.push(this.data.buffer, this.segmentList.buffer, this.segmentListIndex.buffer);
  }

  get numBytes() {
    return this.data.byteLength;
  }
}

function GeometryChunkMixin<TBase extends { new (...args: any[]): Chunk }>(Base: TBase) {
  class C extends Base {
    data: AnnotationGeometryData|undefined;
    serialize(msg: any, transfers: any[]) {
      super.serialize(msg, transfers);
      this.data!.serialize(msg, transfers);
      this.data = undefined;
    }

    downloadSucceeded() {
      this.systemMemoryBytes = this.gpuMemoryBytes = this.data!.numBytes;
      super.downloadSucceeded();
    }

    freeSystemMemory() {
      this.data = undefined;
    }
  }
  return C;
}

export class AnnotationGeometryChunk extends GeometryChunkMixin(SliceViewChunk) {
  source: AnnotationGeometryChunkSource;
}

export class AnnotationSubsetGeometryChunk extends GeometryChunkMixin(Chunk) {
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

@registerSharedObject(ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID)
class AnnotationGeometryChunkSource extends
    SliceViewChunkSourceBackend<AnnotationGeometryChunkSpecification, AnnotationGeometryChunk> {
  parent: Borrowed<AnnotationSource>|undefined = undefined;
  download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    return this.parent!.downloadGeometry(chunk, cancellationToken);
  }
}
AnnotationGeometryChunkSource.prototype.chunkConstructor = AnnotationGeometryChunk;


@registerSharedObject(ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID)
class AnnotationSubsetGeometryChunkSource extends ChunkSource {
  parent: Borrowed<AnnotationSource>|undefined = undefined;
  chunks: Map<string, AnnotationSubsetGeometryChunk>;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
  }
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
    return this.parent!.downloadSegmentFilteredGeometry(chunk, cancellationToken);
  }
}

export interface AnnotationSource {
  // TODO(jbms): Move this declaration to class definition below and declare abstract once
  // TypeScript supports mixins with abstract classes.
  downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken):
      Promise<void>;
  downloadGeometry(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken):
      Promise<void>;
  downloadSegmentFilteredGeometry(
      chunk: AnnotationSubsetGeometryChunk, cancellationToken: CancellationToken): Promise<void>;
}

export class AnnotationSource extends SharedObjectCounterpart {
  references = new Set<AnnotationId>();
  chunkManager: Borrowed<ChunkManager>;
  metadataChunkSource: AnnotationMetadataChunkSource;
  sources: AnnotationGeometryChunkSource[][];
  segmentFilteredSource: AnnotationSubsetGeometryChunkSource;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const chunkManager = this.chunkManager = <ChunkManager>rpc.get(options.chunkManager);
    const metadataChunkSource = this.metadataChunkSource = this.registerDisposer(
        rpc.getRef<AnnotationMetadataChunkSource>(options.metadataChunkSource));
    this.sources = (<any[][]>options.sources).map(alternatives => alternatives.map(id => {
      const source = this.registerDisposer(rpc.getRef<AnnotationGeometryChunkSource>(id));
      source.parent = this;
      return source;
    }));
    this.segmentFilteredSource = this.registerDisposer(
        rpc.getRef<AnnotationSubsetGeometryChunkSource>(options.segmentFilteredSource));
    this.segmentFilteredSource.parent = this;
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
  const newAnnotation: Annotation|null = deserializeAnnotation(x.newAnnotation);

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
          this.invoke(
              ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID,
              {id: obj.rpcId, annotationId, error: error.message});
        }
      });
});

@registerSharedObject(ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID)
class AnnotationPerspectiveRenderLayer extends PerspectiveViewRenderLayer {
  source: AnnotationSource;
  filterBySegmentation: SharedWatchableValue<boolean>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = rpc.get(options.source);
    this.filterBySegmentation = rpc.get(options.filterBySegmentation);
    this.viewStates.changed.add(() => this.source.chunkManager.scheduleUpdateChunkPriorities());
    this.filterBySegmentation.changed.add(
        () => this.source.chunkManager.scheduleUpdateChunkPriorities());
    this.registerDisposer(this.source.chunkManager.recomputeChunkPriorities.add(
        () => this.recomputeChunkPriorities()));
  }

  private recomputeChunkPriorities() {
    const {source} = this;
    if (this.filterBySegmentation.value) {
      return;
    }
    for (const state of this.viewStates) {
      const visibility = state.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) {
        continue;
      }
      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility);
      // FIXME: priority should be based on location
      for (const alternatives of source.sources) {
        for (const geometrySource of alternatives) {
          const chunk = geometrySource.getChunk(kZeroVec);
          source.chunkManager.requestChunk(chunk, priorityTier, basePriority);
        }
      }
    }
  }
}
AnnotationPerspectiveRenderLayer;


@registerSharedObject(ANNOTATION_RENDER_LAYER_RPC_ID)
class AnnotationLayerSharedObjectCounterpart extends withSharedVisibility(withChunkManager(SharedObjectCounterpart)) {
  source: AnnotationSource;

  segmentationState = new WatchableValue<
      {visibleSegments: Uint64Set, segmentEquivalences: SharedDisjointUint64Sets}|undefined|null>(
      undefined);

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = rpc.get(options.source);
    this.segmentationState.value = this.getSegmentationState(options.segmentationState);

    const scheduleUpdateChunkPriorities = () => this.chunkManager.scheduleUpdateChunkPriorities();
    this.registerDisposer(registerNested(this.segmentationState, (context, state) => {
      if (state != null) {
        context.registerDisposer(state.visibleSegments.changed.add(scheduleUpdateChunkPriorities));
        context.registerDisposer(
            state.segmentEquivalences.changed.add(scheduleUpdateChunkPriorities));
      }
    }));
    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(
        () => this.recomputeChunkPriorities()));
  }

  private recomputeChunkPriorities() {
    const state = this.segmentationState.value;
    if (state == null) {
      return;
    }
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    const priorityTier = getPriorityTier(visibility);
    const basePriority = getBasePriority(visibility);
    const {chunkManager} = this;
    const source = this.source.segmentFilteredSource;
    forEachVisibleSegment(state, objectId => {
      const chunk = source.getChunk(objectId);
      chunkManager.requestChunk(
          chunk, priorityTier, basePriority + ANNOTATION_SEGMENT_FILTERED_CHUNK_PRIORITY);
    });
  }

  getSegmentationState(msg: any) {
    if (msg == null) {
      return msg;
    }
    return {
      visibleSegments: this.rpc!.get(msg.visibleSegments),
      segmentEquivalences: this.rpc!.get(msg.segmentEquivalences)
    };
  }
}
AnnotationLayerSharedObjectCounterpart;

registerRPC(ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID, function(x) {
  const obj = <AnnotationLayerSharedObjectCounterpart>this.get(x.id);
  obj.segmentationState.value = obj.getSegmentationState(x.segmentationState);
});
