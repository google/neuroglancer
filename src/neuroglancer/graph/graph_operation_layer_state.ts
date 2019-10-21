/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import {AnnotationId, AnnotationReference, AnnotationType, LocalAnnotationSource, restoreAnnotation} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {Annotation} from 'neuroglancer/annotation/index';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/layer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentSelection} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyArray} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';

const ANNOTATIONS_JSON_KEY = 'annotations';

class AnnotationToSupervoxelHandler extends RefCounted {
  annotationToSupervoxelMap: Map<AnnotationId, Uint64> = new Map<AnnotationId, Uint64>();
  supervoxelSet: Uint64Set = this.registerDisposer(new Uint64Set());
  isActive = new TrackableBoolean(false, false);

  add(annotationId: AnnotationId, supervoxel: Uint64) {
    this.annotationToSupervoxelMap.set(annotationId, supervoxel);
    this.supervoxelSet.add(supervoxel);
  }

  delete(annotationId: AnnotationId) {
    const supervoxel = this.annotationToSupervoxelMap.get(annotationId);
    this.annotationToSupervoxelMap.delete(annotationId);
    if (supervoxel) {
      this.supervoxelSet.delete(supervoxel);
    }
  }

  hasSupervoxel(supervoxel: Uint64) {
    return this.supervoxelSet.has(supervoxel);
  }
}

export class GraphOperationHoverState extends WatchableValue<{id: string}|undefined> {}

export class GraphOperationLayerState extends RefCounted {
  changed = new NullarySignal();
  transform: CoordinateTransform;
  sourceA: Owned<LocalAnnotationSource>;
  sourceB: Owned<LocalAnnotationSource>;
  activeSource: Borrowed<LocalAnnotationSource>;
  annotationToSupervoxelA: Owned<AnnotationToSupervoxelHandler>;
  annotationToSupervoxelB: Owned<AnnotationToSupervoxelHandler>;
  selectedRoot: Uint64|undefined;
  multicutSegments: Uint64Set;
  performingMulticut: TrackableBoolean;

  hoverState: GraphOperationHoverState;
  role: RenderLayerRole;

  /**
   * undefined means may have a segmentation state.
   */
  segmentationState: WatchableValue<SegmentationDisplayState|undefined>;

