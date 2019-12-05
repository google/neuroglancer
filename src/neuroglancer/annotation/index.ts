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

import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseArray, verify3dScale, verify3dVec, verifyEnumString, verifyObject, verifyObjectProperty, verifyOptionalBoolean, verifyOptionalString, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
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
  COLLECTION,
  LINE_STRIP,
  SPOKE
}

export const annotationTypes = [
  AnnotationType.POINT, AnnotationType.LINE, AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
  AnnotationType.ELLIPSOID, AnnotationType.COLLECTION, AnnotationType.LINE_STRIP,
  AnnotationType.SPOKE
];

export interface AnnotationBase {
  /**
   * If equal to `undefined`, then the description is unknown (possibly still being loaded).  If
   * equal to `null`, then there is no description.
   */
  description?: string|undefined|null;
  tagIds?: Set<number>;

  id: AnnotationId;
  type: AnnotationType;

  segments?: Uint64[];

  parentId?: string;
}

export interface Line extends AnnotationBase {
  pointA: vec3;
  pointB: vec3;
  type: AnnotationType.LINE;
}
export interface Point extends AnnotationBase {
  point: vec3;
  type: AnnotationType.POINT;
}

export interface AxisAlignedBoundingBox extends AnnotationBase {
  pointA: vec3;
  pointB: vec3;
  type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;
}

export interface Ellipsoid extends AnnotationBase {
  center: vec3;
  radii: vec3;
  type: AnnotationType.ELLIPSOID;
}

// Collections //
export interface Collection extends AnnotationBase {
  lastA?: AnnotationReference;
  lastB?: AnnotationReference;
  entries: string[];
  type: AnnotationType.COLLECTION|AnnotationType.LINE_STRIP|AnnotationType.SPOKE;
  connected: boolean;
  source: vec3;
  entry: Function;
  segmentSet: Function;
  childrenVisible: TrackableBoolean;
}

export interface LineStrip extends Collection {
  looped?: boolean;
  type: AnnotationType.LINE_STRIP;
  connected: true;
}

export interface Spoke extends Collection {
  wheeled?: boolean;
  type: AnnotationType.SPOKE;
  connected: true;
}

export type Annotation = Line|Point|AxisAlignedBoundingBox|Ellipsoid|Collection|LineStrip|Spoke;

export interface AnnotationTag {
  id: number;
  label: string;
}

type AnnotationNode = Annotation&{
  prev: AnnotationNode;
  next: AnnotationNode;
};

export interface AnnotationTypeHandler<T extends Annotation> {
  icon: string;
  description: string;
  title: string;
  toJSON: (annotation: T) => any;
  restoreState: (annotation: T, obj: any) => void;
  serializedBytes: number;
  serializer:
      (buffer: ArrayBuffer, offset: number,
       numAnnotations: number) => ((annotation: T, index: number) => void);
}

const typeHandlers = new Map<AnnotationType, AnnotationTypeHandler<Annotation>>();
export function getAnnotationTypeHandler(type: AnnotationType) {
  return typeHandlers.get(type)!;
}

typeHandlers.set(AnnotationType.LINE, {
  icon: 'ꕹ',
  description: 'Line',
  title: 'Annotate line',
  toJSON: (annotation: Line) => {
    return {
      pointA: Array.from(annotation.pointA),
      pointB: Array.from(annotation.pointB),
    };
  },
  restoreState: (annotation: Line, obj: any) => {
    annotation.pointA = verifyObjectProperty(obj, 'pointA', verify3dVec);
    annotation.pointB = verifyObjectProperty(obj, 'pointB', verify3dVec);
  },
  serializedBytes: 6 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 6);
    return (annotation: Line, index: number) => {
      const {pointA, pointB} = annotation;
      const coordinateOffset = index * 6;
      coordinates[coordinateOffset] = pointA[0];
      coordinates[coordinateOffset + 1] = pointA[1];
      coordinates[coordinateOffset + 2] = pointA[2];
      coordinates[coordinateOffset + 3] = pointB[0];
      coordinates[coordinateOffset + 4] = pointB[1];
      coordinates[coordinateOffset + 5] = pointB[2];
    };
  },
});

