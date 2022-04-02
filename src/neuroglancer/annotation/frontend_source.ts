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

import {Annotation, AnnotationId, AnnotationPropertySerializer, AnnotationPropertySpec, AnnotationReference, AnnotationSourceSignals, AnnotationType, annotationTypeHandlers, annotationTypes, fixAnnotationAfterStructuredCloning, makeAnnotationId, makeAnnotationPropertySerializers, SerializedAnnotations} from 'neuroglancer/annotation';
import {ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, ANNOTATION_COMMIT_UPDATE_RPC_ID, ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID, ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID, ANNOTATION_REFERENCE_ADD_RPC_ID, ANNOTATION_REFERENCE_DELETE_RPC_ID, ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID, AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {MultiscaleSliceViewChunkSource, SliceViewChunk, SliceViewChunkSource, SliceViewChunkSourceOptions, SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {ENDIANNESS, Endianness} from 'neuroglancer/util/endian';
import * as matrix from 'neuroglancer/util/matrix';
import {NullarySignal, Signal} from 'neuroglancer/util/signal';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {registerRPC, registerSharedObjectOwner, RPC, SharedObject} from 'neuroglancer/worker_rpc';

export interface AnnotationGeometryChunkSourceOptions extends SliceViewChunkSourceOptions {
  spec: AnnotationGeometryChunkSpecification;
  parent: Borrowed<MultiscaleAnnotationSource>;
}

export function computeNumPickIds(serializedAnnotations: SerializedAnnotations) {
  let numPickIds = 0;
  const {typeToIds} = serializedAnnotations;
  for (const annotationType of annotationTypes) {
    numPickIds += getAnnotationTypeRenderHandler(annotationType).pickIdsPerInstance *
        typeToIds[annotationType].length;
  }
  return numPickIds;
}

export class AnnotationGeometryData {
  buffer: Buffer|undefined;
  bufferValid = false;
  serializedAnnotations: SerializedAnnotations;
  numPickIds: number = 0;

  constructor(x: SerializedAnnotations) {
    this.serializedAnnotations = {
      data: x.data,
      typeToIds: x.typeToIds,
      typeToOffset: x.typeToOffset,
      typeToIdMaps: x.typeToIdMaps
    };
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
  // undefined indicates chunk not found
  data: AnnotationGeometryData|undefined;
  constructor(source: AnnotationSubsetGeometryChunkSource, x: any) {
    super(source);
    if (x.data !== undefined) {
      this.data = new AnnotationGeometryData(x);
    }
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    const {data} = this;
    if (data !== undefined) {
      data.freeGPUMemory(gl);
    }
  }

  dispose() {
    this.data = undefined;
  }
}

export class AnnotationGeometryChunk extends SliceViewChunk {
  source: AnnotationGeometryChunkSource;
  // undefined indicates chunk not found
  data: AnnotationGeometryData|undefined;

  constructor(source: AnnotationGeometryChunkSource, x: any) {
    super(source, x);
    if (x.data !== undefined) {
      this.data = new AnnotationGeometryData(x);
    }
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    const {data} = this;
    if (data !== undefined) {
      data.freeGPUMemory(gl);
    }
  }

  dispose() {
    this.data = undefined;
  }
}

@registerSharedObjectOwner(ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID)
export class AnnotationGeometryChunkSource extends
    SliceViewChunkSource<AnnotationGeometryChunkSpecification, AnnotationGeometryChunk> {
  OPTIONS: AnnotationGeometryChunkSourceOptions;
  parent: Borrowed<MultiscaleAnnotationSource>;
  immediateChunkUpdates = true;

  /**
   * Transforms positions in the MultiscaleAnnotationSource coordinate space to grid cell
   * coordinates.  Equal to the inverse of `this.spec.chunkToMultiscaleTransform`, with rows divided
   * by `this.spec.chunkDataSize`.
   */
  multiscaleToChunkTransform: Float32Array;

  constructor(chunkManager: Borrowed<ChunkManager>, options: AnnotationGeometryChunkSourceOptions) {
    super(chunkManager, options);
    const parent = this.parent = options.parent;
    parent.spatiallyIndexedSources.add(this);
    const {rank, chunkDataSize} = this.spec;
    const multiscaleToChunkTransform = this.multiscaleToChunkTransform =
        new Float32Array((rank + 1) ** 2);
    matrix.inverse(
        multiscaleToChunkTransform, rank + 1, this.spec.chunkToMultiscaleTransform, rank + 1,
        rank + 1);
    for (let i = 0; i < rank; ++i) {
      for (let j = 0; j < rank + 1; ++j) {
        multiscaleToChunkTransform[(rank + 1) * j + i] /= chunkDataSize[i];
      }
    }
  }

  disposed() {
    this.parent.spatiallyIndexedSources.delete(this);
    super.disposed();
  }

  initializeCounterpart(rpc: RPC, options: any) {
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
      chunkManager: Borrowed<ChunkManager>, public parent: Borrowed<MultiscaleAnnotationSource>,
      public relationshipIndex: number) {
    super(chunkManager, {});
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
    this.annotation = fixAnnotationAfterStructuredCloning(x.annotation);
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
}

function copyOtherAnnotations(
    serializedAnnotations: SerializedAnnotations,
    propertySerializers: AnnotationPropertySerializer[], excludedType: AnnotationType,
    excludedTypeAdjustment: number): Uint8Array {
  const newData = new Uint8Array(serializedAnnotations.data.length + excludedTypeAdjustment);
  // Copy all other annotation types
  for (const otherType of annotationTypes) {
    if (otherType === excludedType) continue;
    let otherTypeOffset = serializedAnnotations.typeToOffset![otherType];
    let newTypeOffset = otherTypeOffset;
    if (otherType > excludedType) {
      newTypeOffset += excludedTypeAdjustment;
      serializedAnnotations.typeToOffset![otherType] = newTypeOffset;
    }
    newData.set(
        serializedAnnotations.data.subarray(
            otherTypeOffset,
            otherTypeOffset +
                serializedAnnotations.typeToIds[otherType].length *
                    propertySerializers[otherType].serializedBytes),
        newTypeOffset);
  }
  return newData;
}

function copyAnnotationSlice(
    serializedAnnotations: SerializedAnnotations,
    propertySerializers: AnnotationPropertySerializer[], type: AnnotationType, dest: Uint8Array,
    sourceBeginIndex: number, sourceEndIndex: number, destBeginIndex: number, destCount: number) {
  const typeOffset = serializedAnnotations.typeToOffset[type];
  let sourceGroupOffset = typeOffset;
  let destGroupOffset = typeOffset;
  const {propertyGroupBytes} = propertySerializers[type];
  const numGroups = propertyGroupBytes.length;
  const count = serializedAnnotations.typeToIds[type].length;
  for (let groupIndex = 0; groupIndex < numGroups; ++groupIndex) {
    const groupBytes = propertyGroupBytes[groupIndex];
    dest.set(
        serializedAnnotations.data.subarray(
            sourceGroupOffset + sourceBeginIndex * groupBytes,
            sourceGroupOffset + sourceEndIndex * groupBytes),
        destGroupOffset + destBeginIndex * groupBytes);
    sourceGroupOffset += groupBytes * count;
    destGroupOffset += groupBytes * destCount;
  }
}

export function updateAnnotation(
    chunk: AnnotationGeometryData, annotation: Annotation,
    propertySerializers: AnnotationPropertySerializer[]) {
  // Find insertion point.
  const type = annotation.type;
  const {rank} = propertySerializers[type];
  const {serializedAnnotations} = chunk;
  const ids = serializedAnnotations.typeToIds[type];
  const idMap = serializedAnnotations.typeToIdMaps[type];
  const handler = annotationTypeHandlers[type];
  const numBytes = propertySerializers[type].serializedBytes;
  let index = idMap.get(annotation.id);
  if (index === undefined) {
    // Doesn't already exist.
    index = idMap.size;
    idMap.set(annotation.id, index);
    const newData =
        copyOtherAnnotations(serializedAnnotations, propertySerializers, type, numBytes);
    copyAnnotationSlice(
        serializedAnnotations, propertySerializers, type, newData, /*sourceBeginIndex=*/ 0,
        /*sourceEndIndex=*/ index, /*destBeginIndex=*/ 0, /*destCount=*/ index + 1);
    ids.push(annotation.id);
    serializedAnnotations.data = newData;
  }
  const bufferOffset = serializedAnnotations.typeToOffset![type];
  const dv = new DataView(
      serializedAnnotations.data.buffer, serializedAnnotations.data.byteOffset,
      serializedAnnotations.data.byteLength);
  const isLittleEndian = ENDIANNESS === Endianness.LITTLE;
  const propertySerializer = propertySerializers[type];
  handler.serialize(
      dv, bufferOffset + propertySerializer.propertyGroupBytes[0] * index, isLittleEndian, rank,
      annotation);
  propertySerializer.serialize(
      dv, bufferOffset, index, ids.length, isLittleEndian, annotation.properties);
  chunk.bufferValid = false;
}

export function deleteAnnotation(
    chunk: AnnotationGeometryData, type: AnnotationType, id: AnnotationId,
    propertySerializers: AnnotationPropertySerializer[]): boolean {
  const {serializedAnnotations} = chunk;
  const idMap = serializedAnnotations.typeToIdMaps[type];
  const index = idMap.get(id);
  if (index === undefined) {
    return false;
  }
  const ids = serializedAnnotations.typeToIds[type];
  const numBytes = propertySerializers[type].serializedBytes;
  const newData = copyOtherAnnotations(serializedAnnotations, propertySerializers, type, -numBytes);
  copyAnnotationSlice(
      serializedAnnotations, propertySerializers, type, newData, /*sourceBeginIndex=*/ 0,
      /*sourceEndIndex=*/ index, /*destBeginIndex=*/ 0, /*destCount=*/ ids.length - 1);
  copyAnnotationSlice(
      serializedAnnotations, propertySerializers, type, newData, /*sourceBeginIndex=*/ index + 1,
      /*sourceEndIndex=*/ ids.length, /*destBeginIndex=*/ index, /*destCount=*/ ids.length - 1);
  ids.splice(index, 1);
  idMap.delete(id);
  for (let i = index, count = ids.length; i < count; ++i) {
    idMap.set(ids[i], i);
  }
  serializedAnnotations.data = newData;
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

export function makeTemporaryChunk() {
  const typeToIds: string[][] = [];
  const typeToOffset: number[] = [];
  const typeToIdMaps: Map<string, number>[] = [];
  for (const annotationType of annotationTypes) {
    typeToIds[annotationType] = [];
    typeToOffset[annotationType] = 0;
    typeToIdMaps[annotationType] = new Map();
  }
  return new AnnotationGeometryChunk(
      <AnnotationGeometryChunkSource><any>undefined,
      {data: new Uint8Array(0), numPickIds: 0, typeToOffset, typeToIds, typeToIdMaps});
}

export class MultiscaleAnnotationSource extends SharedObject implements
    MultiscaleSliceViewChunkSource<AnnotationGeometryChunkSource>, AnnotationSourceSignals {
  OPTIONS: {};
  key: any;
  metadataChunkSource =
      this.registerDisposer(new AnnotationMetadataChunkSource(this.chunkManager, this));
  segmentFilteredSources: Owned<AnnotationSubsetGeometryChunkSource>[];
  spatiallyIndexedSources = new Set<Borrowed<AnnotationGeometryChunkSource>>();
  rank: number;
  readonly relationships: readonly string[];
  readonly properties: Readonly<AnnotationPropertySpec>[];
  readonly annotationPropertySerializers: AnnotationPropertySerializer[];
  constructor(public chunkManager: Borrowed<ChunkManager>, options: {
    rank: number,
    relationships: readonly string[],
    properties: Readonly<AnnotationPropertySpec>[]
  }) {
    super();
    this.rank = options.rank;
    this.properties = options.properties;
    this.annotationPropertySerializers =
        makeAnnotationPropertySerializers(this.rank, this.properties);
    const segmentFilteredSources: Owned<AnnotationSubsetGeometryChunkSource>[] =
        this.segmentFilteredSources = [];
    const {relationships} = options;
    this.relationships = relationships;
    for (let i = 0, count = relationships.length; i < count; ++i) {
      segmentFilteredSources.push(
          this.registerDisposer(new AnnotationSubsetGeometryChunkSource(chunkManager, this, i)));
    }
  }

  hasNonSerializedProperties() {
    return this.relationships.length > 0;
  }

  getSources(_options: SliceViewSourceOptions):
      SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    throw new Error('not implemented');
  }

  temporary = makeTemporaryChunk();

  references = new Map<AnnotationId, Borrowed<AnnotationReference>>();

  localUpdates = new Map<AnnotationId, LocalUpdateUndoState>();

  initializeCounterpart(rpc: RPC, options: any) {
    this.metadataChunkSource.initializeCounterpart(rpc, {});
    for (const source of this.segmentFilteredSources) {
      source.initializeCounterpart(rpc, {});
    }
    options.segmentFilteredSource = this.segmentFilteredSources.map(x => x.addCounterpartRef());
    options.metadataChunkSource = this.metadataChunkSource.addCounterpartRef();
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
        const {data} = chunk;
        if (data === undefined) return;
        const annotationType = annotation.type;
        deleteAnnotation(data, annotationType, id, this.annotationPropertySerializers);
      });
      if (newAnnotation !== null) {
        // Add to temporary chunk.
        updateAnnotation(this.temporary.data!, newAnnotation, this.annotationPropertySerializers);
      }
    } else {
      if (newAnnotation === null) {
        // Annotation has a local update already, so we need to delete it from the temporary chunk.
        deleteAnnotation(
            this.temporary.data!, annotation.type, annotation.id,
            this.annotationPropertySerializers);
      } else {
        // Modify existing entry in temporary chunk.
        updateAnnotation(this.temporary.data!, newAnnotation, this.annotationPropertySerializers);
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
    annotation;
    const {relatedSegments} = annotation;
    if (relatedSegments !== undefined) {
      const numRelationships = relatedSegments.length;
      const {segmentFilteredSources} = this;
      for (let i = 0; i < numRelationships; ++i) {
        const segments = relatedSegments[i];
        if (segments === undefined) return;
        const source = segmentFilteredSources[i];
        for (const segment of segments) {
          const chunk = source.chunks.get(getObjectKey(segment));
          if (chunk === undefined) {
            continue;
          }
          callback(chunk);
        }
      }
    }
    const {rank} = this;
    const tempLower = new Float32Array(rank);
    const tempUpper = new Float32Array(rank);
    const tempChunk = new Float32Array(rank);
    for (const source of this.spatiallyIndexedSources) {
      switch (annotation.type) {
        case AnnotationType.POINT:
          matrix.transformPoint(
              tempLower, source.multiscaleToChunkTransform, rank + 1, annotation.point, rank);
          tempUpper.set(tempLower);
          break;
        case AnnotationType.LINE:
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
          matrix.transformPoint(
              tempLower, source.multiscaleToChunkTransform, rank + 1, annotation.pointA, rank);
          matrix.transformPoint(
              tempUpper, source.multiscaleToChunkTransform, rank + 1, annotation.pointB, rank);
          break;
        case AnnotationType.ELLIPSOID:
          matrix.transformPoint(
              tempLower, source.multiscaleToChunkTransform, rank + 1, annotation.center, rank);
          matrix.transformVector(
              tempUpper, source.multiscaleToChunkTransform, rank + 1, annotation.radii, rank);
          for (let i = 0; i < rank; ++i) {
            const c = tempLower[i];
            const r = tempUpper[i];
            tempLower[i] = c - r;
            tempUpper[i] = c + r;
          }
          break;
      }
      let totalChunks = 1;
      for (let i = 0; i < rank; ++i) {
        const a = tempLower[i];
        const b = tempUpper[i];
        const lower = Math.min(a, b);
        const upper = Math.max(a, b);
        // In the case that the point lies directly on a boundary, ensure it is included in both
        // chunks, since we don't know how the datasource handles this case.
        tempLower[i] = Math.ceil(lower - 1);
        tempUpper[i] = Math.floor(upper + 1);
        totalChunks *= (tempUpper[i] - tempLower[i]);
      }
      const {chunks} = source;
      for (let chunkIndex = 0; chunkIndex < totalChunks; ++chunkIndex) {
        let remainder = chunkIndex;
        for (let i = 0; i < rank; ++i) {
          const lower = tempLower[i];
          const upper = tempUpper[i];
          const size = upper - lower;
          const x = tempChunk[i] = remainder % size;
          remainder = (remainder - x) / size;
        }
        const chunk = chunks.get(tempChunk.join());
        if (chunk !== undefined) {
          callback(chunk);
        }
      }
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
        deleteAnnotation(
            this.temporary.data!, localUpdate.type, id, this.annotationPropertySerializers);
        updateAnnotation(
            this.temporary.data!, localUpdate.reference.value!, this.annotationPropertySerializers);
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
    deleteAnnotation(
        this.temporary.data!, localUpdate.type, localUpdate.reference.id,
        this.annotationPropertySerializers);
    const {existingAnnotation} = localUpdate;
    if (existingAnnotation !== undefined) {
      this.forEachPossibleChunk(existingAnnotation, chunk => {
        const {data} = chunk;
        if (data === undefined) return;
        updateAnnotation(data, existingAnnotation, this.annotationPropertySerializers);
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
    const newAnnotation: Annotation|null = fixAnnotationAfterStructuredCloning(x.newAnnotation);
    source.handleSuccessfulUpdate(annotationId, newAnnotation);
  }
});
