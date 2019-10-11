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

/**
 * @file Basic annotation data structures.
 */

import {BoundingBox, CoordinateSpaceTransform, WatchableCoordinateSpaceTransform} from 'neuroglancer/coordinate_transform';
import {arraysEqual} from 'neuroglancer/util/array';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {parseArray, parseFixedLengthArray, verifyEnumString, verifyFiniteFloat, verifyFiniteNonNegativeFloat, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {getRandomHexString} from 'neuroglancer/util/random';
import {NullarySignal, Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';

export type AnnotationId = string;

export class AnnotationReference extends RefCounted {
  changed = new NullarySignal();

  /**
   * If `undefined`, we are still waiting to look up the result.  If `null`, annotation has been
   * deleted.
   */
  value: Annotation|null|undefined;

  constructor(public id: AnnotationId) {
    super();
  }
}

export enum AnnotationType {
  POINT,
  LINE,
  AXIS_ALIGNED_BOUNDING_BOX,
  ELLIPSOID,
}

export const annotationTypes = [
  AnnotationType.POINT,
  AnnotationType.LINE,
  AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
  AnnotationType.ELLIPSOID,
];

export interface AnnotationBase {
  /**
   * If equal to `undefined`, then the description is unknown (possibly still being loaded).  If
   * equal to `null`, then there is no description.
   */
  description?: string|undefined|null;

  id: AnnotationId;
  type: AnnotationType;

  segments?: Uint64[];
}

export interface Line extends AnnotationBase {
  pointA: Float32Array;
  pointB: Float32Array;
  type: AnnotationType.LINE;
}

export interface Point extends AnnotationBase {
  point: Float32Array;
  type: AnnotationType.POINT;
}

export interface AxisAlignedBoundingBox extends AnnotationBase {
  pointA: Float32Array;
  pointB: Float32Array;
  type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;
}

export interface Ellipsoid extends AnnotationBase {
  center: Float32Array;
  radii: Float32Array;
  type: AnnotationType.ELLIPSOID;
}

export type Annotation = Line|Point|AxisAlignedBoundingBox|Ellipsoid;

export interface AnnotationTypeHandler<T extends Annotation> {
  icon: string;
  description: string;
  toJSON: (annotation: T, rank: number) => any;
  restoreState: (annotation: T, obj: any, rank: number) => void;
  serializedBytes: (rank: number) => number;
  serializer:
      (buffer: ArrayBuffer, offset: number, numAnnotations: number,
       rank: number) => ((annotation: T, index: number) => void);
}

const typeHandlers = new Map<AnnotationType, AnnotationTypeHandler<Annotation>>();
export function getAnnotationTypeHandler(type: AnnotationType) {
  return typeHandlers.get(type)!;
}

typeHandlers.set(AnnotationType.LINE, {
  icon: 'ꕹ',
  description: 'Line',
  toJSON(annotation: Line) {
    return {
      pointA: Array.from(annotation.pointA),
      pointB: Array.from(annotation.pointB),
    };
  },
  restoreState(annotation: Line, obj: any, rank: number) {
    annotation.pointA = verifyObjectProperty(
        obj, 'pointA', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
    annotation.pointB = verifyObjectProperty(
        obj, 'pointB', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
  },
  serializedBytes(rank: number) {
    return 2 * 4 * rank;
  },
  serializer(buffer: ArrayBuffer, offset: number, numAnnotations: number, rank: number) {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 2 * rank);
    return (annotation: Line, index: number) => {
      const {pointA, pointB} = annotation;
      const coordinateOffset = index * 2 * rank;
      coordinates.set(pointA, coordinateOffset);
      coordinates.set(pointB, coordinateOffset + rank);
    };
  },
});

typeHandlers.set(AnnotationType.POINT, {
  icon: '⚬',
  description: 'Point',
  toJSON: (annotation: Point) => {
    return {
      point: Array.from(annotation.point),
    };
  },
  restoreState: (annotation: Point, obj: any, rank: number) => {
    annotation.point = verifyObjectProperty(
        obj, 'point', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
  },
  serializedBytes: rank => rank * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number, rank: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * rank);
    return (annotation: Point, index: number) => {
      const {point} = annotation;
      const coordinateOffset = index * rank;
      coordinates.set(point, coordinateOffset);
    };
  },
});

typeHandlers.set(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX, {
  icon: '❑',
  description: 'Bounding Box',
  toJSON: (annotation: AxisAlignedBoundingBox) => {
    return {
      pointA: Array.from(annotation.pointA),
      pointB: Array.from(annotation.pointB),
    };
  },
  restoreState: (annotation: AxisAlignedBoundingBox, obj: any, rank: number) => {
    annotation.pointA = verifyObjectProperty(
        obj, 'pointA', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
    annotation.pointB = verifyObjectProperty(
        obj, 'pointB', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
  },
  serializedBytes: rank => 2 * 4 * rank,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number, rank: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 2 * rank);
    return (annotation: AxisAlignedBoundingBox, index: number) => {
      const {pointA, pointB} = annotation;
      const coordinateOffset = index * 2 * rank;
      coordinates.set(pointA, coordinateOffset);
      coordinates.set(pointB, coordinateOffset + rank);
    };
  },
});

typeHandlers.set(AnnotationType.ELLIPSOID, {
  icon: '◎',
  description: 'Ellipsoid',
  toJSON: (annotation: Ellipsoid) => {
    return {
      center: Array.from(annotation.center),
      radii: Array.from(annotation.radii),
    };
  },
  restoreState: (annotation: Ellipsoid, obj: any, rank: number) => {
    annotation.center = verifyObjectProperty(
        obj, 'center', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat));
    annotation.radii = verifyObjectProperty(
        obj, 'radii',
        x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteNonNegativeFloat));
  },
  serializedBytes: rank => 2 * 4 * rank,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number, rank: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 2 * rank);
    return (annotation: Ellipsoid, index: number) => {
      const {center, radii} = annotation;
      const coordinateOffset = index * 2 * rank;
      coordinates.set(center, coordinateOffset);
      coordinates.set(radii, coordinateOffset + rank);
    };
  },
});