  private transformCacheGeneration = -1;
  private cachedObjectToGlobal = mat4.create();
  private cachedGlobalToObject = mat4.create();
  private annotationLayerStateA =
      this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());
  private annotationLayerStateB =
      this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());

  private updateTransforms() {
    const {transform, transformCacheGeneration} = this;
    const generation = transform.changed.count;
    if (generation === transformCacheGeneration) {
      return;
    }
    const {cachedObjectToGlobal} = this;
    mat4.multiply(cachedObjectToGlobal, this.transform.transform, this.sourceA.objectToLocal);
    mat4.invert(this.cachedGlobalToObject, cachedObjectToGlobal);
  }

  get objectToGlobal() {
    this.updateTransforms();
    return this.cachedObjectToGlobal;
  }

  get globalToObject() {
    this.updateTransforms();
    return this.cachedGlobalToObject;
  }

  get stateA() {
    return this.annotationLayerStateA.value;
  }

  get stateB() {
    return this.annotationLayerStateB.value;
  }

  constructor(options: {
    transform: CoordinateTransform,
    segmentationState: WatchableValue<SegmentationDisplayState>,
    multicutSegments: Uint64Set,
    performingMulticut: TrackableBoolean,
    hoverState?: GraphOperationHoverState,
  }) {
    super();
    const {
      transform = new CoordinateTransform(),
      segmentationState,
      multicutSegments,
      performingMulticut,
      hoverState = new GraphOperationHoverState(undefined),
    } = options;
    this.transform = transform;
    this.multicutSegments = multicutSegments;
    this.performingMulticut = performingMulticut;
    this.sourceA = this.registerDisposer(new LocalAnnotationSource());
    this.sourceB = this.registerDisposer(new LocalAnnotationSource());
    this.activeSource = this.sourceA;
    this.annotationToSupervoxelA = this.registerDisposer(new AnnotationToSupervoxelHandler());
    this.annotationToSupervoxelB = this.registerDisposer(new AnnotationToSupervoxelHandler());
    this.annotationToSupervoxelA.isActive.value = true;
    this.hoverState = hoverState;
    this.role = RenderLayerRole.GRAPH_MODIFICATION_MARKER;
    this.segmentationState = segmentationState;

    const fillOpacity = trackableAlphaValue(1.0);
    this.annotationLayerStateA.value = new AnnotationLayerState({
      transform: this.transform,
      source: this.sourceA.addRef(),
      role: RenderLayerRole.GRAPH_MODIFICATION_MARKER,
      fillOpacity: fillOpacity,
      color: new TrackableRGB(vec3.fromValues(1.0, 0.0, 0.0)),
      segmentationState: segmentationState,
    });

    this.annotationLayerStateB.value = new AnnotationLayerState({
      transform: this.transform,
      source: this.sourceB.addRef(),
      role: RenderLayerRole.GRAPH_MODIFICATION_MARKER,
      fillOpacity: fillOpacity,
      color: new TrackableRGB(vec3.fromValues(0.0, 0.0, 1.0)),
      segmentationState: segmentationState,
    });

    this.addSupervoxelFromAnnotationEvents(this.sourceA, this.annotationToSupervoxelA);
    this.addSupervoxelFromAnnotationEvents(this.sourceB, this.annotationToSupervoxelB);

    this.sourceA.changed.add(() => this.changed.dispatch());
    this.sourceB.changed.add(() => this.changed.dispatch());
  }

  toggleSource() {
    if (this.activeSource === this.sourceA) {
      this.activeSource = this.sourceB;
      this.annotationToSupervoxelA.isActive.value = false;
      this.annotationToSupervoxelB.isActive.value = true;
    } else {
      this.activeSource = this.sourceA;
      this.annotationToSupervoxelA.isActive.value = true;
      this.annotationToSupervoxelB.isActive.value = false;
    }
  }

  getReference(id: AnnotationId): AnnotationReference {
    if (this.sourceA.get(id) !== undefined) {
      return this.sourceA.getReference(id);
    } else {
      return this.sourceB.getReference(id);
    }
  }

  delete(reference: AnnotationReference) {
    if (this.sourceA.get(reference.id) !== undefined) {
      this.sourceA.delete(reference);
    } else {
      this.sourceB.delete(reference);
    }
  }

  restoreState(spec: any) {
    const groups = verifyArray(spec);
    const validatedGroups = this.validateAnnotations(groups);
    if (groups.length > 0) {
      this.sourceA.restoreState(validatedGroups[0], []);
      for (const annotation of this.sourceA) {
        this.addAnnotation(annotation, this.annotationToSupervoxelA);
      }
    }
    if (groups.length > 1) {
      this.sourceB.restoreState(validatedGroups[1], []);
      for (const annotation of this.sourceB) {
        this.addAnnotation(annotation, this.annotationToSupervoxelB);
      }
    }
  }

  toJSON() {
    return [
      this.sourceA.toJSON(),
      this.sourceB.toJSON(),
    ];
  }

  private addAnnotation(
      annotation: Annotation, annotationToSupervoxelHandler: AnnotationToSupervoxelHandler) {
    // Ignore annotations that do not have segment information
    if (annotation.segments && annotation.segments.length >= 2) {
      if (!this.selectedRoot) {
        this.selectedRoot = annotation.segments[1];
        this.multicutSegments.add(this.selectedRoot);
        this.performingMulticut.value = true;
        annotationToSupervoxelHandler.add(annotation.id, annotation.segments[0]);
      } else if (Uint64.equal(this.selectedRoot, annotation.segments[1])) {
        annotationToSupervoxelHandler.add(annotation.id, annotation.segments[0]);
      }
      // Ignore annotations that have a different root segment
    }
  }

  private addSupervoxelFromAnnotationEvents(
      annotationSource: LocalAnnotationSource,
      annotationToSupervoxelHandler: AnnotationToSupervoxelHandler) {
    const deleteAnnotation = (annotationId: AnnotationId) => {
      annotationToSupervoxelHandler.delete(annotationId);
      if (this.annotationToSupervoxelA.supervoxelSet.size === 0 &&
          this.annotationToSupervoxelB.supervoxelSet.size === 0) {
        this.selectedRoot = undefined;
        this.performingMulticut.value = false;
        this.multicutSegments.clear();
      }
    };
    annotationSource.childAdded.add((annotation: Annotation) => {
      this.addAnnotation(annotation, annotationToSupervoxelHandler);
    });
    annotationSource.childDeleted.add((annotationId: AnnotationId) => {
      deleteAnnotation(annotationId);
    });
    // Triggers when user moves an annotation
    annotationSource.childUpdated.add((annotation: Annotation) => {
      deleteAnnotation(annotation.id);
      this.addAnnotation(annotation, annotationToSupervoxelHandler);
    });
  }

  supervoxelSelected(supervoxel: Uint64) {
    return this.annotationToSupervoxelA.hasSupervoxel(supervoxel) ||
        this.annotationToSupervoxelB.hasSupervoxel(supervoxel);
  }

  /**
   * For backwards compatibility, only restore annotations that are associated
   * with the most common root segment of all the annotations
   */
  private validateAnnotations(spec: Array<any>) {
    const annotationMapA = new Map<string, Array<any>>();
    const annotationMapB = new Map<string, Array<any>>();
    const rootSegmentCountMap = new Map<string, number>();
    let maxRootSegment = '';
    let maxRootSegmentCount = 0;
    const processAnnotation = (x: any, annotationMap: Map<string, Array<any>>) => {
      const annotation = restoreAnnotation(x);
      if (annotation.segments && annotation.segments.length >= 2) {
        const rootSegmentIDString = annotation.segments[1].toString();
        if (maxRootSegment === '') {
          maxRootSegment = rootSegmentIDString;
          maxRootSegmentCount = 1;
          annotationMap.set(rootSegmentIDString, [x]);
          rootSegmentCountMap.set(rootSegmentIDString, 1);
        } else {
          let rootSegmentList = annotationMap.get(rootSegmentIDString);
          if (!rootSegmentList) {
            rootSegmentList = [];
            annotationMap.set(rootSegmentIDString, rootSegmentList);
          }
          rootSegmentList.push(x);
          const rootSegmentCount = rootSegmentCountMap.get(rootSegmentIDString) || 0;
          rootSegmentCountMap.set(rootSegmentIDString, rootSegmentCount + 1);
          if (rootSegmentCount + 1 > maxRootSegmentCount) {
            maxRootSegment = rootSegmentIDString;
            maxRootSegmentCount = rootSegmentCount + 1;
          }
        }
      }
    };
    parseArray(spec[0][ANNOTATIONS_JSON_KEY], x => {
      processAnnotation(x, annotationMapA);
    });
    parseArray(spec[1][ANNOTATIONS_JSON_KEY], x => {
      processAnnotation(x, annotationMapB);
    });
    return [annotationMapA.get(maxRootSegment) || [], annotationMapB.get(maxRootSegment) || []];
  }

  getSourcesAndSinks() {
    let sources = Array<SegmentSelection>();
    let sinks = Array<SegmentSelection>();
    const {sourceA, sourceB} = this;
    const {objectToLocal} = sourceA;
    for (const annotation of sourceA) {
      if (annotation.type === AnnotationType.POINT && annotation.segments &&
          annotation.segments.length === 2) {
        const spatialPoint = vec3.transformMat4(vec3.create(), annotation.point, objectToLocal);
        const segment = annotation.segments[0];
        const root = annotation.segments[1];
        sources.push({segmentId: segment, rootId: root, position: spatialPoint});
      }
    }
    for (const annotation of sourceB) {
      if (annotation.type === AnnotationType.POINT && annotation.segments &&
          annotation.segments.length === 2) {
        const spatialPoint = vec3.transformMat4(vec3.create(), annotation.point, objectToLocal);
        const segment = annotation.segments[0];
        const root = annotation.segments[1];
        sinks.push({segmentId: segment, rootId: root, position: spatialPoint});
      }
    }
    return {sources, sinks};
  }
}
