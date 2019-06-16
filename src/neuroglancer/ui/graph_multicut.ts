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

/**
 * @file User interface for performing multiple-segment graph cuts
 *       on graph-enabled segmentation layers
 */

import './annotations.css';
import './graph.css';

import debounce from 'lodash/debounce';
import {Annotation, AnnotationReference, AnnotationType, getAnnotationTypeHandler} from 'neuroglancer/annotation';
import {GraphOperationLayerState} from 'neuroglancer/graph/graph_operation_layer_state';
import {MouseSelectionState} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentSelection} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
import {getPositionSummary} from 'neuroglancer/ui/annotations';
import {Tool} from 'neuroglancer/ui/tool';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {verifyObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {StackView, Tab} from 'neuroglancer/widget/tab_view';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import {SegmentationUserLayerWithGraph} from '../segmentation_user_layer_with_graph';

type GraphOperationMarkerId = {
  id: string,
};

export class GraphMultiCutWidget extends RefCounted {
  element = document.createElement('div');
  private segmentationState: SegmentationDisplayState|undefined|null;
  private debouncedUpdateView = debounce(() => this.updateView(), 0);
  constructor(
      public reference: Borrowed<AnnotationReference>,
      public annotationLayer: GraphOperationLayerState) {
    super();
    this.element.className = 'neuroglancer-annotation-segment-list';
    this.registerDisposer(annotationLayer.segmentationState.changed.add(this.debouncedUpdateView));
    this.registerDisposer(() => this.unregisterSegmentationState());
    this.registerDisposer(reference.changed.add(this.debouncedUpdateView));
    this.updateView();
  }

  private unregisterSegmentationState() {
    const {segmentationState} = this;
    if (segmentationState != null) {
      segmentationState.rootSegments.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentColorHash.changed.remove(this.debouncedUpdateView);
      segmentationState.segmentSelectionState.changed.remove(this.debouncedUpdateView);
      this.segmentationState = undefined;
    }
  }

  private updateView() {
    const segmentationState = this.annotationLayer.segmentationState.value;
    if (segmentationState !== this.segmentationState) {
      this.unregisterSegmentationState();
      this.segmentationState = segmentationState;
      if (segmentationState != null) {
        segmentationState.rootSegments.changed.add(this.debouncedUpdateView);
        segmentationState.segmentColorHash.changed.add(this.debouncedUpdateView);
        segmentationState.segmentSelectionState.changed.add(this.debouncedUpdateView);
      }
    }

    const {element} = this;
    // Remove existing segment representations.
    removeChildren(element);
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
      }
      element.appendChild(child);
    });
  }
}

export class SelectedGraphOperationState extends RefCounted {
  private value_: GraphOperationMarkerId|undefined;
  changed = new NullarySignal();

  private annotationLayer: GraphOperationLayerState|undefined;
  private reference_: Owned<AnnotationReference>|undefined;

  get reference() {
    return this.reference_;
  }

  constructor(public annotationLayerState: Owned<WatchableRefCounted<GraphOperationLayerState>>) {
    super();
    this.registerDisposer(annotationLayerState);
    this.registerDisposer(annotationLayerState.changed.add(this.validate));
    this.updateAnnotationLayer();
    this.reference_ = undefined;
    this.value_ = undefined;
  }

  get value() {
    return this.value_;
  }

  get validValue() {
    return this.annotationLayer && this.value_;
  }

  set value(value: GraphOperationMarkerId|undefined) {
    this.value_ = value;
    const reference = this.reference_;
    if (reference !== undefined) {
      if (value === undefined || reference.id !== value.id) {
        this.unbindReference();
      }
    }
    this.validate();
    this.changed.dispatch();
  }

  private updateAnnotationLayer() {
    const annotationLayer = this.annotationLayerState.value;
    if (annotationLayer === this.annotationLayer) {
      return false;
    }
    this.unbindLayer();
    this.annotationLayer = annotationLayer;
    if (annotationLayer !== undefined) {
      annotationLayer.sourceA.changed.add(this.validate);
      annotationLayer.sourceB.changed.add(this.validate);
    }
    return true;
  }

  private unbindLayer() {
    if (this.annotationLayer !== undefined) {
      this.annotationLayer.sourceA.changed.remove(this.validate);
      this.annotationLayer.sourceB.changed.remove(this.validate);
      this.annotationLayer = undefined;
    }
  }

  disposed() {
    this.unbindLayer();
    this.unbindReference();
    super.disposed();
  }

  private unbindReference() {
    const reference = this.reference_;
    if (reference !== undefined) {
      reference.changed.remove(this.referenceChanged);
      this.reference_ = undefined;
    }
  }

