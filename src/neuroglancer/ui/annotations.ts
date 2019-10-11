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
 * @file User interface for display and editing annotations.
 */

import './annotations.css';

import debounce from 'lodash/debounce';
import {Annotation, AnnotationReference, AnnotationSource, AnnotationType, AxisAlignedBoundingBox, Ellipsoid, getAnnotationTypeHandler, Line} from 'neuroglancer/annotation';
import {AnnotationDisplayState} from 'neuroglancer/annotation/annotation_layer_state';
import {AnnotationLayer, AnnotationLayerState, PerspectiveViewAnnotationLayer, SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
import {DataFetchSliceViewRenderLayer, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {CoordinateSpace} from 'neuroglancer/coordinate_transform';
import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
import {LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {ChunkTransformParameters, getChunkPositionFromCombinedGlobalLocalPositions} from 'neuroglancer/render_coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/renderlayer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {registerNested, TrackableValueInterface} from 'neuroglancer/trackable_value';
import {registerTool, Tool} from 'neuroglancer/ui/tool';
import {arraysEqual, gatherUpdate} from 'neuroglancer/util/array';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent, updateChildren} from 'neuroglancer/util/dom';
import {vec3} from 'neuroglancer/util/geom';
import {verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {formatScaleWithUnitAsString} from 'neuroglancer/util/si_units';
import {NullarySignal} from 'neuroglancer/util/signal';
import {formatIntegerBounds, formatIntegerPoint} from 'neuroglancer/util/spatial_units';
import {Uint64} from 'neuroglancer/util/uint64';
import * as vector from 'neuroglancer/util/vector';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {ColorWidget} from 'neuroglancer/widget/color';
import {makeDeleteButton} from 'neuroglancer/widget/delete_button';
import {makeIcon} from 'neuroglancer/widget/icon';
import {RangeWidget} from 'neuroglancer/widget/range';
import {Tab} from 'neuroglancer/widget/tab_view';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

interface AnnotationIdAndPart {
  id: string, sourceIndex: number;
  subsource?: string;
  partIndex?: number
}

export class AnnotationSegmentListWidget extends RefCounted {
  element = document.createElement('div');
  private addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  private segmentationState: SegmentationDisplayState|undefined|null;
  private debouncedUpdateView = debounce(() => this.updateView(), 0);
  constructor(
      public reference: Borrowed<AnnotationReference>,
      public annotationLayer: AnnotationLayerState) {
    super();
    this.element.className = 'neuroglancer-annotation-segment-list';
    const {addSegmentWidget} = this;
    addSegmentWidget.element.style.display = 'inline-block';
    addSegmentWidget.element.title = 'Associate segments';
    this.element.appendChild(addSegmentWidget.element);
    this.registerDisposer(
        annotationLayer.displayState.segmentationState.changed.add(this.debouncedUpdateView));
    this.registerDisposer(() => this.unregisterSegmentationState());
    this.registerDisposer(this.addSegmentWidget.valuesEntered.add(values => {
      const annotation = this.reference.value;
      if (annotation == null) {
        return;
      }
      const existingSegments = annotation.segments;
      const segments = [...(existingSegments || []), ...values];
      const newAnnotation = {...annotation, segments};
      this.annotationLayer.source.update(this.reference, newAnnotation);
      this.annotationLayer.source.commit(this.reference);
    }));
    this.registerDisposer(reference.changed.add(this.debouncedUpdateView));
    this.updateView();
  }

  private unregisterSegmentationState() {
    const {segmentationState} = this;
    if (segmentationState != null) {
      segmentationState.visibleSegments.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentColorHash.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentSelectionState.changed.remove(this.debouncedUpdateView);
      this.segmentationState = undefined;
    }
  }

  private updateView() {
    const segmentationState = this.annotationLayer.displayState.segmentationState.value;
    if (segmentationState !== this.segmentationState) {
      this.unregisterSegmentationState();
      this.segmentationState = segmentationState;
      if (segmentationState != null) {
        segmentationState.visibleSegments.changed.add(this.debouncedUpdateView);
        segmentationState.segmentColorHash.changed.add(this.debouncedUpdateView);
        segmentationState.segmentSelectionState.changed.add(this.debouncedUpdateView);
      }
    }

    const {element} = this;
    // Remove existing segment representations.
    for (let child = this.addSegmentWidget.element.nextElementSibling; child !== null;) {
      const next = child.nextElementSibling;
      element.removeChild(child);
      child = next;
    }
    element.style.display = 'none';
    const annotation = this.reference.value;
    if (annotation == null) {
      return;
    }
    const segments = annotation.segments;
    if (segmentationState === null) {
      return;
    }
    element.style.display = '';
    if (segments === undefined || segments.length === 0) {
      return;
    }
    const segmentColorHash = segmentationState ? segmentationState.segmentColorHash : undefined;
    segments.forEach((segment, index) => {
      if (index !== 0) {
        element.appendChild(document.createTextNode(' '));
      }
      const child = document.createElement('span');
      child.title =
          'Double click to toggle segment visibility, control+click to disassociate segment from annotation.';
      child.className = 'neuroglancer-annotation-segment-item';
      child.textContent = segment.toString();
      if (segmentationState !== undefined) {
        child.style.backgroundColor = segmentColorHash!.computeCssColor(segment);
        child.addEventListener('mouseenter', () => {
          segmentationState.segmentSelectionState.set(segment);
        });
        child.addEventListener('mouseleave', () => {
          segmentationState.segmentSelectionState.set(null);
        });
        child.addEventListener('dblclick', (event: MouseEvent) => {
          if (event.ctrlKey) {
            return;
          }
          if (segmentationState.visibleSegments.has(segment)) {
            segmentationState.visibleSegments.delete(segment);
          } else {
            segmentationState.visibleSegments.add(segment);
          }
        });
      }
      child.addEventListener('click', (event: MouseEvent) => {
        if (!event.ctrlKey) {
          return;
        }
        const existingSegments = annotation.segments || [];
        const newSegments = existingSegments.filter(x => !Uint64.equal(segment, x));
        const newAnnotation = {...annotation, segments: newSegments ? newSegments : undefined};
        this.annotationLayer.source.update(this.reference, newAnnotation);
        this.annotationLayer.source.commit(this.reference);
      });
      element.appendChild(child);
    });
  }
}

export class MergedAnnotationStates extends RefCounted {
  changed = new NullarySignal();
  isLoadingChanged = new NullarySignal();
  states: Borrowed<AnnotationLayerState>[] = [];
  private loadingCount = 0;

  get isLoading() {
    return this.loadingCount !== 0;
  }

  markLoading() {
    this.loadingCount++;
    return () => {
      if (--this.loadingCount === 0) {
        this.isLoadingChanged.dispatch();
      }
    };
  }

  private sort() {
    this.states.sort((a, b) => {
      let d = a.sourceIndex - b.sourceIndex;
      if (d !== 0) return d;
      return a.subsourceIndex - b.subsourceIndex;
    });
  }

  add(state: Borrowed<AnnotationLayerState>) {
    this.states.push(state);
    this.sort();
    this.changed.dispatch();
    return () => {
      const index = this.states.indexOf(state);
      this.states.splice(index, 1);
      this.changed.dispatch();
    };
  }
}

export class SelectedAnnotationState extends RefCounted implements
    TrackableValueInterface<AnnotationIdAndPart|undefined> {
  private value_: AnnotationIdAndPart|undefined = undefined;
  changed = new NullarySignal();

  private annotationLayer_: AnnotationLayerState|undefined = undefined;
  private reference_: Owned<AnnotationReference>|undefined = undefined;

  get reference() {
    return this.reference_;
  }

  constructor(public annotationStates: Borrowed<MergedAnnotationStates>) {
    super();
    this.registerDisposer(annotationStates.isLoadingChanged.add(this.validate));
  }

  get selectedAnnotationLayer(): AnnotationLayerState|undefined {
    return this.annotationLayer_;
  }

  get value() {
    this.validate();
    return this.value_;
  }

  get validValue() {
    this.validate();
    return this.annotationLayer_ && this.value_;
  }

  set value(value: AnnotationIdAndPart|undefined) {
    if (this.value_ === value) return;
    this.value_ = value;
    if (value === undefined) {
      this.unbindReference();
      this.changed.dispatch();
      return;
    }
    const reference = this.reference_;
    if (reference !== undefined) {
      const annotationLayer = this.annotationLayer_!;
      if (value === undefined || reference.id !== value.id ||
          annotationLayer.sourceIndex !== value.sourceIndex ||
          (annotationLayer.subsourceId !== undefined &&
           annotationLayer.subsourceId !== value.subsource)) {
        this.unbindReference();
      }
    }
    this.validate();
    this.changed.dispatch();
  }

  disposed() {
    this.unbindReference();
    super.disposed();
  }

  private unbindReference() {
    const reference = this.reference_;
    if (reference !== undefined) {
      reference.changed.remove(this.referenceChanged);
      const annotationLayer = this.annotationLayer_!;
      annotationLayer.source.changed.remove(this.validate);
      annotationLayer.dataSource.layer.dataSourcesChanged.remove(this.validate);
      this.reference_ = undefined;
      this.annotationLayer_ = undefined;
    }
  }

  private referenceChanged = (() => {
    this.validate();
    this.changed.dispatch();
  });

  private validate = (() => {
    const value = this.value_;
    if (value === undefined) return;
    const {annotationLayer_} = this;
    const {annotationStates} = this;
    if (annotationLayer_ !== undefined) {
      if (!annotationStates.states.includes(annotationLayer_)) {
        // Annotation layer containing selected annotation was removed.
        this.unbindReference();
        if (!annotationStates.isLoading) {
          this.value_ = undefined;
          this.changed.dispatch();
        }
        return;
      }
      // Existing reference is still valid.
      const reference = this.reference_!;
      let hasChange = false;
      if (reference.id !== value.id) {
        // Id changed.
        value.id = reference.id;
        hasChange = true;
      }
      const {dataSource} = annotationLayer_;
      if (dataSource.layer.dataSources[value.sourceIndex] !== dataSource) {
        value.sourceIndex = annotationLayer_.sourceIndex;
        hasChange = true;
      }
      if (hasChange) this.changed.dispatch();
      return;
    }
    const newAnnotationLayer = annotationStates.states.find(
        x => x.sourceIndex === value.sourceIndex &&
            (value.subsource === undefined || x.subsourceId === value.subsource));
    if (newAnnotationLayer === undefined) {
      if (!annotationStates.isLoading) {
        this.value_ = undefined;
        this.changed.dispatch();
      }
      return;
    }
    this.annotationLayer_ = newAnnotationLayer;
    const reference = this.reference_ = newAnnotationLayer!.source.getReference(value.id);
    reference.changed.add(this.referenceChanged);
    newAnnotationLayer.source.changed.add(this.validate);
    newAnnotationLayer.dataSource.layer.dataSourcesChanged.add(this.validate);
    this.changed.dispatch();
  });

  toJSON() {
    const value = this.value_;
    if (value === undefined) {
      return undefined;
    }
    let partIndex: number|undefined = value.partIndex;
    if (partIndex === 0) partIndex = undefined;
    let sourceIndex: number|undefined = value.sourceIndex;
    if (sourceIndex === 0) sourceIndex = undefined;
    return {id: value.id, partIndex, source: sourceIndex, subsource: value.subsource};
  }
  reset() {
    this.value = undefined;
  }
  restoreState(x: any) {
    if (x === undefined) {
      this.value = undefined;
      return;
    }
    if (typeof x === 'string') {
      this.value = {'id': x, 'partIndex': 0, sourceIndex: 0};
      return;
    }
    verifyObject(x);
    this.value = {
      id: verifyObjectProperty(x, 'id', verifyString),
      partIndex: verifyOptionalObjectProperty(x, 'partIndex', verifyInt),
      sourceIndex: verifyOptionalObjectProperty(x, 'source', verifyInt, 0),
      subsource: verifyOptionalObjectProperty(x, 'subsource', verifyString),
    };
  }
}

function makePointLink(
    chunkPosition: Float32Array, chunkTransform: ChunkTransformParameters,
    setViewPosition?: (layerPosition: Float32Array) => void) {
  const layerRank = chunkTransform.layerRank;
  const layerPosition = new Float32Array(layerRank);
  const paddedChunkPosition = new Float32Array(layerRank);
  paddedChunkPosition.set(chunkPosition);
  matrix.transformPoint(
      layerPosition, chunkTransform.chunkToLayerTransform, layerRank + 1, paddedChunkPosition,
      layerRank);
  const positionText = formatIntegerPoint(layerPosition);
  if (setViewPosition !== undefined) {
    const element = document.createElement('span');
    element.className = 'neuroglancer-voxel-coordinates-link';
    element.textContent = positionText;
    element.title = `Center view on coordinates ${positionText}.`;
    element.addEventListener('click', () => {
      setViewPosition(layerPosition);
    });
    return element;
  } else {
    return document.createTextNode(positionText);
  }
}

export function getPositionSummary(
    element: HTMLElement, annotation: Annotation, chunkTransform: ChunkTransformParameters,
    setViewPosition?: (layerPosition: Float32Array) => void) {
  const makePointLinkWithTransform = (point: Float32Array) =>
      makePointLink(point, chunkTransform, setViewPosition);

  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      element.appendChild(makePointLinkWithTransform(annotation.pointA));
      element.appendChild(document.createTextNode('–'));
      element.appendChild(makePointLinkWithTransform(annotation.pointB));
      break;
    case AnnotationType.POINT:
      element.appendChild(makePointLinkWithTransform(annotation.point));
      break;
    case AnnotationType.ELLIPSOID:
      element.appendChild(makePointLinkWithTransform(annotation.center));
      const rank = chunkTransform.layerRank;
      const layerRadii = new Float32Array(rank);
      matrix.transformVector(
          layerRadii, chunkTransform.chunkToLayerTransform, rank + 1, annotation.radii, rank);
      element.appendChild(document.createTextNode('±' + formatIntegerBounds(layerRadii)));
      break;
  }
}

function getCenterPosition(center: Float32Array, annotation: Annotation) {
  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      vector.add(center, annotation.pointA, annotation.pointB);
      vector.scale(center, center, 0.5);
      break;
    case AnnotationType.POINT:
      center.set(annotation.point);
      break;
    case AnnotationType.ELLIPSOID:
      center.set(annotation.center);
      break;
  }
}


function setLayerPosition(
    layer: UserLayer, chunkTransform: ChunkTransformParameters, layerPosition: Float32Array) {
  const {globalPosition} = layer.manager.root;
  const {localPosition} = layer;
  const {modelTransform} = chunkTransform;
  gatherUpdate(globalPosition.value, layerPosition, modelTransform.globalToRenderLayerDimensions);
  gatherUpdate(localPosition.value, layerPosition, modelTransform.localToRenderLayerDimensions);
  localPosition.changed.dispatch();
  globalPosition.changed.dispatch();
}

interface AnnotationLayerViewAttachedState {
  refCounted: RefCounted;
  listElements: Map<string, HTMLElement>;
  sublistContainer: HTMLElement;
}

export class AnnotationLayerView extends Tab {
  private previousSelectedId: string|undefined = undefined;
  private previousSelectedAnnotationLayerState: AnnotationLayerState|undefined = undefined;
  private previousHoverId: string|undefined = undefined;
  private previousHoverAnnotationLayerState: AnnotationLayerState|undefined = undefined;

  private listContainer = document.createElement('div');
  private updated = false;
  private mutableControls = document.createElement('div');
  private headerRow = document.createElement('div');

  get annotationStates() {
    return this.state.annotationStates;
  }

  private attachedAnnotationStates =
      new Map<AnnotationLayerState, AnnotationLayerViewAttachedState>();

  private updateAttachedAnnotationLayerStates() {
    const states = this.annotationStates.states;
    const {attachedAnnotationStates} = this;
    const newAttachedAnnotationStates =
        new Map<AnnotationLayerState, AnnotationLayerViewAttachedState>();
    for (const [state, info] of attachedAnnotationStates) {
      if (!states.includes(state)) {
        attachedAnnotationStates.delete(state);
        info.listElements.clear();
        info.refCounted.dispose();
      }
    }
    for (const state of states) {
      const info = attachedAnnotationStates.get(state);
      if (info !== undefined) {
        newAttachedAnnotationStates.set(state, info);
        continue;
      }
      const source = state.source;
      const refCounted = new RefCounted();
      if (source instanceof AnnotationSource) {
        refCounted.registerDisposer(
            source.childAdded.add((annotation) => this.addAnnotationElement(annotation, state)));
        refCounted.registerDisposer(source.childUpdated.add(
            (annotation) => this.updateAnnotationElement(annotation, state)));
        refCounted.registerDisposer(source.childDeleted.add(
            (annotationId) => this.deleteAnnotationElement(annotationId, state)));
      }
      refCounted.registerDisposer(state.transform.changed.add(this.forceUpdateView));
      const sublistContainer = document.createElement('div');
      sublistContainer.classList.add('neuroglancer-annotation-sublist');
      newAttachedAnnotationStates.set(
          state, {refCounted, listElements: new Map(), sublistContainer});
    }
    this.attachedAnnotationStates = newAttachedAnnotationStates;
    attachedAnnotationStates.clear();
    this.updateCoordinateSpace();
    this.forceUpdateView();
  }

  private forceUpdateView = () => {
    this.updated = false;
    this.updateView();
  };

  private globalDimensionIndices: number[] = [];
  private localDimensionIndices: number[] = [];
  private curCoordinateSpaceGeneration = -1;
  private prevCoordinateSpaceGeneration = -1;

  private updateCoordinateSpace() {
    const localCoordinateSpace = this.layer.localCoordinateSpace.value;
    const globalCoordinateSpace = this.layer.manager.root.coordinateSpace.value;
    const globalDimensionIndices: number[] = [];
    const localDimensionIndices: number[] = [];
    for (let globalDim = 0, globalRank = globalCoordinateSpace.rank; globalDim < globalRank;
         ++globalDim) {
      if (this.annotationStates.states.some(state => {
            const transform = state.transform.value;
            if (transform.error !== undefined) return false;
            return transform.globalToRenderLayerDimensions[globalDim] !== -1;
          })) {
        globalDimensionIndices.push(globalDim);
      }
    }
    for (let localDim = 0, localRank = localCoordinateSpace.rank; localDim < localRank;
         ++localDim) {
      if (this.annotationStates.states.some(state => {
            const transform = state.transform.value;
            if (transform.error !== undefined) return false;
            return transform.localToRenderLayerDimensions[localDim] !== -1;
          })) {
        localDimensionIndices.push(localDim);
      }
    }
    if (!arraysEqual(globalDimensionIndices, this.globalDimensionIndices) ||
        !arraysEqual(localDimensionIndices, this.localDimensionIndices)) {
      this.localDimensionIndices = localDimensionIndices;
      this.globalDimensionIndices = globalDimensionIndices;
      ++this.curCoordinateSpaceGeneration;
    }
  }

  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>, public displayState: AnnotationDisplayState) {
    super();
    this.element.classList.add('neuroglancer-annotation-layer-view');
    this.listContainer.classList.add('neuroglancer-annotation-list');
    this.registerDisposer(state);
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.registerDisposer(
        state.annotationStates.changed.add(() => this.updateAttachedAnnotationLayerStates()));
    this.headerRow.classList.add('neuroglancer-annotation-list-header');

    const toolbox = document.createElement('div');
    toolbox.className = 'neuroglancer-annotation-toolbox';

    layer.initializeAnnotationLayerViewTab(this);
    {
      const widget = this.registerDisposer(new RangeWidget(this.displayState.fillOpacity));
      widget.promptElement.textContent = 'Fill opacity';
      this.element.appendChild(widget.element);
    }

    const colorPicker = this.registerDisposer(new ColorWidget(this.displayState.color));
    colorPicker.element.title = 'Change annotation display color';
    toolbox.appendChild(colorPicker.element);
    const {mutableControls} = this;
    const pointButton = makeIcon({
      text: getAnnotationTypeHandler(AnnotationType.POINT).icon,
      title: 'Annotate point',
      onClick: () => {
        this.layer.tool.value = new PlacePointTool(this.layer, {});
      },
    });
    mutableControls.appendChild(pointButton);

    const boundingBoxButton = makeIcon({
      text: getAnnotationTypeHandler(AnnotationType.AXIS_ALIGNED_BOUNDING_BOX).icon,
      title: 'Annotate bounding box',
      onClick: () => {
        this.layer.tool.value = new PlaceBoundingBoxTool(this.layer, {});
      },
    });
    mutableControls.appendChild(boundingBoxButton);

    const lineButton = makeIcon({
      text: getAnnotationTypeHandler(AnnotationType.LINE).icon,
      title: 'Annotate line',
      onClick: () => {
        this.layer.tool.value = new PlaceLineTool(this.layer, {});
      },
    });
    mutableControls.appendChild(lineButton);

    const ellipsoidButton = makeIcon({
      text: getAnnotationTypeHandler(AnnotationType.ELLIPSOID).icon,
      title: 'Annotate ellipsoid',
      onClick: () => {
        this.layer.tool.value = new PlaceEllipsoidTool(this.layer, {});
      },
    });
    mutableControls.appendChild(ellipsoidButton);
    toolbox.appendChild(mutableControls);
    this.element.appendChild(toolbox);

    this.element.appendChild(this.listContainer);
    this.listContainer.addEventListener('mouseleave', () => {
      this.displayState.hoverState.value = undefined;
    });
    this.registerDisposer(this.displayState.hoverState.changed.add(() => this.updateHoverView()));
    this.registerDisposer(this.state.changed.add(() => this.updateSelectionView()));
    this.registerDisposer(this.layer.localCoordinateSpace.changed.add(() => {
      this.updateCoordinateSpace();
      this.updateView();
    }));
    this.registerDisposer(this.layer.manager.root.coordinateSpace.changed.add(() => {
      this.updateCoordinateSpace();
      this.updateView();
    }));
    this.updateCoordinateSpace();
    this.updateAttachedAnnotationLayerStates();
  }

  private clearSelectionClass() {
    const {previousSelectedAnnotationLayerState, previousSelectedId} = this;
    if (previousSelectedAnnotationLayerState !== undefined) {
      this.previousSelectedAnnotationLayerState = undefined;
      this.previousSelectedId = undefined;
      const attached = this.attachedAnnotationStates.get(previousSelectedAnnotationLayerState);
      if (attached === undefined) return;
      const element = attached.listElements.get(previousSelectedId!);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-selected');
      }
    }
  }

  private clearHoverClass() {
    const {previousHoverId, previousHoverAnnotationLayerState} = this;
    if (previousHoverAnnotationLayerState !== undefined) {
      this.previousHoverAnnotationLayerState = undefined;
      this.previousHoverId = undefined;
      const attached = this.attachedAnnotationStates.get(previousHoverAnnotationLayerState);
      if (attached === undefined) return;
      const element = attached.listElements.get(previousHoverId!);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-hover');
      }
    }
  }

  private updateSelectionView() {
    const selectedValue = this.state.value;
    let newSelectedId: string|undefined;
    let newSelectedAnnotationLayerState: AnnotationLayerState|undefined;
    if (selectedValue !== undefined) {
      newSelectedId = selectedValue.id;
      newSelectedAnnotationLayerState = this.state.selectedAnnotationLayer;
    }
    const {previousSelectedId, previousSelectedAnnotationLayerState} = this;
    if (newSelectedId === previousSelectedId &&
        previousSelectedAnnotationLayerState === newSelectedAnnotationLayerState) {
      return;
    }
    this.clearSelectionClass();
    this.previousSelectedId = newSelectedId;
    this.previousSelectedAnnotationLayerState = newSelectedAnnotationLayerState;
    if (newSelectedId === undefined) return;
    const attached = this.attachedAnnotationStates.get(newSelectedAnnotationLayerState!);
    if (attached === undefined) return;
    const element = attached.listElements.get(newSelectedId);
    if (element === undefined) return;
    element.classList.add('neuroglancer-annotation-selected');
    element.scrollIntoView();
  }

  private updateHoverView() {
    const selectedValue = this.displayState.hoverState.value;
    let newHoverId: string|undefined;
    let newAnnotationLayerState: AnnotationLayerState|undefined;
    if (selectedValue !== undefined) {
      newHoverId = selectedValue.id;
      newAnnotationLayerState = selectedValue.annotationLayerState;
    }
    const {previousHoverId, previousHoverAnnotationLayerState} = this;
    if (newHoverId === previousHoverId &&
        newAnnotationLayerState === previousHoverAnnotationLayerState) {
      return;
    }
    this.clearHoverClass();
    this.previousHoverId = newHoverId;
    this.previousHoverAnnotationLayerState = newAnnotationLayerState;
    if (newHoverId === undefined) return;
    const attached = this.attachedAnnotationStates.get(newAnnotationLayerState!);
    if (attached === undefined) return;
    const element = attached.listElements.get(newHoverId);
    if (element === undefined) return;
    element.classList.add('neuroglancer-annotation-hover');
  }

  private updateView() {
    if (!this.visible) {
      return;
    }
    if (this.curCoordinateSpaceGeneration !== this.prevCoordinateSpaceGeneration) {
      this.updated = false;
      const {headerRow} = this;
      const symbolPlaceholder = document.createElement('div');
      symbolPlaceholder.style.gridColumn = `symbol`;

      const deletePlaceholder = document.createElement('div');
      deletePlaceholder.style.gridColumn = `delete`;

      removeChildren(headerRow);
      headerRow.appendChild(symbolPlaceholder);
      let i = 0;
      const addDimension = (coordinateSpace: CoordinateSpace, dimIndex: number) => {
        const dimWidget = document.createElement('div');
        dimWidget.classList.add('neuroglancer-annotations-view-dimension');
        const name = document.createElement('span');
        name.classList.add('neuroglancer-annotations-view-dimension-name');
        name.textContent = coordinateSpace.names[dimIndex];
        const scale = document.createElement('scale');
        scale.classList.add('neuroglancer-annotations-view-dimension-scale');
        scale.textContent = formatScaleWithUnitAsString(
            coordinateSpace.scales[dimIndex], coordinateSpace.units[dimIndex], {precision: 2});
        dimWidget.appendChild(name);
        dimWidget.appendChild(scale);
        dimWidget.style.gridColumn = `dim ${i + 1}`;
        ++i;
        headerRow.appendChild(dimWidget);
      };
      const globalCoordinateSpace = this.layer.manager.root.coordinateSpace.value;
      for (const globalDim of this.globalDimensionIndices) {
        addDimension(globalCoordinateSpace, globalDim);
      }
      const localCoordinateSpace = this.layer.localCoordinateSpace.value;
      for (const localDim of this.localDimensionIndices) {
        addDimension(localCoordinateSpace, localDim);
      }
      headerRow.appendChild(deletePlaceholder);
      this.listContainer.style.gridTemplateColumns =
          `[symbol] min-content repeat(${i}, [dim] min-content) [delete] min-content`;
      this.prevCoordinateSpaceGeneration = this.curCoordinateSpaceGeneration;
    }
    if (this.updated) {
      return;
    }

    let isMutable = false;
    const self = this;
    function* sublistContainers() {
      yield self.headerRow;
      for (const [state, {sublistContainer, listElements}] of self.attachedAnnotationStates) {
        if (!state.source.readonly) isMutable = true;
        removeChildren(sublistContainer);
        listElements.clear();
        if (state.chunkTransform.value.error !== undefined) continue;
        for (const annotation of state.source) {
          sublistContainer.appendChild(self.makeAnnotationListElement(annotation, state));
        }
        yield sublistContainer;
      }
    }
    updateChildren(this.listContainer, sublistContainers());
    this.mutableControls.style.display = isMutable ? 'contents' : 'none';
    this.resetOnUpdate();
  }

  private addAnnotationElement(annotation: Annotation, state: AnnotationLayerState) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    const info = this.attachedAnnotationStates.get(state);
    if (info !== undefined) {
      info.sublistContainer.appendChild(this.makeAnnotationListElement(annotation, state));
    }
    this.resetOnUpdate();
  }

  private updateAnnotationElement(annotation: Annotation, state: AnnotationLayerState) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    const info = this.attachedAnnotationStates.get(state);
    if (info !== undefined) {
      const {listElements} = info;
      const element = listElements.get(annotation.id);
      if (element !== undefined) {
        const newElement = this.makeAnnotationListElement(annotation, state);
        info.sublistContainer.replaceChild(newElement, element);
        listElements.set(annotation.id, newElement);
      }
    }
    this.resetOnUpdate();
  }

  private deleteAnnotationElement(annotationId: string, state: AnnotationLayerState) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    const attached = this.attachedAnnotationStates.get(state);
    if (attached !== undefined) {
      let element = attached.listElements.get(annotationId);
      if (element !== undefined) {
        removeFromParent(element);
        attached.listElements.delete(annotationId);
      }
    }
    this.resetOnUpdate();
  }

  private resetOnUpdate() {
    this.clearHoverClass();
    this.clearSelectionClass();
    this.updated = true;
    this.updateHoverView();
    this.updateSelectionView();
  }

  private makeAnnotationListElement(annotation: Annotation, state: AnnotationLayerState) {
    const chunkTransform = state.chunkTransform.value as ChunkTransformParameters;
    const element = document.createElement('div');
    element.classList.add('neuroglancer-annotation-list-entry');
    element.title = 'Click to select, right click to recenter view.';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-icon';
    icon.textContent = getAnnotationTypeHandler(annotation.type).icon;
    icon.classList.add('neuroglancer-annotation-list-entry-highlight');
    element.appendChild(icon);

    let deleteButton: HTMLElement|undefined;

    const maybeAddDeleteButton = () => {
      if (state.source.readonly) return;
      if (deleteButton !== undefined) return;
      deleteButton = makeDeleteButton({
        title: 'Delete annotation',
        onClick: () => {
          const ref = state.source.getReference(annotation.id);
          try {
            state.source.delete(ref);
          } finally {
            ref.dispose();
          }
        },
      });
      deleteButton.classList.add('neuroglancer-annotation-list-entry-delete');
      element.appendChild(deleteButton);
    };

    let numRows = 0;
    const {layerRank} = chunkTransform;
    const paddedChunkPosition = new Float32Array(layerRank);
    const addPositionRow = (chunkPosition: Float32Array, isVector = false) => {
      ++numRows;
      const position = document.createElement('div');
      position.className = 'neuroglancer-annotation-position';
      element.appendChild(position);
      paddedChunkPosition.set(chunkPosition);
      const layerPosition = new Float32Array(layerRank);
      (isVector ? matrix.transformVector : matrix.transformPoint)(
          layerPosition, chunkTransform.chunkToLayerTransform, layerRank + 1, paddedChunkPosition,
          layerRank);
      let i = 0;
      const addDims =
          (viewDimensionIndices: readonly number[], layerDimensionIndices: readonly number[]) => {
            for (const viewDim of viewDimensionIndices) {
              const layerDim = layerDimensionIndices[viewDim];
              if (layerDim !== -1) {
                const coord = Math.floor(layerPosition[layerDim]);
                const coordElement = document.createElement('div');
                coordElement.textContent = coord.toString();
                coordElement.classList.add('neuroglancer-annotation-coordinate');
                coordElement.classList.add('neuroglancer-annotation-list-entry-highlight');
                coordElement.style.gridColumn = `dim ${i + 1}`;
                position.appendChild(coordElement);
              }
              ++i;
            }
          };
      addDims(
          this.globalDimensionIndices, chunkTransform.modelTransform.globalToRenderLayerDimensions);
      addDims(
          this.localDimensionIndices, chunkTransform.modelTransform.localToRenderLayerDimensions);
      maybeAddDeleteButton();
    };
    switch (annotation.type) {
      case AnnotationType.POINT:
        addPositionRow(annotation.point);
        break;
      case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
      case AnnotationType.LINE:
        addPositionRow(annotation.pointA);
        addPositionRow(annotation.pointB);
        break;
      case AnnotationType.ELLIPSOID:
        addPositionRow(annotation.center);
        addPositionRow(annotation.radii, /*isVector=*/ true);
        break;
    }

    if (annotation.description) {
      ++numRows;
      const description = document.createElement('div');
      description.classList.add('neuroglancer-annotation-description');
      description.classList.add('neuroglancer-annotation-list-entry-highlight');
      description.textContent = annotation.description;
      element.appendChild(description);
    }
    icon.style.gridRow = `span ${numRows}`;
    if (deleteButton !== undefined) {
      deleteButton.style.gridRow = `span ${numRows}`;
    }


    const info = this.attachedAnnotationStates.get(state)!;
    info.listElements.set(annotation.id, element);
    element.addEventListener('mouseenter', () => {
      this.displayState.hoverState.value = {
        id: annotation.id,
        partIndex: 0,
        annotationLayerState: state,
      };
    });
    element.addEventListener('click', () => {
      this.state.value = {
        id: annotation.id,
        partIndex: 0,
        sourceIndex: state.sourceIndex,
        subsource: state.subsourceId
      };
    });

    element.addEventListener('mouseup', (event: MouseEvent) => {
      if (event.button === 2) {
        const {layerRank} = chunkTransform;
        const chunkPosition = new Float32Array(layerRank);
        const layerPosition = new Float32Array(layerRank);
        getCenterPosition(chunkPosition, annotation);
        matrix.transformPoint(
            layerPosition, chunkTransform.chunkToLayerTransform, layerRank + 1, chunkPosition,
            layerRank);
        setLayerPosition(this.layer, chunkTransform, layerPosition);
      }
    });

    return element;
  }
}