function annotationToJson(annotation: Annotation, rank: number) {
  const result = getAnnotationTypeHandler(annotation.type).toJSON(annotation, rank);
  result.type = AnnotationType[annotation.type].toLowerCase();
  result.id = annotation.id;
  result.description = annotation.description || undefined;
  const {segments} = annotation;
  if (segments !== undefined && segments.length > 0) {
    result.segments = segments.map(x => x.toString());
  }
  return result;
}

function restoreAnnotation(obj: any, rank: number, allowMissingId = false): Annotation {
  verifyObject(obj);
  const type = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, AnnotationType));
  const id =
      verifyObjectProperty(obj, 'id', allowMissingId ? verifyOptionalString : verifyString) ||
      makeAnnotationId();
  const result: Annotation = <any>{
    id,
    description: verifyObjectProperty(obj, 'description', verifyOptionalString),
    segments: verifyOptionalObjectProperty(
        obj, 'segments', x => parseArray(x, y => Uint64.parseString(y))),
    type,
  };
  getAnnotationTypeHandler(type).restoreState(result, obj, rank);
  return result;
}

export interface AnnotationSourceSignals {
  changed: NullarySignal;
  childAdded: Signal<(annotation: Annotation) => void>;
  childUpdated: Signal<(annotation: Annotation) => void>;
  childDeleted: Signal<(annotationId: string) => void>;
}

export class AnnotationSource extends RefCounted implements AnnotationSourceSignals {
  protected annotationMap = new Map<AnnotationId, Annotation>();
  changed = new NullarySignal();
  readonly = false;
  childAdded = new Signal<(annotation: Annotation) => void>();
  childUpdated = new Signal<(annotation: Annotation) => void>();
  childDeleted = new Signal<(annotationId: string) => void>();

  private pending = new Set<AnnotationId>();

  protected rank_: number;

  get rank() {
    return this.rank_;
  }

  constructor(rank: number) {
    super();
    this.rank_ = rank;
  }

  add(annotation: Annotation, commit: boolean = true): AnnotationReference {
    this.ensureUpdated();
    if (!annotation.id) {
      annotation.id = makeAnnotationId();
    } else if (this.annotationMap.has(annotation.id)) {
      throw new Error(`Annotation id already exists: ${JSON.stringify(annotation.id)}.`);
    }
    this.annotationMap.set(annotation.id, annotation);
    this.changed.dispatch();
    this.childAdded.dispatch(annotation);
    if (!commit) {
      this.pending.add(annotation.id);
    }
    return this.getReference(annotation.id);
  }

  commit(reference: AnnotationReference): void {
    this.ensureUpdated();
    const id = reference.id;
    this.pending.delete(id);
  }