  private referenceChanged = (() => {
    this.validate();
    this.changed.dispatch();
  });

  private validate = (() => {
    const updatedLayer = this.updateAnnotationLayer();
    const {annotationLayer} = this;
    if (annotationLayer !== undefined) {
      const value = this.value_;
      if (value !== undefined) {
        let reference = this.reference_;
        if (reference !== undefined && reference.id !== value.id) {
          // Id changed.
          value.id = reference.id;
        } else if (reference === undefined) {
          if (annotationLayer.sourceA.references.get(value.id) !== undefined) {
            reference = this.reference_ = annotationLayer.sourceA.getReference(value.id);
          } else {
            reference = this.reference_ = annotationLayer.sourceB.getReference(value.id);
          }
          reference.changed.add(this.referenceChanged);
        }
        if (reference.value === null) {
          this.unbindReference();
          this.value = undefined;
          return;
        }
      } else {
        this.unbindReference();
      }
    }
    if (updatedLayer) {
      this.changed.dispatch();
    }
  });

  toJSON() {
    const value = this.value_;
    if (value === undefined) {
      return undefined;
    }
    return value.id;
  }
  reset() {
    this.value = undefined;
  }
  restoreState(x?: string) {
    if (x === undefined) {
      this.value = undefined;
      return;
    }
    this.value = {'id': verifyString(x)};
    return;
  }
}

function getCenterPosition(annotation: Annotation, transform: mat4) {
  const center = vec3.create();
  switch (annotation.type) {
    case AnnotationType.POINT:
      vec3.copy(center, annotation.point);
      break;
  }
  return vec3.transformMat4(center, center, transform);
}

export class GraphOperationLayerView extends Tab {
  private annotationListContainer = document.createElement('ul');
  private annotationListElements = new Map<string, HTMLElement>();
  private previousSelectedId: string|undefined;
  private previousHoverId: string|undefined;
  private updated = false;

  constructor(
      public wrapper: Borrowed<SegmentationUserLayerWithGraph>,
      public state: Owned<SelectedGraphOperationState>,
      public annotationLayer: Owned<GraphOperationLayerState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-layer-view');
    this.annotationListContainer.classList.add('neuroglancer-annotation-list');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(annotationLayer);
    const {sourceA, sourceB} = annotationLayer;
    const updateView = () => {
      this.updated = false;
      this.updateView();
    };
    this.registerDisposer(sourceA.changed.add(updateView));
    this.registerDisposer(sourceB.changed.add(updateView));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.registerDisposer(annotationLayer.transform.changed.add(updateView));
    this.updateView();

    const toolbox = document.createElement('div');
    toolbox.className = 'neuroglancer-graphoperation-toolbox';

    {
      const pointButton = document.createElement('button');
      pointButton.textContent = getAnnotationTypeHandler(AnnotationType.POINT).icon;
      pointButton.title = 'Set split point';
      pointButton.addEventListener('click', () => {
        this.wrapper.tool.value = new PlaceGraphOperationMarkerTool(this.wrapper, {});
      });
      toolbox.appendChild(pointButton);
    }

    {
      const toggleGroupButton = document.createElement('button');
      toggleGroupButton.textContent = '🔵↔🔴';
      toggleGroupButton.title = 'Toggle Mulit-Cut Group';
      toggleGroupButton.addEventListener('click', () => {
        this.annotationLayer.toggleSource();
        this.updateView();
      });
      toolbox.appendChild(toggleGroupButton);
    }

    {
      const confirmButton = document.createElement('button');
      confirmButton.textContent = '✔️';
      confirmButton.title = 'Perform Multi-Cut';
      confirmButton.addEventListener('click', () => {
        const {objectToLocal} = annotationLayer.sourceA;
        let sources = Array<SegmentSelection>();
        let sinks = Array<SegmentSelection>();
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

        this.wrapper.chunkedGraphLayer!.splitSegments(sources, sinks).then((splitRoots) => {
          if (splitRoots.length === 0) {
            StatusMessage.showTemporaryMessage(`No split found.`, 3000);
          } else {
            for (let segment of [...sinks, ...sources]) {
              this.annotationLayer.segmentationState.value!.rootSegments.delete(segment.rootId);
            }
            for (let splitRoot of splitRoots) {
              this.annotationLayer.segmentationState.value!.rootSegments.add(splitRoot);
            }
          }
        });
      });
      toolbox.appendChild(confirmButton);
    }

    {
      const cancelButton = document.createElement('button');
      cancelButton.textContent = '❌';
      cancelButton.title = 'Abort Multi-Cut';
      cancelButton.addEventListener('click', () => {
        for (const annotation of sourceA) {
          const ref = annotationLayer.sourceA.getReference(annotation.id);
          try {
            annotationLayer.sourceA.delete(ref);
          } finally {
            ref.dispose();
          }
        }
        for (const annotation of sourceB) {
          const ref = annotationLayer.sourceB.getReference(annotation.id);
          try {
            annotationLayer.sourceB.delete(ref);
          } finally {
            ref.dispose();
          }
        }
      });
      toolbox.appendChild(cancelButton);
    }


    this.element.appendChild(toolbox);

    this.element.appendChild(this.annotationListContainer);

    this.annotationListContainer.addEventListener('mouseleave', () => {
      this.annotationLayer.hoverState.value = undefined;
    });
    this.registerDisposer(
        this.annotationLayer.hoverState.changed.add(() => this.updateHoverView()));
    this.registerDisposer(this.state.changed.add(() => this.updateSelectionView()));
  }