export class AnnotationDetailsTab extends Tab {
  private valid = false;
  private mouseEntered = false;
  private segmentListWidget: AnnotationSegmentListWidget|undefined;
  constructor(
      public state: Owned<SelectedAnnotationState>, public displayState: AnnotationDisplayState,
      public setLayerPosition:
          (layerPosition: Float32Array, annotationLayerState: AnnotationLayerState) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-details');
    this.registerDisposer(state);
    this.registerDisposer(this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    }));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.state.changed.add(() => {
      this.valid = false;
      this.updateView();
    });
    this.element.addEventListener('mouseenter', () => {
      this.mouseEntered = true;
      const selected = this.state.value;
      const annotationLayerState = this.state.selectedAnnotationLayer;
      this.displayState.hoverState.value =
          (annotationLayerState !== undefined && selected !== undefined) ?
          {id: selected.id, partIndex: selected.partIndex || 0, annotationLayerState} :
          undefined;
    });
    this.element.addEventListener('mouseleave', () => {
      this.mouseEntered = false;
      this.displayState.hoverState.value = undefined;
    });
    this.updateView();
  }

  private updateView() {
    if (!this.visible) {
      this.element.style.display = 'none';
      return;
    }
    this.element.style.display = null;
    if (this.valid) {
      return;
    }
    const {element} = this;
    removeChildren(element);
    this.valid = true;
    const {reference} = this.state;
    if (reference === undefined) {
      return;
    }
    const value = this.state.value!;
    const annotation = reference.value;
    if (annotation == null) {
      return;
    }
    const annotationLayer = this.state.selectedAnnotationLayer!;
    if (this.mouseEntered) {
      this.displayState.hoverState.value = {
        id: value.id,
        partIndex: value.partIndex || 0,
        annotationLayerState: annotationLayer
      };
    }

    const handler = getAnnotationTypeHandler(annotation.type);

    const title = document.createElement('div');
    title.className = 'neuroglancer-annotation-details-title';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-details-icon';
    icon.textContent = handler.icon;

    const titleText = document.createElement('div');
    titleText.className = 'neuroglancer-annotation-details-title-text';
    titleText.textContent = `${handler.description}`;
    title.appendChild(icon);
    title.appendChild(titleText);

    if (!annotationLayer.source.readonly) {
      title.appendChild(makeDeleteButton({
        title: 'Delete annotation',
        onClick: () => {
          const ref = annotationLayer.source.getReference(value.id);
          try {
            annotationLayer.source.delete(ref);
          } finally {
            ref.dispose();
          }
        }
      }));
    }

    const closeButton = makeCloseButton();
    closeButton.title = 'Hide annotation details';
    closeButton.addEventListener('click', () => {
      this.state.value = undefined;
    });
    title.appendChild(closeButton);

    element.appendChild(title);

    const chunkTransform = annotationLayer.chunkTransform.value;
    if (chunkTransform.error === undefined) {
      const position = document.createElement('div');
      position.className = 'neuroglancer-annotation-details-position';
      getPositionSummary(
          position, annotation, chunkTransform,
          layerPosition => this.setLayerPosition(layerPosition, annotationLayer));
      element.appendChild(position);
    }

    // if (annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
    //   const volume = document.createElement('div');
    //   volume.className = 'neuroglancer-annotation-details-volume';
    //   volume.textContent = formatBoundingBoxVolume(annotation.pointA, annotation.pointB,
    //   objectToGlobal); element.appendChild(volume);

    //   // FIXME: only do this if it is axis aligned
    //   const spatialOffset = transformVectorByMat4(
    //       tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB),
    //       objectToGlobal);
    //   const voxelVolume = document.createElement('div');
    //   voxelVolume.className = 'neuroglancer-annotation-details-volume-in-voxels';
    //   const voxelOffset = vec3.divide(tempVec3, spatialOffset, coordinateSpace!.scales as any);
    //   // FIXME voxelVolume.textContent = `${formatIntegerBounds(voxelOffset as vec3)}`;
    //   element.appendChild(voxelVolume);
    // } else if (annotation.type === AnnotationType.LINE) {
    //   const spatialOffset = transformVectorByMat4(
    //       tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB),
    //       objectToGlobal);
    //   const length = document.createElement('div');
    //   length.className = 'neuroglancer-annotation-details-length';
    //   const spatialLengthText = formatLength(vec3.length(spatialOffset));
    //   let voxelLengthText = '';
    //   if (coordinateSpace !== undefined) {
    //     const voxelLength = vec3.length(
    //         vec3.divide(tempVec3, spatialOffset, coordinateSpace.scales as any) as vec3); //
    //         FIXME
    //     voxelLengthText = `, ${Math.round(voxelLength)} vx`;
    //   }
    //   length.textContent = spatialLengthText + voxelLengthText;
    //   element.appendChild(length);
    // }

    let {segmentListWidget} = this;
    if (segmentListWidget !== undefined) {
      if (segmentListWidget.reference !== reference) {
        segmentListWidget.dispose();
        this.unregisterDisposer(segmentListWidget);
        segmentListWidget = this.segmentListWidget = undefined;
      }
    }
    if (segmentListWidget === undefined) {
      this.segmentListWidget = segmentListWidget =
          this.registerDisposer(new AnnotationSegmentListWidget(reference, annotationLayer));
    }
    element.appendChild(segmentListWidget.element);

    const description = document.createElement('textarea');
    description.value = annotation.description || '';
    description.rows = 3;
    description.className = 'neuroglancer-annotation-details-description';
    description.placeholder = 'Description';
    if (annotationLayer.source.readonly) {
      description.readOnly = true;
    } else {
      description.addEventListener('change', () => {
        const x = description.value;
        annotationLayer.source.update(reference, {...annotation, description: x ? x : undefined});
        annotationLayer.source.commit(reference);
      });
    }
    element.appendChild(description);
  }
}