typeHandlers.set(AnnotationType.POINT, {
  icon: '⚬',
  description: 'Point',
  title: 'Annotate Point',
  toJSON: (annotation: Point) => {
    return {
      point: Array.from(annotation.point),
    };
  },
  restoreState: (annotation: Point, obj: any) => {
    annotation.point = verifyObjectProperty(obj, 'point', verify3dVec);
  },
  serializedBytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: Point, index: number) => {
      const {point} = annotation;
      const coordinateOffset = index * 3;
      coordinates[coordinateOffset] = point[0];
      coordinates[coordinateOffset + 1] = point[1];
      coordinates[coordinateOffset + 2] = point[2];
    };
  },
});

typeHandlers.set(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX, {
  icon: '❑',
  description: 'Bounding Box',
  title: 'Annotate bounding box',
  toJSON: (annotation: AxisAlignedBoundingBox) => {
    return {
      pointA: Array.from(annotation.pointA),
      pointB: Array.from(annotation.pointB),
    };
  },
  restoreState: (annotation: AxisAlignedBoundingBox, obj: any) => {
    annotation.pointA = verifyObjectProperty(obj, 'pointA', verify3dVec);
    annotation.pointB = verifyObjectProperty(obj, 'pointB', verify3dVec);
  },
  serializedBytes: 6 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 6);
    return (annotation: AxisAlignedBoundingBox, index: number) => {
      const {pointA, pointB} = annotation;
      const coordinateOffset = index * 6;
      coordinates[coordinateOffset] = Math.min(pointA[0], pointB[0]);
      coordinates[coordinateOffset + 1] = Math.min(pointA[1], pointB[1]);
      coordinates[coordinateOffset + 2] = Math.min(pointA[2], pointB[2]);
      coordinates[coordinateOffset + 3] = Math.max(pointA[0], pointB[0]);
      coordinates[coordinateOffset + 4] = Math.max(pointA[1], pointB[1]);
      coordinates[coordinateOffset + 5] = Math.max(pointA[2], pointB[2]);
    };
  },
});

typeHandlers.set(AnnotationType.ELLIPSOID, {
  icon: '◎',
  description: 'Ellipsoid',
  title: 'Annotate Ellipsoid',
  toJSON: (annotation: Ellipsoid) => {
    return {
      center: Array.from(annotation.center),
      radii: Array.from(annotation.radii),
    };
  },
  restoreState: (annotation: Ellipsoid, obj: any) => {
    annotation.center = verifyObjectProperty(obj, 'center', verify3dVec);
    annotation.radii = verifyObjectProperty(obj, 'radii', verify3dScale);
  },
  serializedBytes: 6 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 6);
    return (annotation: Ellipsoid, index: number) => {
      const {center, radii} = annotation;
      const coordinateOffset = index * 6;
      coordinates.set(center, coordinateOffset);
      coordinates.set(radii, coordinateOffset + 3);
    };
  },
});

const collectionTypeSet = {
  icon: '⚄',
  description: 'Collection',
  title: 'Group together multiple annotations',
  toJSON: (annotation: Collection) => {
    return {
      source: Array.from(annotation.source),
      entries: Array.from(annotation.entries),
      childrenVisible: annotation.childrenVisible.value,
      looped: (<LineStrip>annotation).looped
    };
  },
  restoreState: (annotation: Collection, obj: any) => {
    annotation.source = verifyObjectProperty(obj, 'source', verify3dVec);
    annotation.entries = obj.entries.filter((v: any) => typeof v === 'string');
    annotation.childrenVisible = new TrackableBoolean(obj.childrenVisible, true);
    (<LineStrip>annotation).looped = verifyObjectProperty(obj, 'looped', verifyOptionalBoolean);
  },
  serializedBytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: Collection, index: number) => {
      const {source} = annotation;
      const coordinateOffset = index * 3;
      coordinates[coordinateOffset] = source[0];
      coordinates[coordinateOffset + 1] = source[1];
      coordinates[coordinateOffset + 2] = source[2];
    };
  },
};

typeHandlers.set(AnnotationType.COLLECTION, collectionTypeSet);

typeHandlers.set(AnnotationType.LINE_STRIP, {
  ...collectionTypeSet,
  title: 'Annotate multiple connected points',
  icon: 'ʌ',
  description: 'Line Strip',
});

typeHandlers.set(AnnotationType.SPOKE, {
  ...collectionTypeSet,
  title: 'Annotate radially connected points',
  icon: '⚹',
  description: 'Spoke',
});

function restoreAnnotationsTags(tagsObj: any) {
  const tagIds = new Set<number>();
  if (tagsObj !== undefined) {
    parseArray(tagsObj, x => {
      tagIds.add(verifyPositiveInt(x));
    });
  }
  return tagIds;
}

