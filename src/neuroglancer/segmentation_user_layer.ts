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

import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer} from 'neuroglancer/mesh/frontend';
import {Overlay} from 'neuroglancer/overlay';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {Bounds} from 'neuroglancer/segmentation_display_state/base';
import {SegmentationDisplayState3D, SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {FRAGMENT_MAIN_START as SKELETON_FRAGMENT_MAIN_START, getTrackableFragmentMain, PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonLayerDisplayState, SkeletonSource, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {SegmentationRenderLayer, SliceViewSegmentationDisplayState} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {ComputedWatchableValue} from 'neuroglancer/trackable_value';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {Borrowed} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verify3dVec, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

require('neuroglancer/noselect.css');
require('./segmentation_user_layer.css');

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const SATURATION_JSON_KEY = 'saturation';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';


export class SegmentationUserLayer extends UserLayer {
  displayState: SliceViewSegmentationDisplayState&SegmentationDisplayState3D&
      SkeletonLayerDisplayState = {
        segmentColorHash: SegmentColorHash.getDefault(),
        segmentSelectionState: new SegmentSelectionState(),
        selectedAlpha: trackableAlphaValue(0.5),
        saturation: trackableAlphaValue(1.0),
        notSelectedAlpha: trackableAlphaValue(0),
        objectAlpha: trackableAlphaValue(1.0),
        clipBounds: SharedWatchableValue.make<Bounds|undefined>(this.manager.worker, undefined),
        hideSegmentZero: new TrackableBoolean(true, true),
        visibleSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
        highlightedSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
        segmentEquivalences: SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker),
        volumeSourceOptions: {},
        objectToDataTransform: new CoordinateTransform(),
        fragmentMain: getTrackableFragmentMain(),
        shaderError: makeWatchableShaderError(),
      };
  volumePath: string|undefined;

  /**
   * If meshPath is undefined, a default mesh source provided by the volume may be used.  If
   * meshPath is null, the default mesh source is not used.
   */
  meshPath: string|null|undefined;
  skeletonsPath: string|undefined;
  meshLayer: Borrowed<MeshLayer>|undefined;
  skeletonLayer: Borrowed<SkeletonLayer>|undefined;

  // Dispatched when either meshLayer or skeletonLayer changes.
  objectLayerStateChanged = new NullarySignal();

  constructor(public manager: LayerListSpecification, x: any) {
    super(manager, x);
    this.displayState.visibleSegments.changed.add(() => this.specificationChanged.dispatch());
    this.displayState.segmentEquivalences.changed.add(() => this.specificationChanged.dispatch());
    this.displayState.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.notSelectedAlpha.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.objectAlpha.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.hideSegmentZero.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.fragmentMain.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.highlightedSegments.changed.add(() => {
      this.specificationChanged.dispatch();
    });

    this.displayState.selectedAlpha.restoreState(x[SELECTED_ALPHA_JSON_KEY]);
    this.displayState.notSelectedAlpha.restoreState(x[NOT_SELECTED_ALPHA_JSON_KEY]);
    this.displayState.saturation.restoreState(x[SATURATION_JSON_KEY]);
    this.displayState.objectAlpha.restoreState(x[OBJECT_ALPHA_JSON_KEY]);
    this.displayState.hideSegmentZero.restoreState(x[HIDE_SEGMENT_ZERO_JSON_KEY]);
    this.displayState.objectToDataTransform.restoreState(x['transform']);
    this.displayState.fragmentMain.restoreState(x['skeletonShader']);

    let volumePath = this.volumePath = verifyOptionalString(x['source']);
    let meshPath = this.meshPath = x['mesh'] === null ? null : verifyOptionalString(x['mesh']);
    let skeletonsPath = this.skeletonsPath = verifyOptionalString(x['skeletons']);
    let remaining = 0;
    if (volumePath !== undefined) {
      ++remaining;
      getVolumeWithStatusMessage(manager.dataSourceProvider, manager.chunkManager, volumePath, {
        volumeType: VolumeType.SEGMENTATION
      }).then(volume => {
        if (!this.wasDisposed) {
          this.addRenderLayer(new SegmentationRenderLayer(volume, this.displayState));
          if (meshPath === undefined && skeletonsPath === undefined) {
            ++remaining;
            Promise.resolve(volume.getMeshSource()).then(objectSource => {
              if (this.wasDisposed) {
                if (objectSource !== null) {
                  objectSource.dispose();
                }
                return;
              }
              if (--remaining === 0) {
                this.isReady = true;
              }
              if (objectSource instanceof MeshSource) {
                this.addMesh(objectSource);
                this.objectLayerStateChanged.dispatch();
              } else if (objectSource instanceof SkeletonSource) {
                this.addSkeletonSource(objectSource);
                this.objectLayerStateChanged.dispatch();
              }
            });
          }
          if (--remaining === 0) {
            this.isReady = true;
          }
        }
      });
    }

    if (meshPath != null) {
      ++remaining;
      this.manager.dataSourceProvider.getMeshSource(manager.chunkManager, meshPath)
          .then(meshSource => {
            if (!this.wasDisposed) {
              this.addMesh(meshSource);
              if (--remaining === 0) {
                this.isReady = true;
              }
            }
          });
    }

    if (skeletonsPath !== undefined) {
      ++remaining;
      this.manager.dataSourceProvider.getSkeletonSource(manager.chunkManager, skeletonsPath)
          .then(skeletonSource => {
            if (!this.wasDisposed) {
              this.addSkeletonSource(skeletonSource);
              if (--remaining === 0) {
                this.isReady = true;
              }
            }
          });
    }

    verifyObjectProperty(x, 'equivalences', y => {
      this.displayState.segmentEquivalences.restoreState(y);
    });

    verifyObjectProperty(x, 'segments', y => {
      if (y !== undefined) {
        let {visibleSegments, segmentEquivalences} = this.displayState;
        parseArray(y, value => {
          let id = Uint64.parseString(String(value), 10);
          visibleSegments.add(segmentEquivalences.get(id));
        });
      }
    });

    verifyObjectProperty(x, 'highlights', y => {
      if (y !== undefined) {
        parseArray(y, value => {
          let id = Uint64.parseString(String(value), 10);
          this.displayState.highlightedSegments.add(id);
        });
      }
    });

    verifyObjectProperty(x, 'clipBounds', y => {
      if (y === undefined) {
        return;
      }
      let center: vec3|undefined, size: vec3|undefined;
      verifyObjectProperty(y, 'center', z => center = verify3dVec(z));
      verifyObjectProperty(y, 'size', z => size = verify3dVec(z));
      if (!center || !size) {
        return;
      }
      let bounds = {center, size};
      this.displayState.clipBounds.value = bounds;
    });
  }

  addMesh(meshSource: MeshSource) {
    this.meshLayer = new MeshLayer(this.manager.chunkManager, meshSource, this.displayState);
    this.addRenderLayer(this.meshLayer);
  }

  addSkeletonSource(skeletonSource: SkeletonSource) {
    let base = new SkeletonLayer(
        this.manager.chunkManager, skeletonSource, this.manager.voxelSize, this.displayState);
    this.skeletonLayer = base;
    this.addRenderLayer(new PerspectiveViewSkeletonLayer(base.addRef()));
    this.addRenderLayer(new SliceViewPanelSkeletonLayer(/* transfer ownership */ base));
  }

  toJSON() {
    let x: any = {'type': 'segmentation'};
    x['source'] = this.volumePath;
    x['mesh'] = this.meshPath;
    x['skeletons'] = this.skeletonsPath;
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.displayState.hideSegmentZero.toJSON();
    let {visibleSegments} = this.displayState;
    if (visibleSegments.size > 0) {
      x['segments'] = visibleSegments.toJSON();
    }
    let {highlightedSegments} = this.displayState;
    if (highlightedSegments.size > 0) {
      x['highlights'] = highlightedSegments.toJSON();
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size > 0) {
      x['equivalences'] = segmentEquivalences.toJSON();
    }
    let {clipBounds} = this.displayState;
    if (clipBounds.value) {
      x['clipBounds'] = {
        center: Array.from(clipBounds.value.center),
        size: Array.from(clipBounds.value.size),
      };
    }
    x['transform'] = this.displayState.objectToDataTransform.toJSON();
    x['skeletonShader'] = this.displayState.fragmentMain.toJSON();
    return x;
  }

  transformPickedValue(value: any) {
    if (value == null) {
      return value;
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size === 0) {
      return value;
    }
    if (typeof value === 'number') {
      value = new Uint64(value, 0);
    }
    let mappedValue = segmentEquivalences.get(value);
    if (Uint64.equal(mappedValue, value)) {
      return value;
    }
    return new Uint64MapEntry(value, mappedValue);
  }

  makeDropdown(element: HTMLDivElement) {
    return new SegmentationDropdown(element, this);
  }

  handleAction(action: string) {
    switch (action) {
      case 'recolor': {
        this.displayState.segmentColorHash.randomize();
        break;
      }
      case 'clear-segments': {
        this.displayState.visibleSegments.clear();
        break;
      }
      case 'select': {
        let {segmentSelectionState} = this.displayState;
        if (segmentSelectionState.hasSelectedSegment) {
          let segment = segmentSelectionState.selectedSegment;
          let {visibleSegments} = this.displayState;
          if (visibleSegments.has(segment)) {
            visibleSegments.delete(segment);
          } else {
            visibleSegments.add(segment);
          }
        }
        break;
      }
      case 'highlight': {
        let {segmentSelectionState} = this.displayState;
        if (segmentSelectionState.hasSelectedSegment) {
          let segment = segmentSelectionState.selectedSegment;
          let {highlightedSegments} = this.displayState;
          if (highlightedSegments.has(segment)) {
            highlightedSegments.delete(segment);
          } else {
            highlightedSegments.add(segment);
          }
        }
        break;
      }
    }
  }
}

function makeSkeletonShaderCodeWidget(layer: SegmentationUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.fragmentMain,
    shaderError: layer.displayState.shaderError,
    fragmentMainStartLine: SKELETON_FRAGMENT_MAIN_START,
  });
}