export class AnnotationTab extends Tab {
  private layerView = this.registerDisposer(
      new AnnotationLayerView(this.layer, this.state.addRef(), this.layer.annotationDisplayState));
  private detailsTab = this.registerDisposer(new AnnotationDetailsTab(
      this.state, this.layer.annotationDisplayState,
      (layerPosition, state) => setLayerPosition(
          this.layer, state.chunkTransform.value as ChunkTransformParameters, layerPosition)));
  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>) {
    super();
    this.registerDisposer(state);
    const {element} = this;
    element.classList.add('neuroglancer-annotations-tab');
    element.appendChild(this.layerView.element);
    element.appendChild(this.detailsTab.element);
    const updateDetailsVisibility = () => {
      this.detailsTab.visibility.value = this.state.validValue !== undefined && this.visible ?
          WatchableVisibilityPriority.VISIBLE :
          WatchableVisibilityPriority.IGNORED;
    };
    this.registerDisposer(this.state.changed.add(updateDetailsVisibility));
    this.registerDisposer(this.visibility.changed.add(updateDetailsVisibility));
  }
}

function getSelectedAssocatedSegment(annotationLayer: AnnotationLayerState) {
  let segments: Uint64[]|undefined;
  const segmentationState = annotationLayer.displayState.segmentationState.value;
  if (segmentationState != null) {
    if (segmentationState.segmentSelectionState.hasSelectedSegment) {
      segments = [segmentationState.segmentSelectionState.selectedSegment.clone()];
    }
  }
  return segments;
}