export function annotationToJson(annotation: Annotation) {
  const result = getAnnotationTypeHandler(annotation.type).toJSON(annotation);
  result.type = AnnotationType[annotation.type].toLowerCase();
  result.id = annotation.id;
  result.description = annotation.description || undefined;
  result.tagIds = (annotation.tagIds) ? [...annotation.tagIds] : undefined;
  result.parentId = annotation.parentId || undefined;
  const {segments} = annotation;
  if (segments !== undefined && segments.length > 0) {
    result.segments = segments.map(x => x.toString());
  }
  return result;
}

export function restoreAnnotation(obj: any, allowMissingId = false): Annotation {
  verifyObject(obj);
  const tagIds = verifyObjectProperty(obj, 'tagIds', x => restoreAnnotationsTags(x));
  const type = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, AnnotationType));
  const id =
      verifyObjectProperty(obj, 'id', allowMissingId ? verifyOptionalString : verifyString) ||
      makeAnnotationId();
  const result: Annotation = <any>{
    id,
    description: verifyObjectProperty(obj, 'description', verifyOptionalString),
    tagIds,
    segments: verifyObjectProperty(
        obj, 'segments',
        x => x === undefined ? undefined : parseArray(x, y => Uint64.parseString(y))),
    type,
    parentId: verifyObjectProperty(obj, 'parentId', verifyOptionalString),
  };
  getAnnotationTypeHandler(type).restoreState(result, obj);
  return result;
}

export interface AnnotationSourceSignals {
  changed: NullarySignal;
  childAdded: Signal<(annotation: Annotation) => void>;
  childrenAdded: Signal<(annotations: Annotation[]) => void>;
  childUpdated: Signal<(annotation: Annotation) => void>;
  childDeleted: Signal<(annotationId: string) => void>;
  tagAdded: Signal<(tag: AnnotationTag) => void>;
  tagUpdated: Signal<(tag: AnnotationTag) => void>;
  tagDeleted: Signal<(tagId: number) => void>;
  getTags: () => Iterable<AnnotationTag>;
}

function restoreAnnotationTag(obj: any): AnnotationTag {
  verifyObject(obj);
  const result: AnnotationTag = <any>{
    id: verifyObjectProperty(obj, 'id', verifyPositiveInt),
    label: verifyObjectProperty(obj, 'label', verifyString)
  };
  return result;
}

export class AnnotationSource extends RefCounted implements AnnotationSourceSignals {
  private annotationMap = new Map<AnnotationId, AnnotationNode>();
  private tags = new Map<number, AnnotationTag>();
  private maxTagId = 0;
  private lastAnnotationNodeMap =
      new Map<AnnotationId|undefined, AnnotationNode|null>([[undefined, null]]);
  changed = new NullarySignal();
  readonly = false;
  childAdded = new Signal<(annotation: Annotation) => void>();
  childrenAdded = new Signal<(annotations: Annotation[]) => void>();
  childUpdated = new Signal<(annotation: Annotation) => void>();
  childDeleted = new Signal<(annotationId: string) => void>();
  tagAdded = new Signal<(tag: AnnotationTag) => void>();
  tagUpdated = new Signal<(tag: AnnotationTag) => void>();
  tagDeleted = new Signal<(tagId: number) => void>();

  private pending = new Set<AnnotationId>();

  constructor(public objectToLocal = mat4.create()) {
    super();
  }

  addTag(label: string) {
    this.maxTagId++;
    const tag = <AnnotationTag>{id: this.maxTagId, label};
    this.tags.set(this.maxTagId, tag);
    this.changed.dispatch();
    this.tagAdded.dispatch(tag);
    return this.maxTagId;
  }

  deleteTag(tagId: number) {
    const tag = this.tags.get(tagId);
    if (tag) {
      this.tags.delete(tagId);
      for (const annotation of this.annotationMap.values()) {
        if (annotation.tagIds) {
          annotation.tagIds.delete(tagId);
        }
      }
      this.changed.dispatch();
      this.tagDeleted.dispatch(tagId);
    }
  }

  updateTagLabel(tagId: number, newLabel: string) {
    const tag = this.tags.get(tagId);
    if (tag) {
      tag.label = newLabel;
      this.changed.dispatch();
      this.tagUpdated.dispatch(tag);
    }
  }