  private updateSelectionView() {
    const selectedValue = this.state.value;
    let newSelectedId: string|undefined;
    if (selectedValue !== undefined) {
      newSelectedId = selectedValue.id;
    }
    const {previousSelectedId} = this;
    if (newSelectedId === previousSelectedId) {
      return;
    }
    if (previousSelectedId !== undefined) {
      const element = this.annotationListElements.get(previousSelectedId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-selected');
      }
    }
    if (newSelectedId !== undefined) {
      const element = this.annotationListElements.get(newSelectedId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-selected');
        element.scrollIntoView();
      }
    }
    this.previousSelectedId = newSelectedId;
  }

  private updateHoverView() {
    const selectedValue = this.annotationLayer.hoverState.value;
    let newHoverId: string|undefined;
    if (selectedValue !== undefined) {
      newHoverId = selectedValue.id;
    }
    const {previousHoverId} = this;
    if (newHoverId === previousHoverId) {
      return;
    }
    if (previousHoverId !== undefined) {
      const element = this.annotationListElements.get(previousHoverId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-hover');
      }
    }
    if (newHoverId !== undefined) {
      const element = this.annotationListElements.get(newHoverId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-hover');
      }
    }
    this.previousHoverId = newHoverId;
  }

  private updateView() {
    if (!this.visible) {
      return;
    }
    if (this.updated) {
      return;
    }
    const {annotationLayer, annotationListContainer, annotationListElements} = this;
    const {sourceA, sourceB} = annotationLayer;
    removeChildren(annotationListContainer);
    this.annotationListElements.clear();
    const {objectToGlobal} = annotationLayer;
    for (const annotation of [...sourceA, ...sourceB]) {
      const element = this.makeAnnotationListElement(annotation, objectToGlobal);
      annotationListContainer.appendChild(element);
      annotationListElements.set(annotation.id, element);
      element.addEventListener('mouseenter', () => {
        this.annotationLayer.hoverState.value = {id: annotation.id};
      });
      element.addEventListener('click', () => {
        this.state.value = {id: annotation.id};
      });

      element.addEventListener('mouseup', (event: MouseEvent) => {
        if (event.button === 2) {
          this.setSpatialCoordinates(
              getCenterPosition(annotation, this.annotationLayer.objectToGlobal));
        }
      });
    }
    this.previousSelectedId = undefined;
    this.previousHoverId = undefined;
    this.updated = true;
    this.updateHoverView();
    this.updateSelectionView();
  }

  private makeAnnotationListElement(annotation: Annotation, transform: mat4) {
    const element = document.createElement('li');
    element.title = 'Click to select, right click to recenter view.';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-icon';
    icon.textContent = getAnnotationTypeHandler(annotation.type).icon;
    element.appendChild(icon);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-position';
    getPositionSummary(position, annotation, transform, this.voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);

    return element;
  }
}