abstract class PlaceAnnotationTool extends Tool {
  group: string;
  annotationDescription: string|undefined;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super();
    this.annotationDescription = verifyObjectProperty(options, 'description', verifyOptionalString);
  }

  get annotationLayer() {
    for (const state of this.layer.annotationStates.states) {
      if (!state.source.readonly) return state;
    }
    return undefined;
  }
}

const ANNOTATE_POINT_TOOL_ID = 'annotatePoint';
const ANNOTATE_LINE_TOOL_ID = 'annotateLine';
const ANNOTATE_BOUNDING_BOX_TOOL_ID = 'annotateBoundingBox';
const ANNOTATE_ELLIPSOID_TOOL_ID = 'annotateSphere';

export class PlacePointTool extends PlaceAnnotationTool {
  constructor(layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
  }

  trigger(mouseState: MouseSelectionState) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
      if (point === undefined) return;
      const annotation: Annotation = {
        id: '',
        description: '',
        segments: getSelectedAssocatedSegment(annotationLayer),
        point,
        type: AnnotationType.POINT,
      };
      const reference = annotationLayer.source.add(annotation, /*commit=*/ true);
      this.layer.selectedAnnotation.value = {
        id: reference.id,
        sourceIndex: annotationLayer.sourceIndex,
        subsource: annotationLayer.subsourceId
      };
      reference.dispose();
    }
  }

  get description() {
    return `annotate point`;
  }

  toJSON() {
    return ANNOTATE_POINT_TOOL_ID;
  }
}