  update(reference: AnnotationReference, annotation: Annotation) {
    this.ensureUpdated();
    if (reference.value === null) {
      throw new Error(`Annotation already deleted.`);
    }
    reference.value = annotation;
    this.annotationMap.set(annotation.id, annotation);
    reference.changed.dispatch();
    this.changed.dispatch();
    this.childUpdated.dispatch(annotation);
  }

  [Symbol.iterator]() {
    this.ensureUpdated();
    return this.annotationMap.values();
  }

  get(id: AnnotationId) {
    this.ensureUpdated();
    return this.annotationMap.get(id);
  }

  delete(reference: AnnotationReference) {
    if (reference.value === null) {
      return;
    }
    reference.value = null;
    this.annotationMap.delete(reference.id);
    this.pending.delete(reference.id);
    reference.changed.dispatch();
    this.changed.dispatch();
    this.childDeleted.dispatch(reference.id);
  }

  getReference(id: AnnotationId): AnnotationReference {
    let existing = this.references.get(id);
    if (existing !== undefined) {
      return existing.addRef();
    }
    existing = new AnnotationReference(id);
    existing.value = this.annotationMap.get(id) || null;
    this.references.set(id, existing);
    existing.registerDisposer(() => {
      this.references.delete(id);
    });
    return existing;
  }

  references = new Map<AnnotationId, Borrowed<AnnotationReference>>();

  protected ensureUpdated() {}

  toJSON() {
    this.ensureUpdated();
    const result: any[] = [];
    const {pending} = this;
    const {rank} = this;
    for (const annotation of this) {
      if (pending.has(annotation.id)) {
        // Don't serialize uncommitted annotations.
        continue;
      }
      result.push(annotationToJson(annotation, rank));
    }
    return result;
  }

  clear() {
    this.annotationMap.clear();
    this.pending.clear();
    this.changed.dispatch();
  }

  restoreState(obj: any) {
    this.ensureUpdated();
    const {annotationMap} = this;
    annotationMap.clear();
    this.pending.clear();
    const {rank} = this;
    if (obj !== undefined) {
      parseArray(obj, x => {
        const annotation = restoreAnnotation(x, rank);
        annotationMap.set(annotation.id, annotation);
      });
    }
    for (const reference of this.references.values()) {
      const {id} = reference;
      const value = annotationMap.get(id);
      reference.value = value || null;
      reference.changed.dispatch();
    }
    this.changed.dispatch();
  }

  reset() {
    this.clear();
  }
}

export class LocalAnnotationSource extends AnnotationSource {
  private curCoordinateTransform: CoordinateSpaceTransform;

  get rank() {
    this.ensureUpdated();
    return this.rank_;
  }

  constructor(public watchableTransform: WatchableCoordinateSpaceTransform) {
    super(watchableTransform.value.sourceRank);
    this.curCoordinateTransform = watchableTransform.value;
    this.registerDisposer(watchableTransform.changed.add(() => this.ensureUpdated()));
  }

  ensureUpdated() {
    const transform = this.watchableTransform.value;
    const {curCoordinateTransform} = this;
    if (transform === curCoordinateTransform) return;
    this.curCoordinateTransform = transform;
    const sourceRank = transform.sourceRank;
    const oldSourceRank = curCoordinateTransform.sourceRank;
    if (oldSourceRank === sourceRank &&
        ((curCoordinateTransform.inputSpace === transform.inputSpace) ||
         arraysEqual(
             curCoordinateTransform.inputSpace.ids.slice(0, sourceRank),
             transform.inputSpace.ids.slice(0, sourceRank)))) {
      return;
    }
    const {ids: newIds} = transform.inputSpace;
    const oldIds = curCoordinateTransform.inputSpace.ids;
    const newToOldDims: number[] = [];
    for (let newDim = 0; newDim < sourceRank; ++newDim) {
      let oldDim = oldIds.indexOf(newIds[newDim]);
      if (oldDim >= oldSourceRank) {
        oldDim = -1;
      }
      newToOldDims.push(oldDim);
    }
    const mapVector = (radii: Float32Array) => {
      const newRadii = new Float32Array(sourceRank);
      for (let i = 0; i < sourceRank; ++i) {
        const oldDim = newToOldDims[i];
        newRadii[i] = (oldDim === -1) ? 0 : radii[i];
      }
      return newRadii;
    };

    for (const annotation of this.annotationMap.values()) {
      switch (annotation.type) {
        case AnnotationType.POINT:
          annotation.point = mapVector(annotation.point);
          break;
        case AnnotationType.LINE:
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
          annotation.pointA = mapVector(annotation.pointA);
          annotation.pointB = mapVector(annotation.pointB);
          break;
        case AnnotationType.ELLIPSOID:
          annotation.center = mapVector(annotation.center);
          annotation.radii = mapVector(annotation.radii);
          break;
      }
    }
    this.rank_ = sourceRank;
    this.changed.dispatch();
  }
}

