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

import {Annotation, AnnotationId, AnnotationReference, AnnotationType, annotationTypes, getAnnotationTypeHandler, makeAnnotationId} from 'neuroglancer/annotation';
import {ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, ANNOTATION_COMMIT_UPDATE_RPC_ID, ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID, ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID, ANNOTATION_REFERENCE_ADD_RPC_ID, ANNOTATION_REFERENCE_DELETE_RPC_ID, AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {MultiscaleSliceViewChunkSource, SliceViewChunk, SliceViewChunkSource, SliceViewChunkSourceOptions} from 'neuroglancer/sliceview/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {binarySearch} from 'neuroglancer/util/array';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {registerRPC, registerSharedObjectOwner, RPC, SharedObject} from 'neuroglancer/worker_rpc';

interface AnnotationGeometryChunkSourceOptions extends SliceViewChunkSourceOptions {
  spec: AnnotationGeometryChunkSpecification;
  parameters: any;
  parent: Borrowed<MultiscaleAnnotationSource>;
}

@registerSharedObjectOwner(ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID)
export class AnnotationGeometryChunkSource extends SliceViewChunkSource {
  parent: Borrowed<MultiscaleAnnotationSource>;
  chunks: Map<string, AnnotationGeometryChunk>;
  spec: AnnotationGeometryChunkSpecification;
  parameters: any;
  constructor(chunkManager: Borrowed<ChunkManager>, options: AnnotationGeometryChunkSourceOptions) {
    super(chunkManager, options);
    this.parent = options.parent;
    this.parameters = options.parameters;
    this.spec = options.spec;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['parameters'] = this.parameters;
    options['parent'] = this.parent.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  addChunk(key: string, chunk: AnnotationGeometryChunk) {
    super.addChunk(key, chunk);
    // TODO: process local deletions
  }

  getChunk(x: any) {
    return new AnnotationGeometryChunk(this, x);
  }
}

export class AnnotationGeometryChunk extends SliceViewChunk {
  buffer: Buffer|undefined;
  bufferValid = false;
  data: Uint8Array|undefined;
  typeToOffset: number[]|undefined;
  numPickIds: number;
  typeToIds: string[][]|undefined;
  typeToDescription: string[][]|undefined;
  spec: AnnotationGeometryChunkSpecification;

  immediateChunkUpdates = true;

  constructor(source: AnnotationGeometryChunkSource, x: any) {
    super(source, x);
    this.data = x.data;
    const typeToIds = this.typeToIds = x.typeToIds;
    let numPickIds = 0;
    for (const annotationType of annotationTypes) {
      numPickIds += getAnnotationTypeRenderHandler(annotationType).pickIdsPerInstance *
          typeToIds[annotationType].length;
    }
    this.numPickIds = numPickIds;
    this.typeToOffset = x.typeToOffset;
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    const {buffer} = this;
    if (buffer !== undefined) {
      buffer.dispose();
      this.bufferValid = false;
      this.buffer = undefined;
    }
  }

  dispose() {
    this.data = undefined;
    this.typeToIds = undefined;
    this.typeToDescription = undefined;
    this.typeToOffset = undefined;
  }
}

export class AnnotationMetadataChunk extends Chunk {
  annotation: Annotation|null;
  constructor(source: Borrowed<AnnotationMetadataChunkSource>, x: any) {
    super(source);
    this.annotation = x.annotation;
  }
}

@registerSharedObjectOwner(ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID)
export class AnnotationMetadataChunkSource extends ChunkSource {
  chunks: Map<string, AnnotationMetadataChunk>;
  constructor(
      chunkManager: Borrowed<ChunkManager>, public parent: Borrowed<MultiscaleAnnotationSource>) {
    super(chunkManager);
  }
  getChunk(x: any): AnnotationMetadataChunk {
    return new AnnotationMetadataChunk(this, x);
  }
  addChunk(key: string, chunk: AnnotationMetadataChunk) {
    super.addChunk(key, chunk);
    const {references} = this.parent;
    const reference = references.get(key);
    if (reference !== undefined) {
      reference.value = chunk.annotation;
      reference.changed.dispatch();
    }
  }
  deleteChunk(key: string) {
    const {references} = this.parent;
    const reference = references.get(key);
    if (reference !== undefined) {
      reference.value = undefined;
      reference.changed.dispatch();
    }
  }
  initializeCounterpart(rpc: RPC, options: any) {
    options['parent'] = this.parent.rpcId;
    super.initializeCounterpart(rpc, options);
  }
}

function updateAnnotation(chunk: AnnotationGeometryChunk, annotation: Annotation) {
  // Find insertion point.
  const type = annotation.type;
  let ids = chunk.typeToIds![type];
  const handler = getAnnotationTypeHandler(type);
  const numBytes = handler.serializedBytes;
  const renderHandler = getAnnotationTypeRenderHandler(type);
  let insertionPoint = binarySearch(ids, annotation.id, (a, b) => a < b ? -1 : a === b ? 0 : 1);
  let offset = 0;
  if (insertionPoint < 0) {
    // Doesn't already exist.
    insertionPoint = ~insertionPoint;
    ids.splice(insertionPoint, 0, annotation.id);
    const newData = new Uint8Array(chunk.data!.length + numBytes);
    chunk.numPickIds += renderHandler.pickIdsPerInstance;
    offset = chunk.typeToOffset![type] + numBytes * insertionPoint;
    newData.set(chunk.data!.subarray(0, offset), 0);
    newData.set(chunk.data!.subarray(offset), offset + numBytes);
    chunk.data = newData;
  } else {
    offset = chunk.typeToOffset![type] + handler.serializedBytes * insertionPoint;
  }
  const serializer = handler.serializer(chunk.data!.buffer, chunk.typeToOffset![type], ids.length);
  serializer(annotation, insertionPoint);
  for (const otherType of annotationTypes) {
    if (otherType > type) {
      chunk.typeToOffset![otherType] += numBytes;
    }
  }
  chunk.bufferValid = false;
}

function deleteAnnotation(chunk: AnnotationGeometryChunk, type: AnnotationType, id: AnnotationId) {
  let ids = chunk.typeToIds![type];
  const handler = getAnnotationTypeRenderHandler(type);
  const numBytes = handler.bytes;
  let insertionPoint = binarySearch(ids, id, (a, b) => a < b ? -1 : a === b ? 0 : 1);
  if (insertionPoint < 0) {
    return false;
  }
  chunk.numPickIds -= handler.pickIdsPerInstance;
  ids.splice(insertionPoint, 1);
  const offset = chunk.typeToOffset![type] + handler.bytes * insertionPoint;
  const newData = new Uint8Array(chunk.data!.length - numBytes);
  newData.set(chunk.data!.subarray(0, offset), 0);
  newData.set(chunk.data!.subarray(offset + numBytes), offset);
  chunk.data = newData;
  for (const otherType of annotationTypes) {
    if (otherType > type) {
      chunk.typeToOffset![otherType] -= numBytes;
    }
  }
  chunk.bufferValid = false;
  return true;
}

///  send add operation to backend   -->   does source-specific thing on backend   -->
///      if success: backend sends chunk update (frontend adds    -->  backend sends add completion
///      notification if failure: backend sends add failure notification  -->  delete from
///      temporary, display message

//   send update operation
//       if success: backend sends chunk update   -->  backend sends update completion notification


interface LocalUpdateUndoState {
  /**
   * If commitInProgress === undefined, this must be undefined.  Otherwise, it specifies a commit
   * that has been requested and which will be initiated as soon as the in-progress request
   * completes.
   */
  pendingCommit: Annotation|null|undefined;

  reference: Owned<AnnotationReference>;

  /**
   * The state of the annotation prior to any local modifications.
   */
  existingAnnotation: Annotation|undefined;

  /**
   * If not undefined, a commit has been sent to the backend, and we are waiting for the result.
   */
  commitInProgress: Annotation|null|undefined;
  type: AnnotationType;
}

function makeTemporaryChunk() {
  const typeToIds: string[][] = [];
  const typeToOffset: number[] = [];
  for (const annotationType of annotationTypes) {
    typeToIds[annotationType] = [];
    typeToOffset[annotationType] = 0;
  }
  return new AnnotationGeometryChunk(
      <AnnotationGeometryChunkSource><any>undefined,
      {data: new Uint8Array(0), numPickIds: 0, typeToOffset, typeToIds});
}

export class MultiscaleAnnotationSource extends SharedObject implements
    MultiscaleSliceViewChunkSource {
  metadataChunkSource =
      this.registerDisposer(new AnnotationMetadataChunkSource(this.chunkManager, this));
  sources: Owned<AnnotationGeometryChunkSource>[][];
  objectToLocal = mat4.create();
  constructor(public chunkManager: Borrowed<ChunkManager>, options: {
    sourceSpecifications: {parameters: any, spec: AnnotationGeometryChunkSpecification}[][]
  }) {
    super();
    this.sources = options.sourceSpecifications.map(
        alternatives => alternatives.map(
            ({parameters, spec}) => this.registerDisposer(new AnnotationGeometryChunkSource(
                chunkManager, {spec, parameters, parent: this}))));
  }

  getSources(_options: SliceViewSourceOptions): AnnotationGeometryChunkSource[][] {
    const {sources} = this;
    sources.forEach(alternatives => alternatives.forEach(source => source.addRef()));
    return sources;
  }

  temporary = makeTemporaryChunk();

  references = new Map<AnnotationId, Borrowed<AnnotationReference>>();

  localUpdates = new Map<AnnotationId, LocalUpdateUndoState>();

  initializeCounterpart(rpc: RPC, options: any) {
    this.metadataChunkSource.initializeCounterpart(rpc, {});
    for (const alternatives of this.sources) {
      for (const source of alternatives) {
        source.initializeCounterpart(rpc, {});
      }
    }
    options.metadataChunkSource = this.metadataChunkSource.addCounterpartRef();
    options.sources =
        this.sources.map(alternatives => alternatives.map(source => source.addCounterpartRef()));
    options.chunkManager = this.chunkManager.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  // methods supported by backend:
  //   delete annotation (id)
  //   add annotation (Annotation)
  //   update annotation (generation, Annotation)
  //   get annotation (id)

  // messages supported by frontend:
  //   update chunk (source, chunk, modified annotations, deleted ids, ids moved to another chunk)
  //     this needs to update any annotation references

  // frontend keeps list of local deletions
  ///  to apply a local deletion, we need to know which source/chunk it applies to, which requires
  ///  knowing its position.

  // To process local deletions:
  //   when we add the local deletion, we immediately apply it to chunks known to the frontend
  //   additionally, whenever we receive a chunk from the backend that was received prior to
  //   confirmation of the operation, we also need to apply them if the deletion fails, we need to
  //   go ahead

  add(annotation: Annotation, commit: boolean = true): AnnotationReference {
    annotation.id = makeAnnotationId();
    const reference = new AnnotationReference(annotation.id);
    reference.value = annotation;
    this.applyLocalUpdate(
        reference, /*existing=*/false, /*commit=*/commit, /*newAnnotation=*/annotation);
    return reference;
  }

  private applyLocalUpdate(
      reference: Borrowed<AnnotationReference>, existing: boolean, commit: boolean,
      newAnnotation: Annotation|null): void {
    const {localUpdates} = this;
    const {id} = reference;
    let localUpdate = this.localUpdates.get(id);
    const annotation = reference.value;
    if (annotation == null) {
      throw new Error(`Cannot create local update from null annotation`);
    }
    if (localUpdate === undefined) {
      localUpdate = {
        type: annotation.type,
        reference: reference.addRef(),
        existingAnnotation: existing ? annotation : undefined,
        pendingCommit: undefined,
        commitInProgress: undefined,
      };
      localUpdates.set(id, localUpdate);
      this.forEachPossibleChunk(annotation, (key, chunk) => {
        key;
        deleteAnnotation(chunk, annotation.type, id);
      });
      if (newAnnotation !== null) {
        // Add to temporary chunk.
        updateAnnotation(this.temporary, newAnnotation);
      }
    } else {
      if (newAnnotation === null) {
        // Annotation has a local update already, so we need to delete it from the temporary chunk.
        deleteAnnotation(this.temporary, annotation.type, annotation.id);
      } else {
        // Modify existing entry in temporary chunk.
        updateAnnotation(this.temporary, newAnnotation);
      }
    }
    if (commit) {
      if (localUpdate.commitInProgress !== undefined) {
        localUpdate.pendingCommit = newAnnotation;
      } else {
        if (newAnnotation === null && localUpdate.existingAnnotation === undefined) {
          // Local update, which we would now like to delete, has never been committed.
          // Therefore we can just delete it locally.
          localUpdates.delete(id);
          localUpdate.reference.dispose();
          return;
        }
        this.sendCommitRequest(localUpdate, newAnnotation);
      }
    }
    this.notifyChanged(reference.id, newAnnotation || undefined);
  }

  private sendCommitRequest(localUpdate: LocalUpdateUndoState, newAnnotation: Annotation|null) {
    this.updateCommitsInProgress(1);
    localUpdate.commitInProgress = newAnnotation;
    this.rpc!.invoke(ANNOTATION_COMMIT_UPDATE_RPC_ID, {
      id: this.rpcId,
      annotationId: localUpdate.existingAnnotation && localUpdate.reference.id,
      newAnnotation,
    });
  }

  delete(reference: AnnotationReference) {
    this.applyLocalUpdate(reference, /*existing=*/true, /*commit=*/true, /*newAnnotation=*/null);
  }

  update(reference: AnnotationReference, newAnnotation: Annotation) {
    this.applyLocalUpdate(
        reference, /*existing=*/true, /*commit=*/false, /*newAnnotation=*/newAnnotation);
  }

  private notifyChanged(id: AnnotationId, annotation: Annotation|undefined) {
    const reference = this.references.get(id);
    const chunk = this.metadataChunkSource.chunks.get(id);
    if (chunk !== undefined) {
      chunk.annotation = annotation || null;
    }
    if (reference !== undefined) {
      reference.value = annotation || null;
      reference.changed.dispatch();
    }
    this.chunkManager.chunkQueueManager.visibleChunksChanged.dispatch();
  }

  /**
   * Must be called after `add` or `update` to commit the result.
   */
  commit(reference: AnnotationReference) {
    this.applyLocalUpdate(reference, /*existing=*/true, /*commit=*/true, reference.value!);
  }

  getReference(id: AnnotationId): AnnotationReference {
    let existing = this.references.get(id);
    if (existing !== undefined) {
      return existing.addRef();
    }
    existing = new AnnotationReference(id);
    this.references.set(id, existing);
    this.rpc!.invoke(ANNOTATION_REFERENCE_ADD_RPC_ID, {id: this.rpcId, annotation: id});
    existing.registerDisposer(() => {
      this.references.delete(id);
      this.rpc!.invoke(ANNOTATION_REFERENCE_DELETE_RPC_ID, {id: this.rpcId, annotation: id});
    });
    const chunk = this.metadataChunkSource.chunks.get(id);
    if (chunk !== undefined) {
      existing.value = chunk.annotation;
    }
    return existing;
  }

  private forEachPossibleChunk(
      annotation: Annotation,
      callback: (chunkKey: string, chunk: AnnotationGeometryChunk) => void) {
    const {sources} = this;
    if (sources.length !== 1 || sources[0].length !== 1) {
      throw new Error('Not implemented');
    }
    const source = sources[0][0];
    if (source.chunks.size > 1) {
      throw new Error('Not implemented');
    }
    annotation;
    for (const [chunkKey, chunk] of source.chunks) {
      callback(chunkKey, chunk);
    }
  }

  static encodeOptions(_options: {}): {[key: string]: any} {
    return {};
  }

  handleSuccessfulUpdate(id: AnnotationId, newAnnotation: Annotation|null) {
    const localUpdate = this.localUpdates.get(id);
    if (localUpdate === undefined || localUpdate.commitInProgress === undefined) {
      throw new Error(`Received invalid successful update notification`);
    }
    this.updateCommitsInProgress(-1);
    if (newAnnotation !== null && localUpdate.reference.id !== newAnnotation.id) {
      if (localUpdate.commitInProgress === null) {
        throw new Error(`Received invalid successful update notification`);
      }
      localUpdate.reference.id = newAnnotation.id;
      this.localUpdates.delete(id);
      this.localUpdates.set(newAnnotation.id, localUpdate);
      if (localUpdate.reference.value !== null) {
        localUpdate.reference.value!.id = newAnnotation.id;
        deleteAnnotation(this.temporary, localUpdate.type, id);
        updateAnnotation(this.temporary, localUpdate.reference.value!);
      }
      localUpdate.reference.changed.dispatch();
    }
    localUpdate.existingAnnotation = newAnnotation || undefined;
    localUpdate.commitInProgress = undefined;
    let {pendingCommit} = localUpdate;
    localUpdate.pendingCommit = undefined;
    if (newAnnotation === null) {
      pendingCommit = undefined;
    }
    if (pendingCommit !== undefined) {
      if (pendingCommit !== null) {
        pendingCommit.id = newAnnotation!.id;
      }
      this.sendCommitRequest(localUpdate, pendingCommit);
    } else {
      this.revertLocalUpdate(localUpdate);
    }
  }

  private numCommitsInProgress = 0;

  private commitStatus: StatusMessage|undefined;

  disposed() {
    const {commitStatus} = this;
    if (commitStatus !== undefined) {
      commitStatus.dispose();
    }
  }

  private updateCommitsInProgress(amount: number) {
    this.numCommitsInProgress += amount;
    if (this.numCommitsInProgress === 0) {
      if (this.commitStatus !== undefined) {
        this.commitStatus.dispose();
        this.commitStatus = undefined;
      }
    } else if (this.commitStatus === undefined) {
      const status = this.commitStatus = new StatusMessage(/*delay=*/true);
      status.setText('Commiting annotations');
    }
  }

  handleFailedUpdate(id: AnnotationId, message: string) {
    const localUpdate = this.localUpdates.get(id);
    if (localUpdate === undefined || localUpdate.commitInProgress === undefined) {
      throw new Error(`Received invalid update notification`);
    }
    const status = new StatusMessage();
    status.setErrorMessage(`Error commiting annotation update: ${message}`);
    this.revertLocalUpdate(localUpdate);
    this.updateCommitsInProgress(-1);
  }

  private revertLocalUpdate(localUpdate: LocalUpdateUndoState) {
    deleteAnnotation(this.temporary, localUpdate.type, localUpdate.reference.id);
    const {existingAnnotation} = localUpdate;
    if (existingAnnotation !== undefined) {
      this.forEachPossibleChunk(existingAnnotation, (chunkKey, chunk) => {
        chunkKey;
        updateAnnotation(chunk, existingAnnotation);
      });
    }
    const {reference} = localUpdate;
    const {id} = reference;

    reference.value = existingAnnotation || null;
    reference.changed.dispatch();

    reference.dispose();

    this.localUpdates.delete(id);
  }

  // FIXME
  changed = new NullarySignal();
  * [Symbol.iterator](): Iterator<Annotation> {}
  readonly = false;
}

registerRPC(ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, function(x) {
  const source = <MultiscaleAnnotationSource>this.get(x.id);
  const annotationId: AnnotationId = x.annotationId;
  const error: string|undefined = x.error;
  if (error !== undefined) {
    source.handleFailedUpdate(annotationId, error);
  } else {
    const newAnnotation: Annotation|null = x.newAnnotation;
    source.handleSuccessfulUpdate(annotationId, newAnnotation);
  }
});

export class DataFetchSliceViewRenderLayer extends RenderLayer {
  sources: AnnotationGeometryChunkSource[][];

  constructor(multiscaleSource: MultiscaleAnnotationSource) {
    super(multiscaleSource.chunkManager, multiscaleSource.getSources({}));
  }

  // Does nothing.
  draw() {}
}