function getMousePositionInAnnotationCoordinates(
    mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Float32Array|
    undefined {
  const chunkTransform = annotationLayer.chunkTransform.value;
  if (chunkTransform.error !== undefined) return undefined;
  const chunkPosition = new Float32Array(chunkTransform.modelTransform.unpaddedRank);
  if (!getChunkPositionFromCombinedGlobalLocalPositions(
          chunkPosition, mouseState.position, annotationLayer.localPosition.value,
          chunkTransform.layerRank, chunkTransform.combinedGlobalLocalToChunkTransform)) {
    return undefined;
  }
  return chunkPosition;
}

abstract class TwoStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;

  abstract getInitialAnnotation(
      mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation;
  abstract getUpdatedAnnotation(
      oldAnnotation: Annotation, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation;

  trigger(mouseState: MouseSelectionState) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const updatePointB = () => {
        const state = this.inProgressAnnotation!;
        const reference = state.reference;
        const newAnnotation =
            this.getUpdatedAnnotation(reference.value!, mouseState, annotationLayer);
        state.annotationLayer.source.update(reference, newAnnotation);
        this.layer.selectedAnnotation.value = {
          id: reference.id,
          sourceIndex: annotationLayer.sourceIndex,
          subsource: annotationLayer.subsourceId
        };
      };

      if (this.inProgressAnnotation === undefined) {
        const reference = annotationLayer.source.add(
            this.getInitialAnnotation(mouseState, annotationLayer), /*commit=*/ false);
        this.layer.selectedAnnotation.value = {
          id: reference.id,
          sourceIndex: annotationLayer.sourceIndex,
          subsource: annotationLayer.subsourceId,
        };
        const mouseDisposer = mouseState.changed.add(updatePointB);
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
      } else {
        updatePointB();
        this.inProgressAnnotation.annotationLayer.source.commit(
            this.inProgressAnnotation.reference);
        this.inProgressAnnotation.disposer();
        this.inProgressAnnotation = undefined;
      }
    }
  }

  disposed() {
    this.deactivate();
    super.disposed();
  }

  deactivate() {
    if (this.inProgressAnnotation !== undefined) {
      this.inProgressAnnotation.annotationLayer.source.delete(this.inProgressAnnotation.reference);
      this.inProgressAnnotation.disposer();
      this.inProgressAnnotation = undefined;
    }
  }
}


