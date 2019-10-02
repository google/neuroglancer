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

import {AnnotationType, LocalAnnotationSource} from 'neuroglancer/annotation';
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
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseArray, verify3dVec} from 'neuroglancer/util/json';
import {LayerReferenceWidget} from 'neuroglancer/widget/layer_reference';

import './user_layer.css';

const POINTS_JSON_KEY = 'points';
const ANNOTATIONS_JSON_KEY = 'annotations';

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
      this.localAnnotations.restoreState(specification[ANNOTATIONS_JSON_KEY]);
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
      x[ANNOTATIONS_JSON_KEY] = this.localAnnotations.toJSON();
      x[VOXEL_SIZE_JSON_KEY] = this.voxelSize.toJSON();
    }
    x[LINKED_SEGMENTATION_LAYER_JSON_KEY] = this.linkedSegmentationLayer.toJSON();
    x[FILTER_BY_SEGMENTATION_JSON_KEY] = this.filterBySegmentation.toJSON();
    return x;
  }
}

registerLayerType('annotation', AnnotationUserLayer);
registerLayerType('pointAnnotation', AnnotationUserLayer);