class SegmentationDropdown extends UserLayerDropdown {
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer.displayState));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  selectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.selectedAlpha));
  notSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.notSelectedAlpha));
  saturationWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.saturation));
  objectAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.objectAlpha));
  codeWidget: ShaderCodeWidget|undefined;

  constructor(public element: HTMLDivElement, public layer: SegmentationUserLayer) {
    super();
    element.classList.add('segmentation-dropdown');
    let {selectedAlphaWidget, notSelectedAlphaWidget, saturationWidget, objectAlphaWidget} = this;
    selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';
    saturationWidget.promptElement.textContent = 'Saturation';
    objectAlphaWidget.promptElement.textContent = 'Opacity (3d)';

    if (this.layer.volumePath !== undefined) {
      element.appendChild(this.selectedAlphaWidget.element);
      element.appendChild(this.notSelectedAlphaWidget.element);
      element.appendChild(this.saturationWidget.element);
    }
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.registerDisposer(new ComputedWatchableValue(
            () => this.layer.meshPath || this.layer.meshLayer || this.layer.skeletonsPath ||
                    this.layer.skeletonLayer ?
                true :
                false,
            this.layer.objectLayerStateChanged)),
        this.objectAlphaWidget.element));
    element.appendChild(this.objectAlphaWidget.element);

    {
      const checkbox =
          this.registerDisposer(new TrackableBooleanCheckbox(layer.displayState.hideSegmentZero));
      checkbox.element.className =
          'neuroglancer-segmentation-dropdown-hide-segment-zero neuroglancer-noselect';
      const label = document.createElement('label');
      label.className =
          'neuroglancer-segmentation-dropdown-hide-segment-zero neuroglancer-noselect';
      label.appendChild(document.createTextNode('Hide segment ID 0'));
      label.appendChild(checkbox.element);
      element.appendChild(label);
    }

    this.addSegmentWidget.element.classList.add('add-segment');
    this.addSegmentWidget.element.title = 'Add one or more segment IDs';
    element.appendChild(this.registerDisposer(this.addSegmentWidget).element);
    this.registerDisposer(this.addSegmentWidget.valuesEntered.add((values: Uint64[]) => {
      for (const value of values) {
        this.layer.displayState.visibleSegments.add(value);
      }
    }));
    element.appendChild(this.registerDisposer(this.visibleSegmentWidget).element);
    const maybeAddSkeletonShaderUI = () => {
      if (this.codeWidget !== undefined) {
        return;
      }
      if (this.layer.skeletonsPath === null || this.layer.skeletonLayer === undefined) {
        return;
      }
      let topRow = document.createElement('div');
      topRow.className = 'neuroglancer-segmentation-dropdown-skeleton-shader-header';
      let label = document.createElement('div');
      label.style.flex = '1';
      label.textContent = 'Skeleton shader:';
      let helpLink = document.createElement('a');
      let helpButton = document.createElement('button');
      helpButton.type = 'button';
      helpButton.textContent = '?';
      helpButton.className = 'help-link';
      helpLink.appendChild(helpButton);
      helpLink.title = 'Documentation on skeleton rendering';
      helpLink.target = '_blank';
      helpLink.href =
          'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md';

      let maximizeButton = document.createElement('button');
      maximizeButton.innerHTML = '&square;';
      maximizeButton.className = 'maximize-button';
      maximizeButton.title = 'Show larger editor view';
      this.registerEventListener(maximizeButton, 'click', () => {
        new ShaderCodeOverlay(this.layer);
      });

      topRow.appendChild(label);
      topRow.appendChild(maximizeButton);
      topRow.appendChild(helpLink);

      element.appendChild(topRow);

      const codeWidget = this.codeWidget =
          this.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
      element.appendChild(codeWidget.element);
      codeWidget.textEditor.refresh();
    };
    this.registerDisposer(this.layer.objectLayerStateChanged.add(maybeAddSkeletonShaderUI));
    maybeAddSkeletonShaderUI();
  }

  onShow() {
    if (this.codeWidget !== undefined) {
      this.codeWidget.textEditor.refresh();
    }
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
  constructor(public layer: SegmentationUserLayer) {
    super();
    this.content.classList.add('neuroglancer-segmentation-layer-skeleton-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType('segmentation', SegmentationUserLayer);
registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);