abstract class PlaceTwoCornerAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.LINE|AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return <AxisAlignedBoundingBox|Line>{
      id: '',
      type: this.annotationType,
      description: '',
      pointA: point,
      pointB: point,
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: AxisAlignedBoundingBox|Line, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    if (point === undefined) return oldAnnotation;
    return {...oldAnnotation, pointB: point};
  }
}

export class PlaceBoundingBoxTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate bounding box`;
  }

  toJSON() {
    return ANNOTATE_BOUNDING_BOX_TOOL_ID;
  }
}
PlaceBoundingBoxTool.prototype.annotationType = AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

export class PlaceLineTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate line`;
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = super.getInitialAnnotation(mouseState, annotationLayer);
    result.segments = getSelectedAssocatedSegment(annotationLayer);
    return result;
  }

  getUpdatedAnnotation(
      oldAnnotation: Line|AxisAlignedBoundingBox, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const result = super.getUpdatedAnnotation(oldAnnotation, mouseState, annotationLayer);
    const segments = result.segments;
    if (segments !== undefined && segments.length > 0) {
      segments.length = 1;
    }
    let newSegments = getSelectedAssocatedSegment(annotationLayer);
    if (newSegments && segments) {
      newSegments = newSegments.filter(x => segments.findIndex(y => Uint64.equal(x, y)) === -1);
    }
    result.segments = [...(segments || []), ...(newSegments || [])] || undefined;
    return result;
  }

  toJSON() {
    return ANNOTATE_LINE_TOOL_ID;
  }
}
PlaceLineTool.prototype.annotationType = AnnotationType.LINE;

