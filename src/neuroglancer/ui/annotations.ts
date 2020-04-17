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
import {Annotation, AnnotationReference, AnnotationSource, AnnotationTag, AnnotationType, AxisAlignedBoundingBox, Collection, Ellipsoid, getAnnotationTypeHandler, Line, LineStrip, LocalAnnotationSource, makeAnnotationId, Point, Spoke} from 'neuroglancer/annotation';
import {AnnotationTool, MultiStepAnnotationTool, PlaceAnnotationTool, SubAnnotationTool} from 'neuroglancer/annotation/annotation';
import {PlaceBoundingBoxTool} from 'neuroglancer/annotation/bounding_box';
import {PlaceSphereTool} from 'neuroglancer/annotation/ellipsoid';
import {AnnotationLayer, AnnotationLayerState, PerspectiveViewAnnotationLayer, SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
import {DataFetchSliceViewRenderLayer, MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {PlaceLineStripTool} from 'neuroglancer/annotation/line_strip';
import {PlacePointTool} from 'neuroglancer/annotation/point';
import {setAnnotationHoverStateFromMouseState} from 'neuroglancer/annotation/selection';
import {PlaceSpokeTool} from 'neuroglancer/annotation/spoke';
import {UserLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {registerNested, TrackableValueInterface, WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
import {HidingList} from 'neuroglancer/ui/hiding_list';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {mat4, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyOptionalInt, verifyString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {formatBoundingBoxVolume, formatIntegerBounds, formatIntegerPoint, formatLength} from 'neuroglancer/util/spatial_units';
import {Uint64} from 'neuroglancer/util/uint64';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {ColorWidget} from 'neuroglancer/widget/color';
import {MinimizableGroupWidget} from 'neuroglancer/widget/minimizable_group';
import {RangeWidget} from 'neuroglancer/widget/range';
import {StackView, Tab} from 'neuroglancer/widget/tab_view';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

import {PlaceCollectionTool} from '../annotation/collection';

const Papa = require('papaparse');

type AnnotationIdAndPart = {
  id: string,
  partIndex?: number,
  multiple?: Set<string>,
  ungroupable?: boolean
};

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
    this.registerDisposer(annotationLayer.segmentationState.changed.add(this.debouncedUpdateView));
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
          if (segmentationState.rootSegments.has(segment)) {
            segmentationState.rootSegments.delete(segment);
          } else {
            segmentationState.rootSegments.add(segment);
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
export class SelectedAnnotationState extends RefCounted implements
    TrackableValueInterface<AnnotationIdAndPart|undefined> {
  private value_: AnnotationIdAndPart|undefined;
  changed = new NullarySignal();

  private annotationLayer: AnnotationLayerState|undefined;
  private reference_: Owned<AnnotationReference>|undefined;

  get reference() {
    return this.reference_;
  }

  constructor(public annotationLayerState: Owned<WatchableRefCounted<AnnotationLayerState>>) {
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

  set value(value: AnnotationIdAndPart|undefined) {
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
      annotationLayer.source.changed.add(this.validate);
    }
    return true;
  }

  private unbindLayer() {
    if (this.annotationLayer !== undefined) {
      this.annotationLayer.source.changed.remove(this.validate);
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
          reference = this.reference_ = annotationLayer.source.getReference(value.id);
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
    if (value.partIndex === 0) {
      return value.id;
    }
    return value;
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
      this.value = {'id': x, 'partIndex': 0};
      return;
    }
    verifyObject(x);
    this.value = {
      'id': verifyObjectProperty(x, 'id', verifyString),
      'partIndex': verifyObjectProperty(x, 'partIndex', verifyOptionalInt),
    };
  }
}

const tempVec3 = vec3.create();

function makePointLink(
    point: vec3, transform: mat4, voxelSize: VoxelSize,
    setSpatialCoordinates?: (point: vec3) => void) {
  const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
  const positionText = formatIntegerPoint(voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
  if (setSpatialCoordinates !== undefined) {
    const element = document.createElement('span');
    element.className = 'neuroglancer-voxel-coordinates-link';
    element.textContent = positionText;
    element.title = `Center view on voxel coordinates ${positionText}.`;
    element.addEventListener('click', () => {
      setSpatialCoordinates(spatialPoint);
    });
    return element;
  } else {
    return document.createTextNode(positionText);
  }
}

export function getPositionSummary(
    element: HTMLElement, annotation: Annotation, transform: mat4, voxelSize: VoxelSize,
    setSpatialCoordinates?: (point: vec3) => void) {
  const makePointLinkWithTransform = (point: vec3) =>
      makePointLink(point, transform, voxelSize, setSpatialCoordinates);

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
      const transformedRadii = transformVectorByMat4(tempVec3, annotation.radii, transform);
      voxelSize.voxelFromSpatial(transformedRadii, transformedRadii);
      element.appendChild(document.createTextNode('±' + formatIntegerBounds(transformedRadii)));
      break;
    case AnnotationType.SPOKE:
    case AnnotationType.LINE_STRIP:
    case AnnotationType.COLLECTION: {
      element.appendChild(makePointLinkWithTransform(annotation.source));
      break;
    }
  }
}

function getCenterPosition(annotation: Annotation, transform: mat4) {
  const center = vec3.create();
  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      vec3.add(center, annotation.pointA, annotation.pointB);
      vec3.scale(center, center, 0.5);
      break;
    case AnnotationType.POINT:
      vec3.copy(center, annotation.point);
      break;
    case AnnotationType.ELLIPSOID:
      vec3.copy(center, annotation.center);
      break;
    case AnnotationType.SPOKE:
    case AnnotationType.LINE_STRIP:
    case AnnotationType.COLLECTION:
      vec3.copy(center, annotation.source);
      break;
  }
  return vec3.transformMat4(center, center, transform);
}

export class AnnotationLayerView extends Tab {
  private annotationListContainer = document.createElement('ul');
  private annotationListElements = new Map<string, HTMLElement>();
  private annotationHidingList: HidingList;
  private annotationsToAdd: HTMLElement[] = [];
  private annotationTags = new Map<number, HTMLOptionElement>();
  private previousSelectedId: string|undefined;
  private previousHoverId: string|undefined;
  private updated = false;
  private toolbox: HTMLDivElement;
  private buttonMap: any = {};
  groupVisualization = this.registerDisposer(new MinimizableGroupWidget('Visualization'));
  groupAnnotations = this.registerDisposer(new MinimizableGroupWidget('Annotations'));

  private highlightButton(typekey: string, toolset?: AnnotationType) {
    let target = this.toolbox.querySelector(`.${typekey}`);
    if (target) {
      target.classList.remove(typekey);
    }
    if (toolset !== undefined) {
      this.buttonMap[toolset].classList.add(typekey);
    }
  }

  private changeTool(toolset?: AnnotationType) {
    const activeToolkey = 'neuroglancer-active-tool';
    const activeChildToolKey = 'neuroglancer-child-tool';
    const currentTool = <PlaceAnnotationTool>this.layer.tool.value;
    const toCollection = toolset === AnnotationType.COLLECTION;
    const setTool = (parent?: MultiStepAnnotationTool) => {
      let tool;
      switch (toolset) {
        case AnnotationType.POINT:
          tool = PlacePointTool;
          break;
        case AnnotationType.LINE:
          tool = PlaceLineTool;
          break;
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
          tool = PlaceBoundingBoxTool;
          break;
        case AnnotationType.ELLIPSOID:
          tool = PlaceSphereTool;
          break;
        case AnnotationType.SPOKE:
          tool = PlaceSpokeTool;
          break;
        case AnnotationType.LINE_STRIP:
          tool = PlaceLineStripTool;
          break;
        case AnnotationType.COLLECTION:
          tool = PlaceCollectionTool;
          break;
      }
      const {toolbox} = this;
      if (parent) {
        if (parent.childTool) {
          parent.childTool.dispose();
        }
        parent.childTool =
            tool ? <SubAnnotationTool>new tool(this.layer, {toolbox, parent}) : undefined;
        parent.toolset = <AnnotationTool>tool;
        this.layer.tool.changed.dispatch();
      } else {
        this.layer.tool.value = tool ? new tool(this.layer, {toolbox}) : undefined;
      }
    };

    if (currentTool && toolset !== undefined) {
      const isCollection = currentTool.annotationType === AnnotationType.COLLECTION;
      const multiTool = <MultiStepAnnotationTool>currentTool;
      if (isCollection && !toCollection) {
        const {childTool} = multiTool;
        if (childTool) {
          if (childTool.annotationType === toolset) {
            toolset = undefined;
          }
          const {COLLECTION, LINE_STRIP, SPOKE} = AnnotationType;
          const multiStepTypes = <(AnnotationType | undefined)[]>[COLLECTION, LINE_STRIP, SPOKE];
          if (multiStepTypes.includes(childTool.annotationType)) {
            multiTool.complete();
          }
        }
        this.highlightButton(activeChildToolKey, toolset);
        setTool(/*parent=*/multiTool);
      } else if (currentTool.annotationType === toolset) {
        multiTool.complete(false, true);
        toolset = undefined;
        this.highlightButton(activeToolkey);
        this.highlightButton(activeChildToolKey);
        setTool();
      } else {
        if (!isCollection) {
          multiTool.complete();
        }
        this.highlightButton(activeToolkey, toolset);
        setTool();
      }
    } else {
      this.highlightButton(activeToolkey, toolset);
      this.highlightButton(activeChildToolKey);
      setTool();
    }
  }

  private buttonFactory(type: AnnotationType): HTMLButtonElement {
    const button = document.createElement('button');
    const annotationType = getAnnotationTypeHandler(type);
    button.textContent = annotationType.icon;
    button.title = annotationType.title;
    button.addEventListener('click', () => {
      this.changeTool(type);
    });
    this.buttonMap[type] = button;
    return button;
  }

  private annotationToolboxSetup() {
    if (!this.annotationLayer.source.readonly) {
      const annotationTypes =
          <AnnotationType[]>Object.values(AnnotationType).filter(enu => !isNaN(Number(enu)));
      const annotationButtons = annotationTypes.map((value) => this.buttonFactory(value));
      const getActiveToolByType = (toolset?: AnnotationType): PlaceAnnotationTool|undefined => {
        const tool = <MultiStepAnnotationTool>this.layer.tool.value;
        if (tool) {
          const {annotationType, childTool} = tool;
          if (annotationType === toolset) {
            return tool;
          } else if (childTool) {
            const childType = childTool.annotationType;
            if (childType === toolset) {
              return childTool;
            }
          }
        }
        return;
      };
      const activeTool = <MultiStepAnnotationTool>this.layer.tool.value;
      const separator = document.createElement('button');
      separator.disabled = true;
      separator.style.padding = '1px';
      separator.style.border = '1px';
      annotationButtons.unshift(...annotationButtons.splice(4, 1));
      annotationButtons.splice(1, 0, separator);

      if (activeTool) {
        activeTool.toolbox = this.toolbox;
        this.highlightButton('neuroglancer-active-tool', activeTool.annotationType);
      }

      this.buttonMap[AnnotationType.LINE_STRIP].addEventListener('contextmenu', () => {
        // Alt Behavior
        const tool = <PlaceLineStripTool>getActiveToolByType(AnnotationType.LINE_STRIP);
        if (tool) {
          this.buttonMap[AnnotationType.LINE_STRIP].classList.toggle(
              'neuroglancer-linestrip-looped');
          tool.looped = !tool.looped;
          this.layer.tool.changed.dispatch();
        }
      });

      this.buttonMap[AnnotationType.SPOKE].addEventListener('contextmenu', () => {
        // Alt Behavior
        const tool = <PlaceSpokeTool>getActiveToolByType(AnnotationType.SPOKE);
        if (tool) {
          this.buttonMap[AnnotationType.SPOKE].classList.toggle('neuroglancer-spoke-wheeled');
          tool.wheeled = !tool.wheeled;
          this.layer.tool.changed.dispatch();
        }
      });

      this.toolbox.append(...annotationButtons);
    }
  }

  private addOpacitySlider() {
    const widget = this.registerDisposer(new RangeWidget(this.annotationLayer.fillOpacity));
    widget.promptElement.textContent = 'Fill opacity';
    this.groupVisualization.appendFixedChild(widget.element);
  }

  private addColorPicker() {
    const colorPicker = this.registerDisposer(new ColorWidget(this.annotationLayer.color));
    colorPicker.element.title = 'Change annotation display color';
    this.toolbox.appendChild(colorPicker.element);
  }

  private bracketShortcutCheckbox() {
    const jumpingShowsSegmentationCheckbox = this.registerDisposer(
        new TrackableBooleanCheckbox(this.annotationLayer.annotationJumpingDisplaysSegmentation));
    const label = document.createElement('label');
    label.textContent = 'Bracket shortcuts show segmentation: ';
    label.appendChild(jumpingShowsSegmentationCheckbox.element);
    this.groupVisualization.appendFixedChild(label);
  }

  private filterAnnotationByTagControl() {
    const annotationTagFilter = document.createElement('select');
    const {source} = this.annotationLayer;
    annotationTagFilter.id = 'annotation-tag-filter';
    annotationTagFilter.add(new Option('View all', '0', true, true));
    const createOptionText = (tag: AnnotationTag) => {
      return '#' + tag.label + ' (id: ' + tag.id.toString() + ')';
    };
    for (const tag of source.getTags()) {
      const option = new Option(createOptionText(tag), tag.id.toString(), false, false);
      this.annotationTags.set(tag.id, option);
      annotationTagFilter.add(option);
    }
    this.registerDisposer(source.tagAdded.add((tag) => {
      const option = new Option(createOptionText(tag), tag.id.toString(), false, false);
      this.annotationTags.set(tag.id, option);
      annotationTagFilter.add(option);
    }));
    this.registerDisposer(source.tagUpdated.add((tag) => {
      const option = this.annotationTags.get(tag.id)!;
      option.text = createOptionText(tag);
      for (const annotation of source) {
        if (this.annotationLayer.source.isAnnotationTaggedWithTag(annotation.id, tag.id)) {
          this.updateAnnotationElement(annotation, false);
        }
      }
    }));
    this.registerDisposer(source.tagDeleted.add((tagId) => {
      annotationTagFilter.removeChild(this.annotationTags.get(tagId)!);
      this.annotationTags.delete(tagId);
      for (const annotation of source) {
        this.updateAnnotationElement(annotation, false);
      }
    }));
    annotationTagFilter.addEventListener('change', () => {
      const tagIdSelected = parseInt(annotationTagFilter.selectedOptions[0].value, 10);
      this.annotationLayer.selectedAnnotationTagId.value = tagIdSelected;
      this.filterAnnotationsByTag(tagIdSelected);
    });
    const label = document.createElement('label');
    label.textContent = 'Filter annotation list by tag: ';
    label.appendChild(annotationTagFilter);
    this.groupVisualization.appendFixedChild(label);
  }

  private csvToolboxSetup() {
    const exportToCSVButton = document.createElement('button');
    const importCSVButton = document.createElement('button');
    // importCSVButton.disabled = true;
    const importCSVForm = document.createElement('form');
    const importCSVFileSelect = document.createElement('input');
    exportToCSVButton.id = 'exportToCSVButton';
    exportToCSVButton.textContent = 'Export to CSV';
    exportToCSVButton.addEventListener('click', () => {
      this.exportToCSV();
    });
    importCSVFileSelect.id = 'importCSVFileSelect';
    importCSVFileSelect.type = 'file';
    importCSVFileSelect.accept = 'text/csv';
    importCSVFileSelect.multiple = true;
    importCSVFileSelect.style.display = 'none';
    importCSVButton.textContent = 'Import from CSV';
    importCSVButton.addEventListener('click', () => {
      importCSVFileSelect.click();
    });
    importCSVForm.appendChild(importCSVFileSelect);
    importCSVFileSelect.addEventListener('change', () => {
      this.importCSV(importCSVFileSelect.files);
      importCSVForm.reset();
    });
    const csvContainer = document.createElement('span');
    csvContainer.append(exportToCSVButton, importCSVButton, importCSVForm);
    this.groupAnnotations.appendFixedChild(csvContainer);
  }

  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>,
      public annotationLayer: Owned<AnnotationLayerState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-layer-view');
    this.annotationListContainer.classList.add('neuroglancer-annotation-list');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(annotationLayer);
    const {source} = annotationLayer;
    const updateView = () => {
      this.updated = false;
      this.updateView();
    };
    this.registerDisposer(
        source.childAdded.add((annotation) => this.addAnnotationElement(annotation)));
    this.registerDisposer(
        source.childrenAdded.add((annotations) => this.addAnnotationElements(annotations)));
    this.registerDisposer(
        source.childUpdated.add((annotation) => this.updateAnnotationElement(annotation)));
    this.registerDisposer(
        source.childDeleted.add((annotationId) => this.deleteAnnotationElement(annotationId)));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.registerDisposer(annotationLayer.transform.changed.add(updateView));
    this.updateView();

    this.toolbox = document.createElement('div');
    const {toolbox} = this;
    toolbox.className = 'neuroglancer-annotation-toolbox';

    layer.initializeAnnotationLayerViewTab(this);

    // Visualization Group
    this.addOpacitySlider();
    this.bracketShortcutCheckbox();
    this.filterAnnotationByTagControl();
    // Annotations Group
    this.addColorPicker();
    this.annotationToolboxSetup();
    this.csvToolboxSetup();

    this.groupAnnotations.appendFixedChild(toolbox);
    this.groupAnnotations.appendFlexibleChild(this.annotationListContainer);
    this.element.appendChild(this.groupVisualization.element);
    this.element.appendChild(this.groupAnnotations.element);

    this.annotationListContainer.addEventListener('mouseleave', () => {
      this.annotationLayer.hoverState.value = undefined;
    });
    this.registerDisposer(
        this.annotationLayer.hoverState.changed.add(() => this.updateHoverView()));
    this.registerDisposer(this.state.changed.add(() => this.updateSelectionView()));

    this.annotationListContainer.parentElement!.classList.add(
        'neuroglancer-annotation-hiding-list-parent');
    this.annotationListContainer.classList.add('neuroglancer-annotation-hiding-list-container');
    const scrollArea = document.createElement('div');
    scrollArea.classList.add('neuroglancer-annotation-hiding-list-scrollarea');
    this.annotationListContainer.appendChild(scrollArea);
    const scrollbar = document.createElement('div');
    scrollbar.classList.add('neuroglancer-annotation-hiding-list-scrollbar');
    const scrollbarFiller = document.createElement('div');
    scrollbar.appendChild(scrollbarFiller);
    this.annotationListContainer.appendChild(scrollbar);
    this.annotationHidingList =
        new HidingList(scrollArea, scrollbar, scrollbarFiller, this.groupAnnotations.element);
  }

  private handleMultiple() {
    const selectedValue = this.state.value;
    const {previousSelectedId} = this;
    if (!selectedValue || !selectedValue.multiple || !previousSelectedId) {
      return;
    }
    const element = this.annotationListElements.get(previousSelectedId);
    const multiple = Array.from(selectedValue.multiple);
    if (element !== undefined && multiple.length && multiple.includes(previousSelectedId)) {
      element.classList.add('neuroglancer-annotation-multiple');
    }
  }

  private clearSelectionClass() {
    const {previousSelectedId} = this;
    if (previousSelectedId !== undefined) {
      const element = this.annotationListElements.get(previousSelectedId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-selected');
      }
      this.previousSelectedId = undefined;
    }
  }

  private clearHoverClass() {
    const {previousHoverId} = this;
    if (previousHoverId !== undefined) {
      const element = this.annotationListElements.get(previousHoverId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-hover');
      }
      this.previousHoverId = undefined;
    }
  }

  getAnnotationElement(annotationId: string) {
    return this.annotationListElements.get(annotationId);
  }

  private updateSelectionView() {
    const selectedValue = this.state.value;
    let newSelectedId: string|undefined;
    let multiple: string[]|undefined;
    if (selectedValue !== undefined) {
      newSelectedId = selectedValue.id;
      multiple = selectedValue.multiple ? Array.from(selectedValue.multiple) : undefined;
    }
    const {previousSelectedId} = this;
    if (newSelectedId === previousSelectedId) {
      return;
    }
    this.handleMultiple();
    this.clearSelectionClass();

    if (newSelectedId !== undefined) {
      const element = this.annotationListElements.get(newSelectedId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-selected');
        if (multiple && multiple.length) {
          element.classList.add('neuroglancer-annotation-multiple');
        }

        // TODO: Why? This is a anti user ui pattern
        this.annotationHidingList.scrollTo(element);
      }
    }
    this.previousSelectedId = newSelectedId;
    if (!multiple) {
      const multiselected = Array.from(
          this.annotationListContainer.querySelectorAll('.neuroglancer-annotation-multiple'));
      multiselected.forEach(
          (e: HTMLElement) => e.classList.remove('neuroglancer-annotation-multiple'));
    }
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
    this.clearHoverClass();
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

    const {annotationLayer, annotationListElements} = this;
    const {source} = annotationLayer;
    this.annotationHidingList.removeAll();
    annotationListElements.clear();

    this.addAnnotationsHelper(source);
  }

  private arrangeAnnotationsToAdd() {
    // Sort this.annotationsToAdd into a tree, then flatten back into a list with the proper order
    // Based on https://stackoverflow.com/a/444303
    class TreeNode {
      element: HTMLElement;
      children: TreeNode[];

      constructor(element: HTMLElement) {
        this.element = element;
        this.children = [];
      }
    }

    const idNodes = new Map<string, TreeNode>();
    for (const element of this.annotationsToAdd) {
      idNodes.set(element.dataset.id!, new TreeNode(element));
    }

    for (const element of this.annotationsToAdd) {
      if (element.dataset.parent) {
        const parentNode = idNodes.get(element.dataset.parent)!;
        const elementNode = idNodes.get(element.dataset.id!)!;
        parentNode.children.push(elementNode);
      }
    }

    const orderedAnnotations: HTMLElement[] = [];

    const self = this;
    function addFlattenedElement(node: TreeNode, depth: number) {
      const element = node.element;
      self.setPadding(element, depth);
      orderedAnnotations.push(element);
      for (const child of node.children) {
        addFlattenedElement(child, depth + 1);
      }
    }

    for (const element of this.annotationsToAdd) {
      if (!element.dataset.parent) {
        addFlattenedElement(idNodes.get(element.dataset.id!)!, 0);
      }
    }
    this.annotationsToAdd = orderedAnnotations;
  }

  private setPadding(element: HTMLElement, depth: number) {
    element.style.paddingLeft = (depth + 0.5) + 'em';
  }

  private addAnnotationElement(annotation: Annotation) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    const element = this.makeAnnotationListElement(annotation);
    const parent = element.dataset.parent ?
        this.annotationListElements.get(element.dataset.parent) :
        undefined;
    this.annotationHidingList.insertElement(element, parent);
    this.resetOnUpdate();
  }

  private addAnnotationsHelper(annotations: Iterable<Annotation>) {
    this.annotationsToAdd = [];
    for (const annotation of annotations) {
      this.annotationsToAdd.push(this.makeAnnotationListElement(annotation, false));
    }
    this.arrangeAnnotationsToAdd();
    this.annotationHidingList.addElements(this.annotationsToAdd);
    this.resetOnUpdate();
  }

  private addAnnotationElements(annotations: Annotation[]) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    this.addAnnotationsHelper(annotations);
  }

  private updateAnnotationElement(annotation: Annotation, checkVisibility = true) {
    if (checkVisibility && !this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }

    const {annotationListElements} = this;
    const element = annotationListElements.get(annotation.id);
    if (!element) {
      return;
    }
    const {annotationHidingList} = this;
    const newElement = this.makeAnnotationListElement(annotation);
    annotationHidingList.replaceElement(newElement, element);
    annotationListElements.set(annotation.id, newElement);
    this.resetOnUpdate();
  }

  private deleteAnnotationElement(annotationId: string) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    let element = this.annotationListElements.get(annotationId);
    if (element) {
      this.annotationHidingList.removeElement(element);
      this.annotationListElements.delete(annotationId);
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

  private makeAnnotationListElement(annotation: Annotation, doPadding: boolean = true) {
    const transform = this.annotationLayer.objectToGlobal;
    const element = document.createElement('li');
    element.dataset.id = annotation.id;
    element.title = 'Click to select, right click to recenter view.';
    let isInProgress = (<AnnotationSource>this.annotationLayer.source).isPending(annotation.id);
    element.classList.toggle('neuroglancer-annotation-inprogress', isInProgress);

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-icon';
    icon.textContent = getAnnotationTypeHandler(annotation.type).icon;
    element.appendChild(icon);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-position';
    getPositionSummary(position, annotation, transform, this.voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);
    if (annotation.parentId) {
      element.dataset.parent = annotation.parentId;
    }
    this.createAnnotationDescriptionElement(element, annotation);

    if ((<Collection>annotation).entries) {
      element.title = 'Click to select, right click to toggle children.';
    }

    this.annotationListElements.set(annotation.id, element);

    let depth = 0;
    let parent = undefined;
    let checkElement: HTMLElement = element;
    while (checkElement && checkElement.dataset.parent) {
      const parentId = checkElement.dataset.parent;
      parent = this.annotationListElements.get(parentId);
      checkElement = parent!;
      const checkCollection = <Collection>this.annotationLayer.source.getReference(parentId).value;
      if (checkCollection.entries && !checkCollection.childrenVisible.value) {
        element.classList.add('neuroglancer-annotation-child-hidden');
        this.setChildrenVisibleHelper(element.dataset.id, false);
      }
      depth++;
    }
    if (doPadding) {
      this.setPadding(element, depth);
    }

    const collection = <Collection>annotation;
    if (collection.entries && !collection.childrenVisible.value) {
      this.setChildrenVisibleHelper(element.dataset.id, false);
    }

    element.addEventListener('mouseenter', () => {
      this.annotationLayer.hoverState.value = {id: annotation.id, partIndex: 0};
    });

    element.addEventListener('click', (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey) {
        let multiple = new Set<string>();
        if (this.state.value) {
          if (this.state.value.multiple) {
            multiple = this.state.value.multiple;
          } else if (this.state.value.ungroupable) {
            // Cannot select line segment for group
          } else {
            multiple.add(this.state.value.id);
          }
        }
        multiple.add(annotation.id);
        this.state.value = {id: annotation.id, partIndex: 0, multiple};
      } else {
        this.state.value = {id: annotation.id, partIndex: 0};
      }
      event.stopPropagation();
    });

    element.addEventListener('mouseup', (event: MouseEvent) => {
      const collection = <Collection>annotation;
      if (event.button === 2) {
        if (collection.entries) {
          collection.childrenVisible.value = !collection.childrenVisible.value;
          this.setChildrenVisible(element.dataset.id!, collection.childrenVisible.value);
        } else {
          this.setSpatialCoordinates(
              getCenterPosition(collection, this.annotationLayer.objectToGlobal));
        }
        event.stopPropagation();
      }
    });

    return element;
  }

  private setChildrenVisible(elementId: string, visible: boolean) {
    this.setChildrenVisibleHelper(elementId, visible);
    this.annotationHidingList.recalculateHeights();
    this.annotationLayer.source.changed.dispatch();
  }

  private setChildrenVisibleHelper(elementId: string, visible: boolean) {
    const collection = <Collection>this.annotationLayer.source.getReference(elementId).value;
    if (!collection.entries) {
      return;
    }
    for (const childId of collection.entries) {
      const child = this.annotationListElements.get(childId);
      if (!child) {
        continue;
      }  // child not defined yet
      if (visible) {
        child.classList.remove('neuroglancer-annotation-child-hidden');
        const annotation = this.annotationLayer.source.getReference(childId).value;
        const collection = <Collection>annotation;
        // expand the children if they had been shown before collapsing this
        if (collection.entries && collection.childrenVisible.value) {
          this.setChildrenVisibleHelper(childId, true);
        }
      } else {
        child.classList.add('neuroglancer-annotation-child-hidden');
        this.setChildrenVisibleHelper(childId, false);
      }
    }
  }

  private createAnnotationDescriptionElement(
      annotationElement: HTMLElement, annotation: Annotation) {
    const annotationText = this.layer.getAnnotationText(annotation);
    if (annotationText) {
      const description = document.createElement('div');
      description.className = 'neuroglancer-annotation-description';
      description.textContent = annotationText;
      annotationElement.appendChild(description);
    }
  }

  private filterAnnotationsByTag(tagId: number) {
    for (const [annotationId, annotationElement] of this.annotationListElements) {
      if (tagId === 0 ||
          this.annotationLayer.source.isAnnotationTaggedWithTag(annotationId, tagId)) {
        annotationElement.classList.remove('neuroglancer-annotation-hiding-list-tagged-hidden');
      } else {
        annotationElement.classList.add('neuroglancer-annotation-hiding-list-tagged-hidden');
      }
    }
    this.annotationHidingList.recalculateHeights();
  }

  private exportToCSV() {
    const filename = `${this.layer.name}.csv`;
    const pointToCoordinateText = (point: vec3, transform: mat4) => {
      const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
      return formatIntegerPoint(this.voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
    };
    const columnHeaders = [
      'Coordinate 1', 'Coordinate 2', 'Ellipsoid Dimensions', 'Tags', 'Description', 'Segment IDs',
      'Parent ID', 'Type', 'ID'
    ];
    const csvData: string[][] = [];
    for (const annotation of this.annotationLayer.source) {
      const annotationRow = [];
      let coordinate1String = '';
      let coordinate2String = '';
      let ellipsoidDimensions = '';
      let stringType = '';
      let collectionID = '';
      switch (annotation.type) {
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
        case AnnotationType.LINE:
          stringType = annotation.type === AnnotationType.LINE ? 'Line' : 'AABB';
          coordinate1String =
              pointToCoordinateText(annotation.pointA, this.annotationLayer.objectToGlobal);
          coordinate2String =
              pointToCoordinateText(annotation.pointB, this.annotationLayer.objectToGlobal);
          break;
        case AnnotationType.POINT:
          stringType = 'Point';
          coordinate1String =
              pointToCoordinateText(annotation.point, this.annotationLayer.objectToGlobal);
          break;
        case AnnotationType.ELLIPSOID:
          stringType = 'Ellipsoid';
          coordinate1String =
              pointToCoordinateText(annotation.center, this.annotationLayer.objectToGlobal);
          const transformedRadii = transformVectorByMat4(
              tempVec3, annotation.radii, this.annotationLayer.objectToGlobal);
          this.voxelSize.voxelFromSpatial(transformedRadii, transformedRadii);
          ellipsoidDimensions = formatIntegerBounds(transformedRadii);
          break;
        case AnnotationType.SPOKE:
        case AnnotationType.LINE_STRIP:
        case AnnotationType.COLLECTION:
          switch (annotation.type) {
            case AnnotationType.SPOKE:
              stringType = (<Spoke>annotation).wheeled ? 'Spoke*' : 'Spoke';
              break;
            case AnnotationType.LINE_STRIP:
              stringType = (<LineStrip>annotation).looped ? 'Line Strip*' : 'Line Strip';
              break;
            default:
              stringType = 'Collection';
          }
          coordinate1String =
              pointToCoordinateText(annotation.source, this.annotationLayer.objectToGlobal);
          collectionID = annotation.id;
          break;
      }
      annotationRow.push(coordinate1String);
      annotationRow.push(coordinate2String);
      annotationRow.push(ellipsoidDimensions);
      // Tags
      if (this.annotationLayer.source instanceof AnnotationSource && annotation.tagIds) {
        // Papa.unparse expects an array of arrays even though here we only want to create a csv
        // for one row of tags
        const annotationTags: string[][] = [[]];
        annotation.tagIds.forEach(tagId => {
          const tag = (<AnnotationSource>this.annotationLayer.source).getTag(tagId);
          if (tag) {
            annotationTags[0].push(tag.label);
          }
        });
        if (annotationTags[0].length > 0) {
          annotationRow.push(Papa.unparse(annotationTags));
        } else {
          annotationRow.push('');
        }
      } else {
        annotationRow.push('');
      }
      // Description
      if (annotation.description) {
        annotationRow.push(annotation.description);
      } else {
        annotationRow.push('');
      }
      // Segment IDs
      if (annotation.segments) {
        // Papa.unparse expects an array of arrays even though here we only want to create a csv
        // for one row of segments
        const annotationSegments: string[][] = [[]];
        annotation.segments.forEach(segmentID => {
          annotationSegments[0].push(segmentID.toString());
        });
        if (annotationSegments[0].length > 0) {
          annotationRow.push(Papa.unparse(annotationSegments));
        } else {
          annotationRow.push('');
        }
      } else {
        annotationRow.push('');
      }
      // Parent ID
      annotationRow.push(annotation.parentId || '');
      // Type
      annotationRow.push(stringType);
      // ID
      annotationRow.push(collectionID);

      csvData.push(annotationRow);
    }
    const csvString = Papa.unparse({'fields': columnHeaders, 'data': csvData});
    const blob = new Blob([csvString], {type: 'text/csv;charset=utf-8;'});
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // TODO: pull request to papa repo
  private betterPapa = (inputFile: File|Blob): Promise<any> => {
    return new Promise((resolve) => {
      Papa.parse(inputFile, {
        complete: (results: any) => {
          resolve(results);
        }
      });
    });
  }

  private stringToVec3 = (input: string): vec3 => {
    // format: (x, y, z)
    let raw = input.split('');
    raw.shift();
    raw.pop();
    let list = raw.join('');
    let val = list.split(',').map(v => parseInt(v, 10));
    return vec3.fromValues(val[0], val[1], val[2]);
  }

  private dimensionsToVec3 = (input: string): vec3 => {
    // format: A × B × C
    let raw = input.replace(/s/g, '');
    let val = raw.split('×').map(v => parseInt(v, 10));
    return vec3.fromValues(val[0], val[1], val[2]);
  }

  private async importCSV(files: FileList|null) {
    const rawAnnotations = <Annotation[]>[];
    let successfulImport = 0;

    if (!files) {
      return;
    }

    for (const file of files) {
      const rawData = await this.betterPapa(file);
      rawData.data = rawData.data.filter((v: any) => v.join('').length);
      if (!rawData.data.length) {
        continue;
      }
      const annStrings = rawData.data;
      const csvIdToRealAnnotationIdMap: {[key: string]: string} = {};
      const childStorage: {[key: string]: string[]} = {};
      const textToPoint = (point: string, transform: mat4, dimension?: boolean) => {
        const parsedVec = dimension ? this.dimensionsToVec3(point) : this.stringToVec3(point);
        const spatialPoint = this.voxelSize.spatialFromVoxel(tempVec3, parsedVec);
        return vec3.transformMat4(vec3.create(), spatialPoint, transform);
      };
      let row = -1;
      for (const annProps of annStrings) {
        row++;
        const type = annProps[7];
        const parentId = annProps[6];
        const annotationID: string|undefined = annProps[8];
        const tags = annProps[3];
        let raw = <Annotation>{id: makeAnnotationId(), description: annProps[4]};

        switch (type) {
          case 'AABB':
          case 'Line':
            raw.type =
                type === 'Line' ? AnnotationType.LINE : AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;
            (<Line>raw).pointA = textToPoint(annProps[0], this.annotationLayer.globalToObject);
            (<Line>raw).pointB = textToPoint(annProps[1], this.annotationLayer.globalToObject);
            break;
          case 'Point':
            raw.type = AnnotationType.POINT;
            (<Point>raw).point = textToPoint(annProps[0], this.annotationLayer.globalToObject);
            break;
          case 'Ellipsoid':
            raw.type = AnnotationType.ELLIPSOID;
            (<Ellipsoid>raw).center = textToPoint(annProps[0], this.annotationLayer.globalToObject);
            (<Ellipsoid>raw).radii = textToPoint(annProps[2], this.annotationLayer.globalToObject, true);
            break;
          case 'Line Strip':
          case 'Line Strip*':
          case 'Spoke':
          case 'Spoke*':
          case 'Collection':
            if (type === 'Line Strip' || type === 'Line Strip*') {
              raw.type = AnnotationType.LINE_STRIP;
              (<LineStrip>raw).connected = true;
              (<LineStrip>raw).looped = type === 'Line Strip*';
            } else if (type === 'Spoke' || type === 'Spoke*') {
              raw.type = AnnotationType.SPOKE;
              (<Spoke>raw).connected = true;
              (<Spoke>raw).wheeled = type === 'Spoke*';
            } else {
              raw.type = AnnotationType.COLLECTION;
              (<Collection>raw).connected = false;
            }
            (<Collection>raw).childrenVisible = new TrackableBoolean(false, true);
            (<Collection>raw).source =
                textToPoint(annProps[0], this.annotationLayer.globalToObject);
            (<Collection>raw).entry = (index: number) =>
                (<LocalAnnotationSource>this.annotationLayer.source)
                    .get((<Collection>raw).entries[index]);
            break;
          default:
            // Do not add annotation row, if it has unexpected type
            console.error(
                `No annotation of type ${type}. Cannot parse ${file.name}:${row} ${annProps}`);
            continue;
        }

        if (annotationID) {
          if (csvIdToRealAnnotationIdMap[annotationID]) {
            raw.id = csvIdToRealAnnotationIdMap[annotationID];
            (<Collection>raw).entries = childStorage[raw.id];
          } else {
            csvIdToRealAnnotationIdMap[annotationID] = raw.id;
            (<Collection>raw).entries = [];
            childStorage[raw.id] = (<Collection>raw).entries;
          }
        }

        if (parentId) {
          if (csvIdToRealAnnotationIdMap[parentId]) {
            raw.parentId = csvIdToRealAnnotationIdMap[parentId];
            childStorage[raw.parentId].push(raw.id);
          } else {
            raw.parentId = makeAnnotationId();
            csvIdToRealAnnotationIdMap[parentId] = raw.parentId;
            if (childStorage[raw.parentId]) {
              childStorage[raw.parentId].push(raw.id);
            } else {
              childStorage[raw.parentId] = [raw.id];
            }
          }
        }

        if (tags) {
          raw.tagIds = new Set();
          const labels = tags.split(',');
          const alayer = (<AnnotationSource>this.annotationLayer.source);
          const currentTags = Array.from(alayer.getTags());
          labels.forEach((label: string) => {
            const tagId = (currentTags.find(tag => tag.label === label) || <any>{}).id ||
                alayer.addTag(label);
            raw.tagIds!.add(tagId);
          });
        }
        // Segments not supported

        rawAnnotations.push(raw);
      }
      successfulImport++;
    }

    this.annotationLayer.source.addAll(rawAnnotations, true);
    // TODO: Undoable
    StatusMessage.showTemporaryMessage(`Imported ${successfulImport} csv(s).`, 3000);
  }
}

export class AnnotationDetailsTab extends Tab {
  private valid = false;
  private mouseEntered = false;
  private hoverState: WatchableValue<{id: string, partIndex?: number}|undefined>|undefined;
  private segmentListWidget: AnnotationSegmentListWidget|undefined;
  constructor(
      public state: Owned<SelectedAnnotationState>, public voxelSize: VoxelSize,
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

  private getAnnotationStateInfo() {
    const value = this.state.value!;
    const info = <any>{};
    const annotationLayer = this.state.annotationLayerState.value;
    if (annotationLayer) {
      info.isInProgress = annotationLayer.source.isPending(value.id);
      const annotation = annotationLayer.source.getReference(value.id).value!;
      const parent = annotation.parentId ?
          <Collection>annotationLayer.source.getReference(annotation.parentId).value :
          undefined;
      if (parent) {
        info.isLineSegment = parent.type === AnnotationType.LINE_STRIP;
        info.isSpoke = parent.type === AnnotationType.SPOKE;
        info.isChild = true;
        info.isSingleton = (parent.entries.length === 1);
      }
      if (!info.isLineSegment && !info.isInProgress) {
        info.groupSize = value.multiple ? value.multiple.size : 0;
      }
    }

    return info;
  }

  private createAnnotationDetailsTitleElement(annotation: Annotation, info: any) {
    const {isLineSegment, isInProgress} = info;
    const handler = getAnnotationTypeHandler(annotation.type);
    const title = document.createElement('div');
    title.className = 'neuroglancer-annotation-details-title';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-details-icon';
    icon.textContent = handler.icon;

    const titleText = document.createElement('div');
    titleText.className = 'neuroglancer-annotation-details-title-text';
    titleText.textContent = `${handler.description} ${isLineSegment ? '(segment)' : ''} ${
        isInProgress ? '(in progress)' : ''}`;
    // FIXME: Currently Spokes are mutable collections, since order doesn't matter even though
    // they are connected
    if (info.groupSize) {
      titleText.textContent = `${info.groupSize} annotations selected`;
      icon.textContent = '~';
    }
    title.appendChild(icon);
    title.appendChild(titleText);

    return title;
  }

  private evictButton(annotation: Annotation, isSingleton?: boolean) {
    const annotationLayer = this.state.annotationLayerState.value!;
    const button = makeTextIconButton('✂️', 'Extract from collection');
    button.addEventListener('click', () => {
      const parentReference = annotationLayer.source.getReference(annotation.parentId!);
      if (isSingleton) {
        try {
          annotationLayer.source.delete(parentReference);
        } finally {
          parentReference.dispose();
        }
      } else {
        (<AnnotationSource>annotationLayer.source).childReassignment([annotation.id]);
      }
      this.state.value = undefined;
    });
    return button;
  }

  private groupButton() {
    const annotationLayer = this.state.annotationLayerState.value!;
    const value = this.state.value!;
    const button = makeTextIconButton('⚄', 'Create collection');
    button.addEventListener('click', () => {
      // Create a new collection with annotations in value.multiple
      let target: string[];
      if (value.multiple) {
        target = Array.from(value.multiple);
      } else {
        target = [value.id];
      }
      const first = annotationLayer.source.getReference(target[0]).value!;
      let sourcePoint;
      switch (first.type) {
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
        case AnnotationType.LINE:
          sourcePoint = (<Line|AxisAlignedBoundingBox>first).pointA;
          break;
        case AnnotationType.POINT:
          sourcePoint = (<Point>first).point;
          break;
        case AnnotationType.ELLIPSOID:
          sourcePoint = (<Ellipsoid>first).center;
          break;
        case AnnotationType.LINE_STRIP:
        case AnnotationType.SPOKE:
        case AnnotationType.COLLECTION:
          sourcePoint = (<LineStrip>first).source;
          break;
      }

      const collection = <Collection>{
        id: '',
        type: AnnotationType.COLLECTION,
        description: '',
        entries: [],  // identical to target
        segments: [],
        connected: false,
        source: sourcePoint,
        entry: () => {},
        segmentSet: () => {},
        childrenVisible: new TrackableBoolean(true, true)
      };
      collection.entry = (index: number) =>
          (<LocalAnnotationSource>annotationLayer.source).get(collection.entries[index]);
      collection.segmentSet = () => {
        collection.segments = [];
        collection.entries.forEach((ref, index) => {
          ref;
          const child = <Annotation>collection.entry(index);
          if (collection.segments && child.segments) {
            collection.segments = [...collection.segments!, ...child.segments];
          }
        });
        if (collection.segments) {
          collection.segments = [...new Set(collection.segments.map((e) => e.toString()))].map(
              (s) => Uint64.parseString(s));
        }
      };

      const collectionReference = (<AnnotationSource>annotationLayer.source).add(collection, true);
      if (first.parentId) {
        const firstParent = (<AnnotationSource>annotationLayer.source).getReference(first.parentId);
        (<AnnotationSource>annotationLayer.source)
            .childReassignment([collectionReference.value!.id], firstParent);
      }
      const emptyCollection =
          (<AnnotationSource>annotationLayer.source).childReassignment(target, collectionReference);

      // It shouldn't be possible for a collection to be empty twice, that is the child says the
      // parent is empty and then a subsequent child says the same
      emptyCollection.forEach((annotationReference: AnnotationReference) => {
        try {
          // Delete annotation and all its children
          annotationLayer.source.delete(annotationReference);
        } finally {
          annotationReference.dispose();
        }
      });
      this.state.value = {id: collectionReference.id};
    });
    return button;
  }

  private ungroupButton() {
    const annotationLayer = this.state.annotationLayerState.value!;
    const value = this.state.value!;
    const button = makeTextIconButton('💥', 'Extract all annotations');
    button.addEventListener('click', () => {
      const reference = annotationLayer.source.getReference(value.id);
      try {
        annotationLayer.source.delete(reference);
      } finally {
        reference.dispose();
      }
    });
    return button;
  }

  private deleteButton() {
    const annotationLayer = this.state.annotationLayerState.value!;
    const value = this.state.value!;
    const button = makeTextIconButton('🗑', 'Delete annotation');
    button.addEventListener('click', () => {
      let target: string[];
      if (value.multiple) {
        target = Array.from(value.multiple);
      } else {
        target = [value.id];
      }
      target.forEach((id: string) => {
        const reference = annotationLayer.source.getReference(id);
        try {
          // Delete annotation and all its children
          annotationLayer.source.delete(reference, true);
        } finally {
          reference.dispose();
        }
      });
    });
    return button;
  }

  private closeButton() {
    const button = makeCloseButton();
    button.title = 'Hide annotation details';
    button.addEventListener('click', () => {
      this.state.value = undefined;
    });
    return button;
  }

  private annotationDetailsAABB() {
    const {voxelSize} = this;
    const annotationLayer = this.state.annotationLayerState.value!;
    const {objectToGlobal} = annotationLayer;
    const annotation = <AxisAlignedBoundingBox>this.state.reference!.value;
    const detailSet = <HTMLDivElement[]>[];
    const volume = document.createElement('div');
    volume.className = 'neuroglancer-annotation-details-volume';
    volume.textContent =
        formatBoundingBoxVolume(annotation.pointA, annotation.pointB, objectToGlobal);
    detailSet.push(volume);

    // FIXME: only do this if it is axis aligned
    const spatialOffset = transformVectorByMat4(
        tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB), objectToGlobal);
    const voxelVolume = document.createElement('div');
    voxelVolume.className = 'neuroglancer-annotation-details-volume-in-voxels';
    const voxelOffset = voxelSize.voxelFromSpatial(tempVec3, spatialOffset);
    voxelVolume.textContent = `${formatIntegerBounds(voxelOffset)}`;
    detailSet.push(voxelVolume);

    return detailSet;
  }

  private annotationDetailsLine() {
    const {voxelSize} = this;
    const annotationLayer = this.state.annotationLayerState.value!;
    const {objectToGlobal} = annotationLayer;
    const annotation = <Line>this.state.reference!.value;
    const spatialOffset = transformVectorByMat4(
        tempVec3, vec3.subtract(tempVec3, annotation.pointA, annotation.pointB), objectToGlobal);
    const length = document.createElement('div');
    length.className = 'neuroglancer-annotation-details-length';
    const spatialLengthText = formatLength(vec3.length(spatialOffset));
    let voxelLengthText = '';
    if (voxelSize.valid) {
      const voxelLength = vec3.length(voxelSize.voxelFromSpatial(tempVec3, spatialOffset));
      voxelLengthText = `, ${Math.round(voxelLength)} vx`;
    }
    length.textContent = spatialLengthText + voxelLengthText;
    return length;
  }

  private annotationDetailsDescription() {
    const reference = <AnnotationReference>this.state.reference;
    const annotation = <Annotation>reference.value;
    const annotationLayer = <AnnotationLayerState>this.state.annotationLayerState.value;
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
    return description;
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

    const info = this.getAnnotationStateInfo();
    const title = this.createAnnotationDetailsTitleElement(annotation, info);
    const {isLineSegment, isChild, isSingleton, isInProgress} = info;

    if (isLineSegment || isInProgress) {
      // not allowed to multi select line segments
      value.multiple = undefined;
      value.ungroupable = true;
    }

    const contextualButtons = <HTMLDivElement[]>[];
    if (!annotationLayer.source.readonly && !isLineSegment && !isInProgress) {
      const {COLLECTION, LINE_STRIP, SPOKE} = AnnotationType;
      const multiStepTypes = <(AnnotationType | undefined)[]>[COLLECTION, LINE_STRIP, SPOKE];

      if (isChild && !value.multiple) {
        contextualButtons.push(this.evictButton(annotation, isSingleton));
      }
      contextualButtons.push(this.groupButton());
      if (multiStepTypes.includes(annotation.type) && !value.multiple) {
        contextualButtons.push(this.ungroupButton());
      }
      contextualButtons.push(this.deleteButton());
    }
    contextualButtons.push(this.closeButton());
    title.append(...contextualButtons);
    element.appendChild(title);

    if (!value.multiple) {
      const position = document.createElement('div');
      position.className = 'neuroglancer-annotation-details-position';
      getPositionSummary(
          position, annotation, objectToGlobal, voxelSize, this.setSpatialCoordinates);
      element.appendChild(position);

      if (annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
        element.append(...this.annotationDetailsAABB());
      } else if (annotation.type === AnnotationType.LINE) {
        element.appendChild(this.annotationDetailsLine());
      }
    }

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

    if (!value.multiple) {
      element.appendChild(this.annotationDetailsDescription());
    }
  }
}

export class AnnotationTab extends Tab {
  private stack = this.registerDisposer(
      new StackView<AnnotationLayerState, AnnotationLayerView>(annotationLayerState => {
        return new AnnotationLayerView(
            this.layer, this.state.addRef(), annotationLayerState.addRef(), this.voxelSize.addRef(),
            this.setSpatialCoordinates);
      }, this.visibility));
  private detailsTab = this.registerDisposer(
      new AnnotationDetailsTab(this.state, this.voxelSize.addRef(), this.setSpatialCoordinates));
  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>, public voxelSize: Owned<VoxelSize>,
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
    const setAnnotationLayerView = () => {
      this.stack.selected = this.state.annotationLayerState.value;
    };
    this.registerDisposer(this.state.annotationLayerState.changed.add(setAnnotationLayerView));
    setAnnotationLayerView();
  }
}

export interface UserLayerWithAnnotations extends UserLayer {
  annotationLayerState: WatchableRefCounted<AnnotationLayerState>;
  selectedAnnotation: SelectedAnnotationState;
  annotationColor: TrackableRGB;
  annotationFillOpacity: TrackableAlphaValue;
  initializeAnnotationLayerViewTab(tab: AnnotationLayerView): void;
  getAnnotationText(annotation: Annotation): string;
}

export function getAnnotationRenderOptions(userLayer: UserLayerWithAnnotations) {
  return {color: userLayer.annotationColor, fillOpacity: userLayer.annotationFillOpacity};
}

const SELECTED_ANNOTATION_JSON_KEY = 'selectedAnnotation';
const ANNOTATION_COLOR_JSON_KEY = 'annotationColor';
const ANNOTATION_FILL_OPACITY_JSON_KEY = 'annotationFillOpacity';
export function UserLayerWithAnnotationsMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  abstract class C extends Base implements UserLayerWithAnnotations {
    annotationLayerState = this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());
    selectedAnnotation =
        this.registerDisposer(new SelectedAnnotationState(this.annotationLayerState.addRef()));
    annotationColor = new TrackableRGB(vec3.fromValues(1, 1, 0));
    annotationFillOpacity = trackableAlphaValue(0.0);
    constructor(...args: any[]) {
      super(...args);
      this.selectedAnnotation.changed.add(this.specificationChanged.dispatch);
      this.annotationColor.changed.add(this.specificationChanged.dispatch);
      this.annotationFillOpacity.changed.add(this.specificationChanged.dispatch);
      this.tabs.add('annotations', {
        label: 'Annotations',
        order: 10,
        getter: () => new AnnotationTab(
            this, this.selectedAnnotation.addRef(), this.manager.voxelSize.addRef(),
            point => this.manager.setSpatialCoordinates(point))
      });
      this.annotationLayerState.changed.add(() => {
        const state = this.annotationLayerState.value;
        if (state !== undefined) {
          const annotationLayer = new AnnotationLayer(this.manager.chunkManager, state.addRef());
          setAnnotationHoverStateFromMouseState(state, this.manager.layerSelectedValues.mouseState);
          this.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
          this.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
          if (annotationLayer.source instanceof MultiscaleAnnotationSource) {
            const dataFetchLayer = this.registerDisposer(
                new DataFetchSliceViewRenderLayer(annotationLayer.source.addRef()));
            this.registerDisposer(registerNested(state.filterBySegmentation, (context, value) => {
              if (!value) {
                this.addRenderLayer(dataFetchLayer.addRef());
                context.registerDisposer(() => this.removeRenderLayer(dataFetchLayer));
              }
            }));
          }
        }
      });
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      this.selectedAnnotation.restoreState(specification[SELECTED_ANNOTATION_JSON_KEY]);
      this.annotationColor.restoreState(specification[ANNOTATION_COLOR_JSON_KEY]);
      this.annotationFillOpacity.restoreState(specification[ANNOTATION_FILL_OPACITY_JSON_KEY]);
    }

    toJSON() {
      const x = super.toJSON();
      x[SELECTED_ANNOTATION_JSON_KEY] = this.selectedAnnotation.toJSON();
      x[ANNOTATION_COLOR_JSON_KEY] = this.annotationColor.toJSON();
      x[ANNOTATION_FILL_OPACITY_JSON_KEY] = this.annotationFillOpacity.toJSON();
      return x;
    }

    initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
      tab;
    }

    getAnnotationText(annotation: Annotation) {
      return annotation.description || '';
    }
  }
  return C;
}
