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

import {Annotation, AnnotationId, AnnotationReference, AnnotationType, annotationTypes, deserializeAnnotation, getAnnotationTypeHandler, makeAnnotationId, AnnotationSourceSignals} from 'neuroglancer/annotation';
import {ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, ANNOTATION_COMMIT_UPDATE_RPC_ID, ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID, ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID, ANNOTATION_REFERENCE_ADD_RPC_ID, ANNOTATION_REFERENCE_DELETE_RPC_ID, ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID, AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {MultiscaleSliceViewChunkSource, SliceViewChunk, SliceViewChunkSource, SliceViewChunkSourceOptions} from 'neuroglancer/sliceview/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {binarySearch} from 'neuroglancer/util/array';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {Signal, NullarySignal} from 'neuroglancer/util/signal';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {registerRPC, registerSharedObjectOwner, RPC, SharedObject} from 'neuroglancer/worker_rpc';

interface AnnotationGeometryChunkSourceOptions extends SliceViewChunkSourceOptions {
  spec: AnnotationGeometryChunkSpecification;
  parameters: any;
  parent: Borrowed<MultiscaleAnnotationSource>;
}

export class AnnotationGeometryData {
  buffer: Buffer|undefined;
  bufferValid = false;
  data: Uint8Array|undefined;
  typeToOffset: number[]|undefined;
  numPickIds: number;
  typeToIds: string[][]|undefined;

  constructor(x: any) {
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
    gl;
    const {buffer} = this;
    if (buffer !== undefined) {
      buffer.dispose();
      this.bufferValid = false;
      this.buffer = undefined;
    }
  }
}

export class AnnotationSubsetGeometryChunk extends Chunk {
  source: AnnotationSubsetGeometryChunkSource;
  data: AnnotationGeometryData;
  constructor(source: AnnotationSubsetGeometryChunkSource, x: any) {
    super(source);
    this.data = new AnnotationGeometryData(x);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.data.freeGPUMemory(gl);
  }

  dispose() {
    this.data = <any>undefined;
  }
}

export class AnnotationGeometryChunk extends SliceViewChunk {
  source: AnnotationGeometryChunkSource;
  data: AnnotationGeometryData;

  constructor(source: AnnotationGeometryChunkSource, x: any) {
    super(source, x);
    this.data = new AnnotationGeometryData(x);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.data.freeGPUMemory(gl);
  }

  dispose() {
    this.data = <any>undefined;
  }
}

@registerSharedObjectOwner(ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID)
export class AnnotationGeometryChunkSource extends SliceViewChunkSource {
  parent: Borrowed<MultiscaleAnnotationSource>;
  chunks: Map<string, AnnotationGeometryChunk>;
  spec: AnnotationGeometryChunkSpecification;
  parameters: any;
  immediateChunkUpdates = true;

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

@registerSharedObjectOwner(ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID)
export class AnnotationSubsetGeometryChunkSource extends ChunkSource {
  immediateChunkUpdates = true;
  chunks: Map<string, AnnotationSubsetGeometryChunk>;

  constructor(
      chunkManager: Borrowed<ChunkManager>, public parent: Borrowed<MultiscaleAnnotationSource>) {
    super(chunkManager, {});
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['parent'] = this.parent.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  addChunk(key: string, chunk: AnnotationSubsetGeometryChunk) {
    super.addChunk(key, chunk);
    // TODO: process local deletions
  }

  getChunk(x: any): AnnotationSubsetGeometryChunk {
    return new AnnotationSubsetGeometryChunk(this, x);
  }
}

export class AnnotationMetadataChunk extends Chunk {
  annotation: Annotation|null;
  constructor(source: Borrowed<AnnotationMetadataChunkSource>, x: any) {
    super(source);
    this.annotation = deserializeAnnotation(x.annotation);
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

function updateAnnotation(chunk: AnnotationGeometryData, annotation: Annotation) {
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

function deleteAnnotation(chunk: AnnotationGeometryData, type: AnnotationType, id: AnnotationId) {
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
    MultiscaleSliceViewChunkSource, AnnotationSourceSignals {
  metadataChunkSource =
      this.registerDisposer(new AnnotationMetadataChunkSource(this.chunkManager, this));
  sources: Owned<AnnotationGeometryChunkSource>[][];
  segmentFilteredSource: Owned<AnnotationSubsetGeometryChunkSource>;
  objectToLocal = mat4.create();
  constructor(public chunkManager: Borrowed<ChunkManager>, options: {
    sourceSpecifications: {parameters: any, spec: AnnotationGeometryChunkSpecification}[][]
  }) {
    super();
    this.sources = options.sourceSpecifications.map(
        alternatives => alternatives.map(
            ({parameters, spec}) => this.registerDisposer(new AnnotationGeometryChunkSource(
                chunkManager, {spec, parameters, parent: this}))));
    this.segmentFilteredSource =
        this.registerDisposer(new AnnotationSubsetGeometryChunkSource(chunkManager, this));
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
    this.segmentFilteredSource.initializeCounterpart(rpc, {});
    options.segmentFilteredSource = this.segmentFilteredSource.addCounterpartRef();
    options.metadataChunkSource = this.metadataChunkSource.addCounterpartRef();
    options.sources =
        this.sources.map(alternatives => alternatives.map(source => source.addCounterpartRef()));
    options.chunkManager = this.chunkManager.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  add(annotation: Annotation, commit: boolean = true): AnnotationReference {
    annotation.id = makeAnnotationId();
    const reference = new AnnotationReference(annotation.id);
    reference.value = annotation;
    this.references.set(reference.id, reference);
    reference.registerDisposer(() => {
      this.references.delete(reference.id);
    });
    this.applyLocalUpdate(
        reference, /*existing=*/ false, /*commit=*/ commit, /*newAnnotation=*/ annotation);
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
      this.forEachPossibleChunk(annotation, chunk => {
        deleteAnnotation(chunk.data, annotation.type, id);
      });
      if (newAnnotation !== null) {
        // Add to temporary chunk.
        updateAnnotation(this.temporary.data, newAnnotation);
      }
    } else {
      if (newAnnotation === null) {
        // Annotation has a local update already, so we need to delete it from the temporary chunk.
        deleteAnnotation(this.temporary.data, annotation.type, annotation.id);
      } else {
        // Modify existing entry in temporary chunk.
        updateAnnotation(this.temporary.data, newAnnotation);
      }
      reference.value = newAnnotation;
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

  delete(reference: Borrowed<AnnotationReference>) {
    this.applyLocalUpdate(reference, /*existing=*/ true, /*commit=*/ true, /*newAnnotation=*/ null);
  }

  update(reference: AnnotationReference, newAnnotation: Annotation) {
    this.applyLocalUpdate(
        reference, /*existing=*/ true, /*commit=*/ false, /*newAnnotation=*/ newAnnotation);
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
  commit(reference: Borrowed<AnnotationReference>) {
    this.applyLocalUpdate(reference, /*existing=*/ true, /*commit=*/ true, reference.value!);
  }

  getReference(id: AnnotationId): Owned<AnnotationReference> {
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
      callback: (chunk: AnnotationGeometryChunk|AnnotationSubsetGeometryChunk) => void) {
    const {sources} = this;
    if (sources.length !== 1 || sources[0].length !== 1) {
      throw new Error('Not implemented');
    }
    const source = sources[0][0];
    if (source.chunks.size > 1) {
      throw new Error('Not implemented');
    }
    annotation;
    for (const chunk of source.chunks.values()) {
      callback(chunk);
    }

    const {segments} = annotation;
    if (segments === undefined || segments.length === 0) {
      return;
    }
    const {segmentFilteredSource} = this;
    for (const segment of segments) {
      const chunk = segmentFilteredSource.chunks.get(getObjectKey(segment));
      if (chunk === undefined) {
        continue;
      }
      callback(chunk);
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
      this.references.delete(id);
      this.references.set(newAnnotation.id, localUpdate.reference);
      this.localUpdates.delete(id);
      this.localUpdates.set(newAnnotation.id, localUpdate);
      if (localUpdate.reference.value !== null) {
        localUpdate.reference.value!.id = newAnnotation.id;
        deleteAnnotation(this.temporary.data, localUpdate.type, id);
        updateAnnotation(this.temporary.data, localUpdate.reference.value!);
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
      const status = this.commitStatus = new StatusMessage(/*delay=*/ true);
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
    deleteAnnotation(this.temporary.data, localUpdate.type, localUpdate.reference.id);
    const {existingAnnotation} = localUpdate;
    if (existingAnnotation !== undefined) {
      this.forEachPossibleChunk(existingAnnotation, chunk => {
        updateAnnotation(chunk.data, existingAnnotation);
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
  childAdded: Signal<(annotation: Annotation) => void>;
  childUpdated: Signal<(annotation: Annotation) => void>;
  childDeleted: Signal<(annotationId: string) => void>;
}

registerRPC(ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, function(x) {
  const source = <MultiscaleAnnotationSource>this.get(x.id);
  const annotationId: AnnotationId = x.annotationId;
  const error: string|undefined = x.error;
  if (error !== undefined) {
    source.handleFailedUpdate(annotationId, error);
  } else {
    const newAnnotation: Annotation|null = deserializeAnnotation(x.newAnnotation);
    source.handleSuccessfulUpdate(annotationId, newAnnotation);
  }
});

export class DataFetchSliceViewRenderLayer extends RenderLayer {
  sources: AnnotationGeometryChunkSource[][];

  constructor(multiscaleSource: MultiscaleAnnotationSource) {
    super(multiscaleSource.chunkManager, multiscaleSource.getSources({}), {});
  }

  // Does nothing.
  draw() {}
}