class PlaceEllipsoidTool extends TwoStepAnnotationTool {
  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);

    return <Ellipsoid>{
      type: AnnotationType.ELLIPSOID,
      id: '',
      description: '',
      segments: getSelectedAssocatedSegment(annotationLayer),
      center: point,
      radii: vec3.fromValues(0, 0, 0),
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: Ellipsoid, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const radii = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    if (radii === undefined) return oldAnnotation;
    const center = oldAnnotation.center;
    const rank = center.length;
    for (let i = 0; i < rank; ++i) {
      radii[i] = Math.abs(center[i] - radii[i]);
    }
    return <Ellipsoid>{
      ...oldAnnotation,
      radii,
    };
  }
  get description() {
    return `annotate ellipsoid`;
  }

  toJSON() {
    return ANNOTATE_ELLIPSOID_TOOL_ID;
  }
}

registerTool(
    ANNOTATE_POINT_TOOL_ID,
    (layer, options) => new PlacePointTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_BOUNDING_BOX_TOOL_ID,
    (layer, options) => new PlaceBoundingBoxTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_LINE_TOOL_ID,
    (layer, options) => new PlaceLineTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_ELLIPSOID_TOOL_ID,
    (layer, options) => new PlaceEllipsoidTool(<UserLayerWithAnnotations>layer, options));

