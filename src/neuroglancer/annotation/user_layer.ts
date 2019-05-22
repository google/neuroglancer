/**
 * @license
 * Copyright 2016 Google Inc.
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

import {Annotation, AnnotationId, AnnotationType, LocalAnnotationSource} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {CoordinateTransform, makeDerivedCoordinateTransform} from 'neuroglancer/coordinate_transform';
import {LayerReference, ManagedUserLayer, UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType} from 'neuroglancer/layer_specification';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {StatusMessage} from 'neuroglancer/status';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeDerivedWatchableValue, WatchableValue} from 'neuroglancer/trackable_value';
import {AnnotationLayerView, getAnnotationRenderOptions, UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {UserLayerWithCoordinateTransformMixin} from 'neuroglancer/user_layer_with_coordinate_transform';
import {Borrowed, RefCounted, registerEventListener} from 'neuroglancer/util/disposable';
import {EventActionMap, registerActionListener} from 'neuroglancer/util/event_action_map';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseArray, verify3dVec} from 'neuroglancer/util/json';
import {KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {LayerReferenceWidget} from 'neuroglancer/widget/layer_reference';
import {Tab} from 'neuroglancer/widget/tab_view';

require('./user_layer.css');

const POINTS_JSON_KEY = 'points';
const ANNOTATIONS_JSON_KEY = 'annotations';
const ANNOTATION_TAGS_JSON_KEY = 'annotationTags';

function addPointAnnotations(annotations: LocalAnnotationSource, obj: any) {
  if (obj === undefined) {
    return;
  }
  parseArray(obj, (x, i) => {
    annotations.add({
      type: AnnotationType.POINT,
      id: '' + i,
      point: verify3dVec(x),
    });
  });
}

function isValidLinkedSegmentationLayer(layer: ManagedUserLayer) {
  const userLayer = layer.layer;
  if (userLayer === null) {
    return true;
  }
  if (userLayer instanceof SegmentationUserLayer) {
    return true;
  }
  return false;
}

function getSegmentationDisplayState(layer: ManagedUserLayer|undefined): SegmentationDisplayState|
    undefined {
  if (layer === undefined) {
    return undefined;
  }
  const userLayer = layer.layer;
  if (userLayer === null) {
    return undefined;
  }
  if (!(userLayer instanceof SegmentationUserLayer)) {
    return undefined;
  }
  return userLayer.displayState;
}

function getPointFromAnnotation(annotation: Annotation) {
  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      return annotation.pointA;
    case AnnotationType.POINT:
      return annotation.point;
    case AnnotationType.ELLIPSOID:
      return annotation.center;
  }
}

const VOXEL_SIZE_JSON_KEY = 'voxelSize';
const SOURCE_JSON_KEY = 'source';
const LINKED_SEGMENTATION_LAYER_JSON_KEY = 'linkedSegmentationLayer';
const FILTER_BY_SEGMENTATION_JSON_KEY = 'filterBySegmentation';
const Base = UserLayerWithAnnotationsMixin(UserLayerWithCoordinateTransformMixin(UserLayer));
export class AnnotationUserLayer extends Base {
  localAnnotations = this.registerDisposer(new LocalAnnotationSource());
  voxelSize = new VoxelSize();
  sourceUrl: string|undefined;
  linkedSegmentationLayer = this.registerDisposer(
      new LayerReference(this.manager.rootLayers.addRef(), isValidLinkedSegmentationLayer));
  filterBySegmentation = new TrackableBoolean(false);
  shortcutHandler = this.registerDisposer(new AnnotationShortcutHandler());
  private keyShortcutModifier = 'shift+';
  private keyShortcuts = ['q', 'w', 'e', 'r', 't', 'a', 's', 'd', 'f', 'g', 'z', 'x', 'c', 'v'];
  private tagToShortcut: Map<number, string> = new Map<number, string>();
  private _numTagsAllowed = this.keyShortcuts.length;

  getAnnotationRenderOptions() {
    const segmentationState =
        new WatchableValue<SegmentationDisplayState|undefined|null>(undefined);
    const setSegmentationState = () => {
      const {linkedSegmentationLayer} = this;
      if (linkedSegmentationLayer.layerName === undefined) {
        segmentationState.value = null;
      } else {
        const {layer} = linkedSegmentationLayer;
        segmentationState.value = getSegmentationDisplayState(layer);
      }
    };
    this.registerDisposer(this.linkedSegmentationLayer.changed.add(setSegmentationState));
    setSegmentationState();
    return {
      segmentationState,
      filterBySegmentation: this.filterBySegmentation,
      ...getAnnotationRenderOptions(this)
    };
  }

  constructor(manager: LayerListSpecification, specification: any) {
    super(manager, specification);
    const sourceUrl = this.sourceUrl = specification[SOURCE_JSON_KEY];
    this.linkedSegmentationLayer.restoreState(specification[LINKED_SEGMENTATION_LAYER_JSON_KEY]);
    this.filterBySegmentation.restoreState(specification[FILTER_BY_SEGMENTATION_JSON_KEY]);
    if (sourceUrl === undefined) {
      this.isReady = true;
      this.voxelSize.restoreState(specification[VOXEL_SIZE_JSON_KEY]);
      this.localAnnotations.restoreState(
          specification[ANNOTATIONS_JSON_KEY], specification[ANNOTATION_TAGS_JSON_KEY]);
      // Handle legacy "points" property.
      addPointAnnotations(this.localAnnotations, specification[POINTS_JSON_KEY]);
      let voxelSizeValid = false;
      const handleVoxelSizeChanged = () => {
        if (!this.voxelSize.valid && manager.voxelSize.valid) {
          vec3.copy(this.voxelSize.size, manager.voxelSize.size);
          this.voxelSize.setValid();
        }
        if (this.voxelSize.valid && voxelSizeValid === false) {
          const derivedTransform = new CoordinateTransform();
          this.registerDisposer(
              makeDerivedCoordinateTransform(derivedTransform, this.transform, (output, input) => {
                const voxelScalingMatrix = mat4.fromScaling(mat4.create(), this.voxelSize.size);
                mat4.multiply(output, input, voxelScalingMatrix);
              }));
          this.annotationLayerState.value = new AnnotationLayerState({
            transform: derivedTransform,
            source: this.localAnnotations.addRef(),
            ...this.getAnnotationRenderOptions()
          });
          voxelSizeValid = true;
        }
      };
      this.registerDisposer(this.localAnnotations.changed.add(this.specificationChanged.dispatch));
      this.registerDisposer(this.voxelSize.changed.add(this.specificationChanged.dispatch));
      this.registerDisposer(
          this.filterBySegmentation.changed.add(this.specificationChanged.dispatch));
      this.registerDisposer(this.voxelSize.changed.add(handleVoxelSizeChanged));
      this.registerDisposer(this.manager.voxelSize.changed.add(handleVoxelSizeChanged));
      handleVoxelSizeChanged();
      if (!this.localAnnotations.readonly) {
        this.tabs.add(
            'annotation-shortcuts',
            {label: 'Shortcuts', order: 1000, getter: () => new AnnotationShortcutsTab(this)});
        this.setupAnnotationShortcuts();
        for (const tagId of this.localAnnotations.getTagIds()) {
          this.addAnnotationTagShortcut(tagId);
        }
      }
    } else {
      StatusMessage
          .forPromise(
              this.manager.dataSourceProvider.getAnnotationSource(
                  this.manager.chunkManager, sourceUrl),
              {
                initialMessage: `Retrieving metadata for volume ${sourceUrl}.`,
                delay: true,
                errorPrefix: `Error retrieving metadata for volume ${sourceUrl}: `,
              })
          .then(source => {
            if (this.wasDisposed) {
              return;
            }
            this.annotationLayerState.value = new AnnotationLayerState(
                {transform: this.transform, source, ...this.getAnnotationRenderOptions()});
            this.isReady = true;
          });
    }
    this.tabs.default = 'annotations';
  }

  initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
    const widget = tab.registerDisposer(new LayerReferenceWidget(this.linkedSegmentationLayer));
    widget.element.insertBefore(
        document.createTextNode('Linked segmentation: '), widget.element.firstChild);
    tab.element.appendChild(widget.element);

    {
      const checkboxWidget = this.registerDisposer(
          new TrackableBooleanCheckbox(tab.annotationLayer.filterBySegmentation));
      const label = document.createElement('label');
      label.textContent = 'Filter by segmentation: ';
      label.appendChild(checkboxWidget.element);
      tab.element.appendChild(label);
      tab.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.registerDisposer(makeDerivedWatchableValue(
              v => v !== undefined, tab.annotationLayer.segmentationState)),
          label));
    }
  }

  toJSON() {
    const x = super.toJSON();
    x['type'] = 'annotation';
    x[SOURCE_JSON_KEY] = this.sourceUrl;
    if (this.sourceUrl === undefined) {
      const localAnnotationsJSONObj = this.localAnnotations.toJSON();
      x[ANNOTATIONS_JSON_KEY] = localAnnotationsJSONObj.annotations;
      x[ANNOTATION_TAGS_JSON_KEY] = localAnnotationsJSONObj.tags;
      x[VOXEL_SIZE_JSON_KEY] = this.voxelSize.toJSON();
    }
    x[LINKED_SEGMENTATION_LAYER_JSON_KEY] = this.linkedSegmentationLayer.toJSON();
    x[FILTER_BY_SEGMENTATION_JSON_KEY] = this.filterBySegmentation.toJSON();
    return x;
  }

  getPrevAnnotation(annotationId: AnnotationId) {
    return this.localAnnotations.getPrevAnnotation(annotationId);
  }

  getNextAnnotation(annotationId: AnnotationId) {
    return this.localAnnotations.getNextAnnotation(annotationId);
  }

  enableAnnotationShortcuts() {
    this.shortcutHandler.enable();
  }

  disableAnnotationShortcuts() {
    this.shortcutHandler.disable();
  }

  setupAnnotationShortcuts() {
    const element = document.getElementById('neuroglancerViewer');
    if (element) {
      this.shortcutHandler.setup(this.getDefaultShortcutActions());
    } else {
      throw new Error('Viewer element does not exist');
    }
  }

  private getDefaultShortcutActions() {
    let lastAnnotation: Annotation|undefined;
    const jumpToAnnotation = (annotation: Annotation|undefined, movingForward: boolean) => {
      if (annotation && this.annotationLayerState.value) {
        const selectedTagId = this.annotationLayerState.value.selectedAnnotationTagId.value;
        if (selectedTagId === 0 || (annotation.tagIds && annotation.tagIds.has(selectedTagId))) {
          this.selectedAnnotation.value = {id: annotation.id, partIndex: 0};
          const point = getPointFromAnnotation(annotation);
          const spatialPoint = vec3.create();
          vec3.transformMat4(spatialPoint, point, this.annotationLayerState.value.objectToGlobal);
          this.manager.setSpatialCoordinates(spatialPoint);
          if (this.linkedSegmentationLayer &&
              this.annotationLayerState.value.segmentationState.value &&
              this.annotationLayerState.value.annotationJumpingDisplaysSegmentation.value) {
            const rootSegs = this.annotationLayerState.value.segmentationState.value.rootSegments;
            if (lastAnnotation && lastAnnotation.segments) {
              lastAnnotation.segments.forEach(segment => {
                if (rootSegs.has(segment)) {
                  rootSegs.delete(segment);
                }
              });
            }
            if (annotation.segments) {
              annotation.segments.forEach(segment => {
                if (!rootSegs.has(segment)) {
                  rootSegs.add(segment);
                }
              });
            }
            lastAnnotation = annotation;
          }
        } else {
          if (movingForward) {
            jumpToAnnotation(this.getNextAnnotation(annotation.id), true);
          } else {
            jumpToAnnotation(this.getPrevAnnotation(annotation.id), false);
          }
        }
      }
    };
    return [
      {
        keyCode: 'bracketright',
        actionName: 'go-to-next-annotation',
        actionFunction: () => {
          if (this.selectedAnnotation.value) {
            jumpToAnnotation(this.getNextAnnotation(this.selectedAnnotation.value.id), true);
          }
        }
      },
      {
        keyCode: 'bracketleft',
        actionName: 'go-to-prev-annotation',
        actionFunction: () => {
          if (this.selectedAnnotation.value) {
            jumpToAnnotation(this.getPrevAnnotation(this.selectedAnnotation.value.id), false);
          }
        }
      }
    ];
  }

  getAnnotationText(annotation: Annotation) {
    let text = super.getAnnotationText(annotation);
    if (annotation.tagIds) {
      annotation.tagIds.forEach(tagId => {
        const tag = this.localAnnotations.getTag(tagId);
        if (tag) {
          text += ' #' + tag.label;
        }
      });
    }
    return text;
  }

  addAnnotationTagShortcut(tagId: number) {
    const {localAnnotations, selectedAnnotation, shortcutHandler: shortcutHandlerViewer} = this;
    const shortcutKey = this.keyShortcuts.splice(0, 1)[0];
    const shortcutCode = this.keyShortcutModifier + 'key' + shortcutKey;
    this.tagToShortcut.set(tagId, shortcutCode);
    const addAnnotationTagToAnnotation = () => {
      const reference = selectedAnnotation.reference;
      if (reference && reference.value) {
        localAnnotations.toggleAnnotationTag(reference, tagId);
      }
    };
    shortcutHandlerViewer.addShortcut(shortcutCode, addAnnotationTagToAnnotation);
  }

  addAnnotationTag() {
    if (this.keyShortcuts.length > 0) {
      const newTagId = this.localAnnotations.addTag('');
      this.addAnnotationTagShortcut(newTagId);
      return newTagId;
    }
    return;
  }

  get numTagsAllowed() {
    return this._numTagsAllowed;
  }

  getShortcutText(tagId: number) {
    const shortcutCode = this.tagToShortcut.get(tagId)!;
    return shortcutCode.charAt(0).toUpperCase() + shortcutCode.slice(1, -4) +
        shortcutCode.slice(-1);
  }

  deleteAnnotationTag(tagId: number) {
    const shortcutCode = this.tagToShortcut.get(tagId)!;
    this.shortcutHandler.removeShortcut(shortcutCode);
    this.keyShortcuts.push(shortcutCode);
    this.tagToShortcut.delete(tagId);
    this.localAnnotations.deleteTag(tagId);
  }
}

class AnnotationShortcutsTab extends Tab {
  constructor(public layer: Borrowed<AnnotationUserLayer>) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-annotation-shortcuts-tab');
    const addAnnotationTagDiv = document.createElement('div');
    const addShortcutButton = document.createElement('button');
    addShortcutButton.classList.add('neuroglancer-annotation-shortcut-button');
    addShortcutButton.textContent = '+';
    addShortcutButton.addEventListener('click', () => {
      const newTagId = this.layer.addAnnotationTag();
      if (newTagId === undefined) {
        alert(`Reached max number of shortcuts. Currently, only ${
            this.layer.numTagsAllowed} are supported.`);
      } else {
        this.addNewTagElement(newTagId);
      }
    });
    const addShortcutButtonLabel = document.createElement('span');
    addShortcutButtonLabel.classList.add('neuroglancer-annotation-shortcut-button-label');
    addShortcutButtonLabel.textContent = 'Add annotation shortcut: ';
    addAnnotationTagDiv.appendChild(addShortcutButtonLabel);
    addAnnotationTagDiv.appendChild(addShortcutButton);
    const shortcutListHeader = document.createElement('div');
    shortcutListHeader.classList.add('annotation-shorcut-list-header');
    const shortcutHeader = document.createElement('span');
    shortcutHeader.textContent = 'Key shortcut';
    shortcutHeader.classList.add('annotation-key-shortcut-header');
    const tagHeader = document.createElement('span');
    tagHeader.textContent = 'Tag input';
    shortcutListHeader.appendChild(shortcutHeader);
    shortcutListHeader.appendChild(tagHeader);
    element.appendChild(addAnnotationTagDiv);
    element.appendChild(shortcutListHeader);
    for (const tagId of this.layer.localAnnotations.getTagIds()) {
      this.addNewTagElement(tagId);
    }
  }

  private addNewTagElement(tagId: number) {
    const {layer} = this;
    const {localAnnotations} = layer;
    const newTagElement = document.createElement('div');
    newTagElement.classList.add('neuroglancer-annotation-shortcut');
    const shortcutTextbox = document.createElement('span');
    shortcutTextbox.className = 'display-annotation-shortcut-textbox';
    shortcutTextbox.textContent = this.layer.getShortcutText(tagId);
    const annotationTagName = document.createElement('input');
    annotationTagName.className = 'annotation-tag-input';
    const tag = localAnnotations.getTag(tagId);
    if (tag) {
      annotationTagName.value = tag.label;
    } else {
      throw new Error(`Tag ${tagId} does not exist`);
    }
    const tagChangeListenerDisposer = registerEventListener(annotationTagName, 'change', () => {
      const updateConfirmed =
          tag.label === '' ||
          confirm(
              `Are you sure you want to change the name of the tag? All associated annotations will be tagged with the new tag name.`);
      if (updateConfirmed) {
        localAnnotations.updateTagLabel(tagId, annotationTagName.value);
      } else {
        annotationTagName.value = tag.label;
      }
    });
    this.registerDisposer(tagChangeListenerDisposer);
    const deleteTag = document.createElement('button');
    deleteTag.className = 'delete-annotation-tag';
    deleteTag.textContent = 'x';
    deleteTag.addEventListener('click', () => {
      const deleteConfirmed = confirm(`Are you sure you want to delete #${
          tag.label}? This tag will be removed from all annotations associated with it`);
      if (deleteConfirmed) {
        newTagElement.remove();
        tagChangeListenerDisposer();
        this.unregisterDisposer(tagChangeListenerDisposer);
        layer.deleteAnnotationTag(tagId);
      }
    });
    newTagElement.appendChild(shortcutTextbox);
    newTagElement.appendChild(annotationTagName);
    newTagElement.appendChild(deleteTag);
    this.element.appendChild(newTagElement);
  }
}

class AnnotationShortcutHandler extends RefCounted {
  private shortcutEventBinder = this.registerDisposer(new KeyboardEventBinder<EventActionMap>(
      document.getElementById('neuroglancerViewer')!, new EventActionMap()));
  private shortcutEventActions =
      new Map<string, {actionName: string, actionFunction: () => void}>();
  private shortcutEventDisposers = new Map<string, () => void>();
  private enabled = false;

  private static getShortcutEventName(shortcutKeyCode: string) {
    return 'annotationShortcutEvent:' + shortcutKeyCode;
  }

  private disableShortcut(shortcutCode: string) {
    const actionRemover = this.shortcutEventDisposers.get(shortcutCode);
    this.shortcutEventBinder!.eventMap.delete(shortcutCode);
    if (actionRemover) {
      actionRemover();
      this.shortcutEventDisposers.delete(shortcutCode);
      this.unregisterDisposer(actionRemover);
    }
  }

  private enableShortcut(
      shortcutCode: string, shortcutEventName: string, shortcutAction: () => void) {
    this.shortcutEventBinder!.eventMap.set(shortcutCode, shortcutEventName);
    const actionRemover =
        registerActionListener(this.shortcutEventBinder!.target, shortcutEventName, shortcutAction);
    this.registerDisposer(actionRemover);
    this.shortcutEventDisposers.set(shortcutCode, actionRemover);
  }

  addShortcut(shortcutCode: string, shortcutAction: () => void) {
    const shortcutEventName = AnnotationShortcutHandler.getShortcutEventName(shortcutCode);
    if (this.enabled) {
      this.enableShortcut(shortcutCode, shortcutEventName, shortcutAction);
    }
    this.shortcutEventActions.set(
        shortcutCode, {actionName: shortcutEventName, actionFunction: shortcutAction});
  }

  removeShortcut(shortcutCode: string) {
    if (this.enabled) {
      this.disableShortcut(shortcutCode);
    }
    this.shortcutEventActions.delete(shortcutCode);
  }

  enable() {
    for (const [shortcutCode, {actionName, actionFunction}] of this.shortcutEventActions) {
      this.enableShortcut(shortcutCode, actionName, actionFunction);
    }
    this.enabled = true;
  }

  disable() {
    for (const shortcutCode of this.shortcutEventActions.keys()) {
      this.disableShortcut(shortcutCode);
    }
    this.enabled = false;
  }

  setup(initialActions: {keyCode: string, actionName: string, actionFunction: () => void}[]) {
    for (const action of initialActions) {
      this.shortcutEventActions.set(
          action.keyCode, {actionName: action.actionName, actionFunction: action.actionFunction});
    }
  }
}

registerLayerType('annotation', AnnotationUserLayer);
registerLayerType('pointAnnotation', AnnotationUserLayer);