  private validateTags(annotation: Annotation) {
    if (annotation.tagIds) {
      annotation.tagIds.forEach(tagId => {
        const annotationTag = this.tags.get(tagId);
        if (!annotationTag) {
          throw new Error(
              `AnnotationTag id ${tagId} listed for Annotation ${annotation.id} does not exist`);
        }
      });
    }
    return true;
  }

  private updateAnnotationNode(id: AnnotationId, annotation: Annotation) {
    const existingAnnotation = this.annotationMap.get(id);
    if (existingAnnotation) {
      this.validateTags(annotation);
      Object.assign(existingAnnotation, annotation);
    }
  }

  private insertAnnotationNode(annotation: Annotation) {
    this.validateTags(annotation);
    let annotationNode: any = {...annotation, prev: null, next: null};
    const parentNodeId = <AnnotationId|undefined>annotationNode.parentId;
    const matchingAnnotationNode = this.lastAnnotationNodeMap.get(parentNodeId);
    if (matchingAnnotationNode) {
      annotationNode.prev = matchingAnnotationNode;
      annotationNode.next = matchingAnnotationNode.next;
      annotationNode = <AnnotationNode>annotationNode;
      matchingAnnotationNode.next = annotationNode;
      annotationNode.next.prev = annotationNode;
    } else {
      annotationNode.prev = annotationNode.next = annotationNode;
      annotationNode = <AnnotationNode>annotationNode;
    }
    this.lastAnnotationNodeMap.set(annotationNode.parentId, annotationNode);

    if (annotation.type === AnnotationType.COLLECTION ||
        annotation.type === AnnotationType.LINE_STRIP || annotation.type === AnnotationType.SPOKE) {
      annotationNode.entry = (index: number) => this.get(annotationNode.entries[index]);

      annotationNode.segmentSet = () => {
        annotationNode.segments = [];
        annotationNode.entries.forEach((ref: any, index: number) => {
          ref;
          const child = <Annotation>annotationNode.entry(index);
          if (annotationNode.segments && child.segments) {
            annotationNode.segments = [...annotationNode.segments!, ...child.segments];
          }
        });
        if (annotationNode.segments) {
          annotationNode.segments =
              [...new Set(annotationNode.segments.map((e: Uint64) => e.toString()))].map(
                  (s: string) => Uint64.parseString(s));
        }
        return annotationNode.segments;
      };
    }
    this.annotationMap.set(annotation.id, annotationNode);
  }

  private deleteAnnotationNode(id: AnnotationId) {
    const existingAnnotation = this.annotationMap.get(id);
    if (existingAnnotation) {
      const parentNodeId = <AnnotationId|undefined>existingAnnotation.parentId;
      const matchingAnnotationNode = this.lastAnnotationNodeMap.get(parentNodeId);
      this.annotationMap.delete(id);
      if (this.annotationMap.size > 0) {
        existingAnnotation.prev.next = existingAnnotation.next;
        existingAnnotation.next.prev = existingAnnotation.prev;
        if (matchingAnnotationNode === existingAnnotation) {
          this.lastAnnotationNodeMap.set(parentNodeId, existingAnnotation.prev);
        }
      } else {
        this.lastAnnotationNodeMap.set(parentNodeId, null);
      }
    }
    return existingAnnotation;
  }

  getNextAnnotation(id: AnnotationId): Annotation|undefined {
    const existingAnnotation = this.annotationMap.get(id);
    if (existingAnnotation) {
      return existingAnnotation.next;
    }
    return;
  }

  getPrevAnnotation(id: AnnotationId): Annotation|undefined {
    const existingAnnotation = this.annotationMap.get(id);
    if (existingAnnotation) {
      return existingAnnotation.prev;
    }
    return;
  }

  private addHelper(annotation: Annotation, commit: boolean, parentReference?: AnnotationReference):
      AnnotationReference {
    if (!annotation.id) {
      annotation.id = makeAnnotationId();
    } else if (this.annotationMap.has(annotation.id)) {
      throw new Error(`Annotation id already exists: ${JSON.stringify(annotation.id)}.`);
    }
    if (parentReference) {
      annotation.parentId = parentReference.id;
    }
    this.insertAnnotationNode(annotation);
    this.changed.dispatch();
    if (!commit) {
      this.pending.add(annotation.id);
    }

    return this.getReference(annotation.id);
  }

  add(annotation: Annotation, commit: boolean = true,
      parentReference?: AnnotationReference): AnnotationReference {
    const reference = this.addHelper(annotation, commit, parentReference);
    this.childAdded.dispatch(annotation);
    return reference;
  }

