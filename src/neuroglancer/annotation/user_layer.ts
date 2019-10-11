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

import './user_layer.css';

import {AnnotationType, LocalAnnotationSource} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {CoordinateTransformSpecification, makeCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {DataSourceSpecification, localAnnotationsUrl, LocalDataSource} from 'neuroglancer/datasource';
import {LayerReference, ManagedUserLayer, registerLayerType, registerLayerTypeDetector, UserLayer} from 'neuroglancer/layer';
import {LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {getWatchableRenderLayerTransform} from 'neuroglancer/render_coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/renderlayer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {ElementVisibilityFromTrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeDerivedWatchableValue} from 'neuroglancer/trackable_value';
import {AnnotationLayerView, UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {Borrowed} from 'neuroglancer/util/disposable';
import {parseArray, parseFixedLengthArray, verify3dVec, verifyFinitePositiveFloat, verifyOptionalObjectProperty} from 'neuroglancer/util/json';
import {LayerReferenceWidget} from 'neuroglancer/widget/layer_reference';

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

const LINKED_SEGMENTATION_LAYER_JSON_KEY = 'linkedSegmentationLayer';
const FILTER_BY_SEGMENTATION_JSON_KEY = 'filterBySegmentation';
const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class AnnotationUserLayer extends Base {
  localAnnotations: LocalAnnotationSource|undefined;
  private localAnnotationsJson: any = undefined;
  private pointAnnotationsJson: any = undefined;
  linkedSegmentationLayer = this.registerDisposer(
      new LayerReference(this.manager.rootLayers.addRef(), isValidLinkedSegmentationLayer));

  disposed() {
    const {localAnnotations} = this;
    if (localAnnotations !== undefined) {
      localAnnotations.dispose();
    }
    super.disposed();
  }

  constructor(managedLayer: Borrowed<ManagedUserLayer>, specification: any) {
    super(managedLayer, specification);
    this.linkedSegmentationLayer.restoreState(specification[LINKED_SEGMENTATION_LAYER_JSON_KEY]);
    this.annotationDisplayState.filterBySegmentation.restoreState(
        specification[FILTER_BY_SEGMENTATION_JSON_KEY]);
    this.registerDisposer(this.annotationDisplayState.filterBySegmentation.changed.add(
        this.specificationChanged.dispatch));
    this.localAnnotationsJson = specification[ANNOTATIONS_JSON_KEY];
    this.pointAnnotationsJson = specification[POINTS_JSON_KEY];

    const segmentationState = this.annotationDisplayState.segmentationState;
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

    // if (sourceUrl === undefined) {
    //   this.voxelSize.restoreState(specification[VOXEL_SIZE_JSON_KEY]);
    //   this.localAnnotations.restoreState(specification[ANNOTATIONS_JSON_KEY]);
    //   // Handle legacy "points" property.
    //   addPointAnnotations(this.localAnnotations, specification[POINTS_JSON_KEY]);
    //   let voxelSizeValid = false;
    //   const handleVoxelSizeChanged = () => {
    //     if (!this.voxelSize.valid && manager.voxelSize.valid) {
    //       this.voxelSize.size.set(manager.voxelSize.size);
    //       this.voxelSize.setValid();
    //     }
    //     if (this.voxelSize.valid && voxelSizeValid === false) {
    //       const derivedTransform = new WatchableCoordinateTransform(3);
    //       this.registerDisposer(
    //           makeDerivedCoordinateTransform(derivedTransform, this.transform, (output, input)
    //           => {
    //             const voxelScalingMatrix =
    //                 mat4.fromScaling(mat4.create(), this.voxelSize.size as vec3);
    //             mat4.multiply(output as mat4, input as mat4, voxelScalingMatrix);
    //           }));
    //       this.annotationLayerState.value = new AnnotationLayerState({
    //         transform: derivedTransform,
    //         source: this.localAnnotations.addRef(),
    //         ...this.getAnnotationRenderOptions()
    //       });
    //       voxelSizeValid = true;
    //     }
    //   };
    //   this.registerDisposer(this.localAnnotations.changed.add(this.specificationChanged.dispatch));
    //   this.registerDisposer(this.voxelSize.changed.add(this.specificationChanged.dispatch));
    //   this.registerDisposer(this.voxelSize.changed.add(handleVoxelSizeChanged));
    //   this.registerDisposer(this.manager.voxelSize.changed.add(handleVoxelSizeChanged));
    //   handleVoxelSizeChanged();
    // } else {
    //   StatusMessage
    //       .forPromise(
    //           this.manager.dataSourceProviderRegistry.getAnnotationSource(
    //               this.manager.chunkManager, sourceUrl),
    //           {
    //             initialMessage: `Retrieving metadata for volume ${sourceUrl}.`,
    //             delay: true,
    //             errorPrefix: `Error retrieving metadata for volume ${sourceUrl}: `,
    //           })
    //       .then(source => {
    //         if (this.wasDisposed) {
    //           return;
    //         }
    //         this.annotationLayerState.value = new AnnotationLayerState(
    //             {transform: this.transform, source, ...this.getAnnotationRenderOptions()});
    //       });
    // }
    this.tabs.default = 'annotations';
  }

  getLegacyDataSourceSpecifications(
      sourceSpec: any, layerSpec: any,
      legacyTransform: CoordinateTransformSpecification|undefined): DataSourceSpecification[] {
    if (Object.prototype.hasOwnProperty.call(layerSpec, 'source')) {
      return super.getLegacyDataSourceSpecifications(sourceSpec, layerSpec, legacyTransform);
    }
    const scales = verifyOptionalObjectProperty(
        layerSpec, 'voxelSize',
        voxelSizeObj => parseFixedLengthArray(
            new Float64Array(3), voxelSizeObj, x => verifyFinitePositiveFloat(x) / 1e9));
    const units = ['m', 'm', 'm'];
    if (scales !== undefined) {
      const inputSpace = makeCoordinateSpace({rank: 3, units, scales, names: ['x', 'y', 'z']});
      if (legacyTransform === undefined) {
        legacyTransform = {
          outputSpace: inputSpace,
          sourceRank: 3,
          transform: undefined,
          inputSpace,
        };
      } else {
        legacyTransform = {
          ...legacyTransform,
          inputSpace,
        };
      }
    }
    return [{
      url: localAnnotationsUrl,
      transform: legacyTransform,
      enableDefaultSubsources: true,
      subsources: new Map(),
    }];
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    let hasLocalAnnotations = false;
    for (const loadedSubsource of subsources) {
      if (this.addStaticAnnotations(loadedSubsource)) continue;
      const {subsourceEntry} = loadedSubsource;
      const {local} = subsourceEntry.subsource;
      if (local === LocalDataSource.annotations) {
        if (hasLocalAnnotations) {
          loadedSubsource.deactivate('Only one local annotations source per layer is supported');
          continue;
        }
        hasLocalAnnotations = true;
        loadedSubsource.activate(refCounted => {
          const localAnnotations = this.localAnnotations =
              new LocalAnnotationSource(loadedSubsource.loadedDataSource.transform);
          try {
            localAnnotations.restoreState(this.localAnnotationsJson);
          } catch {
          }
          refCounted.registerDisposer(() => {
            localAnnotations.dispose();
            this.localAnnotations = undefined;
          });
          refCounted.registerDisposer(
              this.localAnnotations.changed.add(this.specificationChanged.dispatch));
          try {
            addPointAnnotations(this.localAnnotations, this.pointAnnotationsJson);
          } catch {
          }
          this.pointAnnotationsJson = undefined;
          this.localAnnotationsJson = undefined;

          const state = new AnnotationLayerState({
            localPosition: this.localPosition,
            transform: refCounted.registerDisposer(getWatchableRenderLayerTransform(
                this.manager.root.coordinateSpace, this.localPosition.coordinateSpace,
                loadedSubsource.loadedDataSource.transform, undefined)),
            source: localAnnotations.addRef(),
            displayState: this.annotationDisplayState,
            dataSource: loadedSubsource.loadedDataSource.layerDataSource,
            subsourceIndex: loadedSubsource.subsourceIndex,
            subsourceId: subsourceEntry.id,
            role: RenderLayerRole.ANNOTATION,
          });
          this.addAnnotationLayerState(state, loadedSubsource);
        });
        continue;
      }
      const {annotation} = subsourceEntry.subsource;
      if (annotation !== undefined) {
        loadedSubsource.activate(() => {
          const state = new AnnotationLayerState({
            localPosition: this.localPosition,
            transform: loadedSubsource.getRenderLayerTransform(),
            source: annotation,
            displayState: this.annotationDisplayState,
            dataSource: loadedSubsource.loadedDataSource.layerDataSource,
            subsourceIndex: loadedSubsource.subsourceIndex,
            subsourceId: subsourceEntry.id,
            role: RenderLayerRole.ANNOTATION,
          });
          this.addAnnotationLayerState(state, loadedSubsource);
        });
        continue;
      }
      loadedSubsource.deactivate('Not compatible with annotation layer');
    }
  }

  initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
    const widget = tab.registerDisposer(new LayerReferenceWidget(this.linkedSegmentationLayer));
    widget.element.insertBefore(
        document.createTextNode('Linked segmentation: '), widget.element.firstChild);
    tab.element.appendChild(widget.element);

    {
      const checkboxWidget = this.registerDisposer(
          new TrackableBooleanCheckbox(tab.displayState.filterBySegmentation));
      const label = document.createElement('label');
      label.textContent = 'Filter by segmentation: ';
      label.appendChild(checkboxWidget.element);
      tab.element.appendChild(label);
      tab.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.registerDisposer(
              makeDerivedWatchableValue(v => v !== undefined, tab.displayState.segmentationState)),
          label));
    }
  }

  toJSON() {
    const x = super.toJSON();
    if (this.localAnnotations !== undefined) {
      x[ANNOTATIONS_JSON_KEY] = this.localAnnotations.toJSON();
    } else if (this.localAnnotationsJson !== undefined) {
      x[ANNOTATIONS_JSON_KEY] = this.localAnnotationsJson;
    }
    x[LINKED_SEGMENTATION_LAYER_JSON_KEY] = this.linkedSegmentationLayer.toJSON();
    x[FILTER_BY_SEGMENTATION_JSON_KEY] = this.annotationDisplayState.filterBySegmentation.toJSON();
    return x;
  }

  static type = 'annotation';
}

registerLayerType('annotation', AnnotationUserLayer);
registerLayerType('pointAnnotation', AnnotationUserLayer);
registerLayerTypeDetector(subsource => {
  if (subsource.local === LocalDataSource.annotations) return AnnotationUserLayer;
  if (subsource.annotation !== undefined) return AnnotationUserLayer;
  return undefined;
});
