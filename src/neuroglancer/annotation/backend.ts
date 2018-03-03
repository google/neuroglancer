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

import {Annotation, AnnotationId} from 'neuroglancer/annotation';
import {ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, ANNOTATION_COMMIT_UPDATE_RPC_ID, ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID, ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID, ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID, ANNOTATION_REFERENCE_ADD_RPC_ID, ANNOTATION_REFERENCE_DELETE_RPC_ID, AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier} from 'neuroglancer/chunk_manager/base';
import {PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/backend';
import {SliceViewChunk, SliceViewChunkSource} from 'neuroglancer/sliceview/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Borrowed} from 'neuroglancer/util/disposable';
import {kZeroVec} from 'neuroglancer/util/geom';
import {getBasePriority, getPriorityTier} from 'neuroglancer/visibility_priority/backend';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

const ANNOTATION_METADATA_CHUNK_PRIORITY = 200;

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

export class AnnotationGeometryChunk extends SliceViewChunk {
  source: AnnotationGeometryChunkSource;
  data: Uint8Array|undefined;
  typeToOffset: number[]|undefined;
  typeToIds: string[][]|undefined;
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg.data = this.data;
    msg.typeToOffset = this.typeToOffset;
    msg.typeToIds = this.typeToIds;
    transfers.push(this.data!.buffer);
    this.typeToOffset = undefined;
    this.typeToIds = undefined;
    this.data = undefined;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data!.byteLength;
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.typeToOffset = undefined;
    this.typeToIds = undefined;
    this.data = undefined;
  }
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
class AnnotationGeometryChunkSource extends SliceViewChunkSource {
  parent: Borrowed<AnnotationSource>|undefined = undefined;
  spec: AnnotationGeometryChunkSpecification;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = new AnnotationGeometryChunkSpecification(options.spec);
  }
  download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    return this.parent!.downloadGeometry(chunk, cancellationToken);
  }
}
AnnotationGeometryChunkSource.prototype.chunkConstructor = AnnotationGeometryChunk;

export interface AnnotationSource {
  // TODO(jbms): Move this declaration to class definition below and declare abstract once
  // TypeScript supports mixins with abstract classes.
  downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken):
      Promise<void>;
  downloadGeometry(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken):
      Promise<void>;
}

export class AnnotationSource extends SharedObjectCounterpart {
  references = new Set<AnnotationId>();
  chunkManager: Borrowed<ChunkManager>;
  metadataChunkSource: AnnotationMetadataChunkSource;
  sources: AnnotationGeometryChunkSource[][];
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
  const newAnnotation: Annotation|null = x.newAnnotation;

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
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = rpc.get(options.source);
    this.viewStates.changed.add(() => this.source.chunkManager.scheduleUpdateChunkPriorities());
    this.registerDisposer(this.source.chunkManager.recomputeChunkPriorities.add(
        () => this.recomputeChunkPriorities()));
  }
  private recomputeChunkPriorities() {
    const {source} = this;
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