  addAll(annotations: Annotation[], commit: boolean = true, parentReference?: AnnotationReference) {
    for (const annotation of annotations) {
      this.addHelper(annotation, commit, parentReference);
    }
    this.childrenAdded.dispatch(annotations);
  }

  commit(reference: AnnotationReference): void {
    const {id, value} = reference;
    this.pending.delete(id);
    if (value) {
      this.childUpdated.dispatch(value);
    }
  }

  isPending(id: AnnotationId) {
    return this.pending.has(id);
  }

  update(reference: AnnotationReference, annotation: Annotation) {
    if (reference.value === null) {
      throw new Error(`Annotation already deleted.`);
    }
    this.updateAnnotationNode(annotation.id, annotation);
    reference.changed.dispatch();
    this.changed.dispatch();
    this.childUpdated.dispatch(annotation);
  }

  toggleAnnotationTag(reference: AnnotationReference, tagId: number) {
    const annotation = reference.value;
    if (annotation) {
      if (!annotation.tagIds) {
        annotation.tagIds = new Set<number>();
      }
      if (annotation.tagIds.has(tagId)) {
        annotation.tagIds.delete(tagId);
      } else {
        annotation.tagIds.add(tagId);
        this.validateTags(annotation);
      }
      reference.changed.dispatch();
      this.changed.dispatch();
      this.childUpdated.dispatch(annotation);
    }
  }

  [Symbol.iterator]() {
    return this.annotationMap.values();
  }

  get(id: AnnotationId) {
    return this.annotationMap.get(id);
  }

  orphan(reference: AnnotationReference, surrogate?: AnnotationReference): AnnotationReference[] {
    const targets = (<Collection>reference.value)!.entries;
    if (targets && targets.length) {
      return this.childReassignment(targets, surrogate);
    }
    return [];
  }

  childReassignment(targets: string[], surrogate?: AnnotationReference): AnnotationReference[] {
    const emptynesters = <AnnotationReference[]>[];
    let adopter = surrogate ? <Collection>surrogate.value : null;

    targets.forEach((id: string) => {
      const target = this.getReference(id).value!;
      let oldParent;
      if (target.parentId) {
        oldParent = <Collection>this.getReference(target.parentId).value!;
        if (oldParent.parentId && !adopter) {
          adopter = <Collection>this.getReference(oldParent.parentId).value!;
        }
      }

      if (adopter !== oldParent) {
        // reassign/orphan child
        if (!adopter) {
          // no adopter- clear parent
          target.parentId = undefined;
        } else if (this.isAncestor(target, adopter)) {
          // ancestor cannot be adopted by its descendant- skip this one
          return;
        } else {
          // adopt normally
          target.parentId = adopter.id;
          adopter.entries.push(target.id);
        }

        if (adopter) {
          adopter.segmentSet();
        }

        if (oldParent) {
          oldParent.segmentSet();
          oldParent.entries = oldParent.entries.filter(v => v !== target.id);
          if (!oldParent.entries.length) {
            emptynesters.push(this.getReference(oldParent.id));
          }
        }
      }

      this.childDeleted.dispatch(target.id);
      // TODO: CHILD MOVE signal, move the child to a different element rather than deleting and
      // re adding, because this cant rebuild children
      this.childAdded.dispatch(target);
      // move all descendants of target as well
      const collection = <Collection>target;
      if (collection.entries) {
        const targetRef = this.getReference(target.id);
        this.childReassignment(collection.entries, targetRef);
      }
    });

    if (surrogate) {
      surrogate.changed.dispatch();
    }
    this.changed.dispatch();
    if (surrogate) {
      this.childUpdated.dispatch(surrogate.value!);
    }
    return emptynesters;
  }

  private isAncestor(potentialAncestor: Annotation, potentialDescendant: Annotation): boolean {
    if (!potentialDescendant.parentId) {
      return false;
    }

    const parent = this.getReference(potentialDescendant.parentId).value!;
    if (parent.id === potentialAncestor.id) {
      return true;
    }

    return this.isAncestor(potentialAncestor, parent);
  }