export class GraphOperationDetailsTab extends Tab {
  private valid = false;
  private mouseEntered = false;
  private hoverState: WatchableValue<GraphOperationMarkerId|undefined>|undefined;
  private segmentListWidget: GraphMultiCutWidget|undefined;
  constructor(
      public state: Owned<SelectedGraphOperationState>, public voxelSize: VoxelSize,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-details');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
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
      if (this.hoverState !== undefined) {
        this.hoverState.value = this.state.value;
      }
    });
    this.element.addEventListener('mouseleave', () => {
      this.mouseEntered = false;
      if (this.hoverState !== undefined) {
        this.hoverState.value = undefined;
      }
    });
    this.updateView();
  }

  private updateView() {
    if (!this.visible) {
      this.element.style.display = 'none';
      this.hoverState = undefined;
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
    const annotationLayer = this.state.annotationLayerState.value!;
    this.hoverState = annotationLayer.hoverState;
    if (this.mouseEntered) {
      this.hoverState.value = value;
    }

    const {objectToGlobal} = annotationLayer;
    const {voxelSize} = this;

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

    const deleteButton = makeTextIconButton('🗑', 'Delete annotation');
    deleteButton.addEventListener('click', () => {
      const ref = annotationLayer.getReference(value.id);
      try {
        annotationLayer.delete(ref);
      } finally {
        ref.dispose();
      }
    });
    title.appendChild(deleteButton);

    const closeButton = makeCloseButton();
    closeButton.title = 'Hide annotation details';
    closeButton.addEventListener('click', () => {
      this.state.value = undefined;
    });
    title.appendChild(closeButton);

    element.appendChild(title);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-details-position';
    getPositionSummary(position, annotation, objectToGlobal, voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);

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
          this.registerDisposer(new GraphMultiCutWidget(reference, annotationLayer));
    }
    element.appendChild(segmentListWidget.element);
  }
}

export class GraphOperationTab extends Tab {
  private stack = this.registerDisposer(
      new StackView<GraphOperationLayerState, GraphOperationLayerView>(annotationLayerState => {
        return new GraphOperationLayerView(
            this.layer, this.state.addRef(), annotationLayerState.addRef(), this.voxelSize.addRef(),
            this.setSpatialCoordinates);
      }, this.visibility));
  private detailsTab = this.registerDisposer(new GraphOperationDetailsTab(
      this.state, this.voxelSize.addRef(), this.setSpatialCoordinates));
  constructor(
      public layer: Borrowed<SegmentationUserLayerWithGraph>,
      public state: Owned<SelectedGraphOperationState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    const {element} = this;
    element.classList.add('neuroglancer-annotations-tab');
    this.stack.element.classList.add('neuroglancer-annotations-stack');
    element.appendChild(this.stack.element);
    element.appendChild(this.detailsTab.element);
    const updateDetailsVisibility = () => {
      this.detailsTab.visibility.value = this.state.validValue !== undefined && this.visible ?
          WatchableVisibilityPriority.VISIBLE :
          WatchableVisibilityPriority.IGNORED;
    };
    this.registerDisposer(this.state.changed.add(updateDetailsVisibility));
    this.registerDisposer(this.visibility.changed.add(updateDetailsVisibility));
    const setGraphOperationLayerView = () => {
      this.stack.selected = this.state.annotationLayerState.value;
    };
    this.registerDisposer(this.state.annotationLayerState.changed.add(setGraphOperationLayerView));
    setGraphOperationLayerView();
  }
}

function getSelectedAssociatedSegment(annotationLayer: GraphOperationLayerState) {
  let segments: Uint64[]|undefined;
  const segmentationState = annotationLayer.segmentationState.value;
  if (segmentationState != null) {
    if (segmentationState.segmentSelectionState.hasSelectedSegment) {
      segments = [
        segmentationState.segmentSelectionState.rawSelectedSegment.clone(),
        segmentationState.segmentSelectionState.selectedSegment.clone()
      ];
    }
  }
  return segments;
}

abstract class PlaceGraphOperationTool extends Tool {
  group: string;
  annotationDescription: string|undefined;
  constructor(public layer: SegmentationUserLayerWithGraph, options: any) {
    super();
    if (layer.graphOperationLayerState === undefined) {
      throw new Error(`Invalid layer for graph operation tool.`);
    }
    this.annotationDescription = verifyObjectProperty(options, 'description', verifyOptionalString);
  }

  get graphOperationLayer() {
    return this.layer.graphOperationLayerState.value;
  }
}

export class PlaceGraphOperationMarkerTool extends PlaceGraphOperationTool {
  constructor(layer: SegmentationUserLayerWithGraph, options: any) {
    super(layer, options);
  }

  trigger(mouseState: MouseSelectionState) {
    const {graphOperationLayer} = this;
    if (graphOperationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const annotation: Annotation = {
        id: '',
        description: '',
        segments: getSelectedAssociatedSegment(graphOperationLayer),
        point: vec3.transformMat4(
            vec3.create(), mouseState.position, graphOperationLayer.globalToObject),
        type: AnnotationType.POINT,
      };
      const reference = graphOperationLayer.activeSource.add(annotation, /*commit=*/true);
      this.layer.selectedGraphOperationElement.value = {id: reference.id};
      reference.dispose();
    }
  }

  get description() {
    return `set graph merge/split point`;
  }

  toJSON() {
    // Don't register the tool, it's not that important to restore and likely to cause compatibity
    // issues in the future if cluttering the state
    return;
  }
}