export const DATA_BOUNDS_DESCRIPTION = 'Data Bounds';

export function makeAnnotationId() {
  return getRandomHexString(160);
}

export function makeDataBoundsBoundingBoxAnnotation(box: BoundingBox): AxisAlignedBoundingBox {
  return {
    type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
    id: 'data-bounds',
    description: DATA_BOUNDS_DESCRIPTION,
    pointA: new Float32Array(box.lowerBounds),
    pointB: new Float32Array(box.upperBounds),
  };
}

export function makeDataBoundsBoundingBoxAnnotationSet(box: BoundingBox): AnnotationSource {
  const annotationSource = new AnnotationSource(box.lowerBounds.length);
  annotationSource.readonly = true;
  annotationSource.add(makeDataBoundsBoundingBoxAnnotation(box));
  return annotationSource;
}

function compare3WayById(a: Annotation, b: Annotation) {
  return a.id < b.id ? -1 : a.id === b.id ? 0 : 1;
}

export interface SerializedAnnotations {
  data: Uint8Array;
  typeToIds: string[][];
  typeToOffset: number[];
  segmentListIndex: Uint32Array;
  segmentList: Uint32Array;
}

function serializeAnnotations(allAnnotations: Annotation[][], rank: number): SerializedAnnotations {
  let totalBytes = 0;
  const typeToOffset: number[] = [];
  const typeToSegmentListIndexOffset: number[] = [];
  let totalNumSegments = 0;
  let totalNumAnnotations = 0;
  for (const annotationType of annotationTypes) {
    typeToOffset[annotationType] = totalBytes;
    typeToSegmentListIndexOffset[annotationType] = totalNumAnnotations;
    const annotations: Annotation[] = allAnnotations[annotationType];
    let numSegments = 0;
    for (const annotation of annotations) {
      const {segments} = annotation;
      if (segments !== undefined) {
        numSegments += segments.length;
      }
    }
    totalNumAnnotations += annotations.length;
    totalNumSegments += numSegments;
    annotations.sort(compare3WayById);
    const count = annotations.length;
    const handler = getAnnotationTypeHandler(annotationType);
    totalBytes += handler.serializedBytes(rank) * count;
  }
  const segmentListIndex = new Uint32Array(totalNumAnnotations + 1);
  const segmentList = new Uint32Array(totalNumSegments * 2);
  const typeToIds: string[][] = [];
  const data = new ArrayBuffer(totalBytes);
  let segmentListOffset = 0;
  let segmentListIndexOffset = 0;
  for (const annotationType of annotationTypes) {
    const annotations: Annotation[] = allAnnotations[annotationType];
    typeToIds[annotationType] = annotations.map(x => x.id);
    const count = annotations.length;
    const handler = getAnnotationTypeHandler(annotationType);
    const serializer = handler.serializer(data, typeToOffset[annotationType], count, rank);
    annotations.forEach((annotation, index) => {
      serializer(annotation, index);
      segmentListIndex[segmentListIndexOffset++] = segmentListOffset;
      const {segments} = annotation;
      if (segments !== undefined) {
        for (const segment of segments) {
          segmentList[segmentListOffset * 2] = segment.low;
          segmentList[segmentListOffset * 2 + 1] = segment.high;
          ++segmentListOffset;
        }
      }
    });
  }
  return {data: new Uint8Array(data), typeToIds, typeToOffset, segmentListIndex, segmentList};
}

export class AnnotationSerializer {
  annotations: [Point[], Line[], AxisAlignedBoundingBox[], Ellipsoid[]] = [[], [], [], []];
  constructor(public rank: number) {}
  add(annotation: Annotation) {
    (<Annotation[]>this.annotations[annotation.type]).push(annotation);
  }
  serialize() {
    return serializeAnnotations(this.annotations, this.rank);
  }
}

export function deserializeAnnotation(obj: any) {
  if (obj == null) {
    return obj;
  }
  const segments = obj.segments;
  if (segments !== undefined) {
    obj.segments = segments.map((x: {low: number, high: number}) => new Uint64(x.low, x.high));
  }
  return obj;
}