  delete(reference: AnnotationReference, flush?: boolean) {
    if (reference.value === null) {
      return;
    }
    const isParent = <boolean>!!(<Collection>reference.value).entries;
    const isChild = !!reference.value!.parentId;
    if (isParent) {
      if (flush) {
        (<Collection>reference.value).entries.forEach((id: string) => {
          const target = this.getReference(id);
          // If child is a collection, this will nuke the grandchildren too
          this.delete(target, true);
        });
      } else {
        this.orphan(reference);
      }
    }
    if (reference.value === null) {
      return;
    }
    if (isChild) {
      // Remove child from parent entries on deletion
      const target = this.getReference(reference.value!.parentId!);
      const value = <Collection>target.value;
      // parent should not be deleted before its children
      value.entries = value.entries.filter(v => v !== reference.value!.id);
      value.segmentSet();
      if (!value.entries.length && !this.isPending(value.id)) {
        this.delete(target);
      }
    }
    if (reference.value === null) {
      return;
    }
    reference.value = null;
    this.deleteAnnotationNode(reference.id);
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

  toJSON() {
    const annotationResult: any[] = [];
    const tagResult: any[] = [];
    const {pending} = this;
    for (const annotation of this) {
      if (pending.has(annotation.id)) {
        // Don't serialize uncommitted annotations.
        continue;
      }
      annotationResult.push(annotationToJson(annotation));
    }
    for (const tag of this.tags.values()) {
      tagResult.push({id: tag.id, label: tag.label});
    }
    const result = {annotations: annotationResult, tags: tagResult};
    return result;
  }

  clear() {
    this.tags.clear();
    this.maxTagId = 0;
    this.annotationMap.clear();
    this.lastAnnotationNodeMap.clear();
    this.lastAnnotationNodeMap.set(undefined, null);
    this.pending.clear();
    this.changed.dispatch();
  }

  restoreState(annotationObj: any, annotationTagObj: any, allowMissingId = false) {
    const {annotationMap, tags: annotationTags} = this;
    annotationTags.clear();
    annotationMap.clear();
    this.lastAnnotationNodeMap.clear();
    this.lastAnnotationNodeMap.set(undefined, null);
    this.maxTagId = 0;
    this.pending.clear();
    if (annotationTagObj !== undefined) {
      parseArray(annotationTagObj, x => {
        const annotationTag = restoreAnnotationTag(x);
        if (this.tags.get(annotationTag.id)) {
          throw new Error(`Duplicate tag id ${annotationTag.id} in JSON state`);
        }
        this.tags.set(annotationTag.id, annotationTag);
        if (annotationTag.id > this.maxTagId) {
          this.maxTagId = annotationTag.id;
        }
      });
    }
    if (annotationObj !== undefined) {
      parseArray(annotationObj, x => {
        const annotation = restoreAnnotation(x, allowMissingId);
        this.insertAnnotationNode(annotation);
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

  getTag(tagId: number) {
    return this.tags.get(tagId);
  }

  getTagIds() {
    return this.tags.keys();
  }

  getTags() {
    return this.tags.values();
  }

  isAnnotationTaggedWithTag(annotationId: AnnotationId, tagId: number): boolean {
    const annotation = this.annotationMap.get(annotationId);
    if (annotation) {
      const collection = <Collection>annotation;
      const selfTag = <boolean>(annotation.tagIds && annotation.tagIds.has(tagId));
      if (collection.entries && !selfTag) {
        return collection.entries.some((child: AnnotationId) => {
          return this.isAnnotationTaggedWithTag(child, tagId);
        });
      }
      return selfTag;
    }
    return false;
  }
}

export class LocalAnnotationSource extends AnnotationSource {}

export const DATA_BOUNDS_DESCRIPTION = 'Data Bounds';

export function makeAnnotationId() {
  return getRandomHexString(160);
}

export function makeDataBoundsBoundingBox(
    lowerVoxelBound: vec3, upperVoxelBound: vec3): AxisAlignedBoundingBox {
  return {
    type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
    id: 'data-bounds',
    description: DATA_BOUNDS_DESCRIPTION,
    pointA: lowerVoxelBound,
    pointB: upperVoxelBound
  };
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

export function serializeAnnotations(allAnnotations: Annotation[][]): SerializedAnnotations {
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
    totalBytes += handler.serializedBytes * count;
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
    const serializer = handler.serializer(data, typeToOffset[annotationType], count);
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
  annotations:
      [Point[], Line[], AxisAlignedBoundingBox[], Ellipsoid[], Collection[], LineStrip[], Spoke[]] =
          [[], [], [], [], [], [], []];
  add(annotation: Annotation) {
    (<Annotation[]>this.annotations[annotation.type]).push(annotation);
  }
  serialize() {
    return serializeAnnotations(this.annotations);
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