export interface UserLayerWithAnnotations extends UserLayer {
  selectedAnnotation: SelectedAnnotationState;
  annotationDisplayState: AnnotationDisplayState;
  annotationStates: MergedAnnotationStates;
  initializeAnnotationLayerViewTab(tab: AnnotationLayerView): void;
}

const SELECTED_ANNOTATION_JSON_KEY = 'selectedAnnotation';
const ANNOTATION_COLOR_JSON_KEY = 'annotationColor';
const ANNOTATION_FILL_OPACITY_JSON_KEY = 'annotationFillOpacity';
export function UserLayerWithAnnotationsMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  abstract class C extends Base implements UserLayerWithAnnotations {
    annotationStates = this.registerDisposer(new MergedAnnotationStates());
    annotationDisplayState = new AnnotationDisplayState();
    selectedAnnotation = this.registerDisposer(new SelectedAnnotationState(this.annotationStates));

    constructor(...args: any[]) {
      super(...args);
      this.selectedAnnotation.changed.add(this.specificationChanged.dispatch);
      this.annotationDisplayState.color.changed.add(this.specificationChanged.dispatch);
      this.annotationDisplayState.fillOpacity.changed.add(this.specificationChanged.dispatch);
      this.tabs.add('annotations', {
        label: 'Annotations',
        order: 10,
        getter: () => new AnnotationTab(this, this.selectedAnnotation.addRef())
      });

      let annotationStateReadyBinding: (() => void)|undefined;

      const updateReadyBinding = () => {
        const isReady = this.isReady;
        if (isReady && annotationStateReadyBinding !== undefined) {
          annotationStateReadyBinding();
          annotationStateReadyBinding = undefined;
        } else if (!isReady && annotationStateReadyBinding === undefined) {
          annotationStateReadyBinding = this.annotationStates.markLoading();
        }
      };
      this.readyStateChanged.add(updateReadyBinding);
      updateReadyBinding();

      const {mouseState} = this.manager.layerSelectedValues;
      this.registerDisposer(mouseState.changed.add(() => {
        if (mouseState.active) {
          const {pickedAnnotationLayer} = mouseState;
          if (pickedAnnotationLayer !== undefined &&
              this.annotationStates.states.includes(pickedAnnotationLayer)) {
            const existingValue = this.annotationDisplayState.hoverState.value;
            if (existingValue === undefined || existingValue.id !== mouseState.pickedAnnotationId!
                || existingValue.partIndex !== mouseState.pickedOffset ||
                existingValue.annotationLayerState !== pickedAnnotationLayer) {
              this.annotationDisplayState.hoverState.value = {
                id: mouseState.pickedAnnotationId!,
                partIndex: mouseState.pickedOffset,
                annotationLayerState: pickedAnnotationLayer,
              };
            }
            return;
          }
        }
        this.annotationDisplayState.hoverState.value = undefined;
      }));
    }

    initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
      tab;
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      this.selectedAnnotation.restoreState(specification[SELECTED_ANNOTATION_JSON_KEY]);
      this.annotationDisplayState.color.restoreState(specification[ANNOTATION_COLOR_JSON_KEY]);
      this.annotationDisplayState.fillOpacity.restoreState(
          specification[ANNOTATION_FILL_OPACITY_JSON_KEY]);
    }

    addLocalAnnotations(
        loadedSubsource: LoadedDataSubsource, source: AnnotationSource, role: RenderLayerRole) {
      const {subsourceEntry} = loadedSubsource;
      const state = new AnnotationLayerState({
        localPosition: this.localPosition,
        transform: loadedSubsource.getRenderLayerTransform(),
        source,
        displayState: this.annotationDisplayState,
        dataSource: loadedSubsource.loadedDataSource.layerDataSource,
        subsourceIndex: loadedSubsource.subsourceIndex,
        subsourceId: subsourceEntry.id,
        role,
      });
      this.addAnnotationLayerState(state, loadedSubsource);
    }

    addStaticAnnotations(loadedSubsource: LoadedDataSubsource) {
      const {subsourceEntry} = loadedSubsource;
      const {staticAnnotations} = subsourceEntry.subsource;
      if (staticAnnotations === undefined) return false;
      loadedSubsource.activate(() => {
        this.addLocalAnnotations(
            loadedSubsource, staticAnnotations, RenderLayerRole.DEFAULT_ANNOTATION);
      });
      return true;
    }

    addAnnotationLayerState(state: AnnotationLayerState, loadedSubsource: LoadedDataSubsource) {
      const refCounted = loadedSubsource.activated!;
      refCounted.registerDisposer(this.annotationStates.add(state));
      const annotationLayer = new AnnotationLayer(this.manager.chunkManager, state.addRef());
      {
        const renderLayer = new SliceViewAnnotationLayer(annotationLayer);
        refCounted.registerDisposer(this.addRenderLayer(renderLayer));
        refCounted.registerDisposer(loadedSubsource.messages.addChild(renderLayer.messages));
      }
      {
        const renderLayer = new PerspectiveViewAnnotationLayer(annotationLayer.addRef());
        refCounted.registerDisposer(this.addRenderLayer(renderLayer));
        refCounted.registerDisposer(loadedSubsource.messages.addChild(renderLayer.messages));
      }
      if (annotationLayer.source instanceof MultiscaleAnnotationSource) {
        const dataFetchLayer = refCounted.registerDisposer(new DataFetchSliceViewRenderLayer(
            annotationLayer.source.addRef(),
            {transform: state.transform, localPosition: state.localPosition}));
        refCounted.registerDisposer(loadedSubsource.messages.addChild(dataFetchLayer.messages));
        refCounted.registerDisposer(
            registerNested(this.annotationDisplayState.filterBySegmentation, (context, value) => {
              if (!value) {
                context.registerDisposer(this.addRenderLayer(dataFetchLayer.addRef()));
              }
            }));
      }
    }

    toJSON() {
      const x = super.toJSON();
      x[SELECTED_ANNOTATION_JSON_KEY] = this.selectedAnnotation.toJSON();
      x[ANNOTATION_COLOR_JSON_KEY] = this.annotationDisplayState.color.toJSON();
      x[ANNOTATION_FILL_OPACITY_JSON_KEY] = this.annotationDisplayState.fillOpacity.toJSON();
      return x;
    }
  }
  return C;
}
