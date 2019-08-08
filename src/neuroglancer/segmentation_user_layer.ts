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

import 'neuroglancer/noselect.css';
import 'neuroglancer/segmentation_user_layer.css';

import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer, MultiscaleMeshLayer} from 'neuroglancer/mesh/frontend';
import {Overlay} from 'neuroglancer/overlay';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {FRAGMENT_MAIN_START as SKELETON_FRAGMENT_MAIN_START, PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonRenderingOptions, SkeletonSource, SliceViewPanelSkeletonLayer, ViewSpecificSkeletonRenderingOptions} from 'neuroglancer/skeleton/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {ComputedWatchableValue} from 'neuroglancer/trackable_value';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {Uint64Map} from 'neuroglancer/uint64_map';
import {UserLayerWithVolumeSourceMixin} from 'neuroglancer/user_layer_with_volume_source';
import {parseRGBColorSpecification, packColor} from 'neuroglancer/util/color';
import {Borrowed} from 'neuroglancer/util/disposable';
import {parseArray, verifyObjectProperty, verifyOptionalString, verifyObjectAsMap} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {RangeWidget} from 'neuroglancer/widget/range';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {Tab} from 'neuroglancer/widget/tab_view';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const SATURATION_JSON_KEY = 'saturation';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';
const MESH_JSON_KEY = 'mesh';
const SKELETONS_JSON_KEY = 'skeletons';
const SEGMENTS_JSON_KEY = 'segments';
const HIGHLIGHTS_JSON_KEY = 'highlights';
const EQUIVALENCES_JSON_KEY = 'equivalences';
const COLOR_SEED_JSON_KEY = 'colorSeed';
const SEGMENT_STATED_COLORS_JSON_KEY = 'segmentColors';
const MESH_RENDER_SCALE_JSON_KEY = 'meshRenderScale';

const SKELETON_RENDERING_JSON_KEY = 'skeletonRendering';
const SKELETON_SHADER_JSON_KEY = 'skeletonShader';

const Base = UserLayerWithVolumeSourceMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  displayState = {
    segmentColorHash: SegmentColorHash.getDefault(),
    segmentStatedColors: Uint64Map.makeWithCounterpart(this.manager.worker),
    segmentSelectionState: new SegmentSelectionState(),
    selectedAlpha: trackableAlphaValue(0.5),
    saturation: trackableAlphaValue(1.0),
    notSelectedAlpha: trackableAlphaValue(0),
    objectAlpha: trackableAlphaValue(1.0),
    hideSegmentZero: new TrackableBoolean(true, true),
    visibleSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    highlightedSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    segmentEquivalences: SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker),
    objectToDataTransform: this.transform,
    skeletonRenderingOptions: new SkeletonRenderingOptions(),
    shaderError: makeWatchableShaderError(),
    renderScaleHistogram: new RenderScaleHistogram(),
    renderScaleTarget: trackableRenderScaleTarget(1),
  };

  /**
   * If meshPath is undefined, a default mesh source provided by the volume may be used.  If
   * meshPath is null, the default mesh source is not used.
   */
  meshPath: string|null|undefined;
  skeletonsPath: string|undefined;
  meshLayer: Borrowed<MeshLayer|MultiscaleMeshLayer>|undefined;
  skeletonLayer: Borrowed<SkeletonLayer>|undefined;

  // Dispatched when either meshLayer or skeletonLayer changes.
  objectLayerStateChanged = new NullarySignal();

  constructor(public manager: LayerListSpecification, x: any) {
    super(manager, x);
    this.displayState.visibleSegments.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentEquivalences.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.saturation.changed.add(this.specificationChanged.dispatch);
    this.displayState.notSelectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.objectAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.hideSegmentZero.changed.add(this.specificationChanged.dispatch);
    this.displayState.skeletonRenderingOptions.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentColorHash.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentStatedColors.changed.add(this.specificationChanged.dispatch);
    this.displayState.renderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.tabs.add(
        'rendering', {label: 'Rendering', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.default = 'rendering';
  }

  get volumeOptions() {
    return {volumeType: VolumeType.SEGMENTATION};
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.displayState.selectedAlpha.restoreState(specification[SELECTED_ALPHA_JSON_KEY]);
    this.displayState.saturation.restoreState(specification[SATURATION_JSON_KEY]);
    this.displayState.notSelectedAlpha.restoreState(specification[NOT_SELECTED_ALPHA_JSON_KEY]);
    this.displayState.objectAlpha.restoreState(specification[OBJECT_ALPHA_JSON_KEY]);
    this.displayState.hideSegmentZero.restoreState(specification[HIDE_SEGMENT_ZERO_JSON_KEY]);

    const {skeletonRenderingOptions} = this.displayState;
    skeletonRenderingOptions.restoreState(specification[SKELETON_RENDERING_JSON_KEY]);
    const skeletonShader = specification[SKELETON_SHADER_JSON_KEY];
    if (skeletonShader !== undefined) {
      skeletonRenderingOptions.shader.restoreState(skeletonShader);
    }
    this.displayState.segmentColorHash.restoreState(specification[COLOR_SEED_JSON_KEY]);
    this.displayState.renderScaleTarget.restoreState(specification[MESH_RENDER_SCALE_JSON_KEY]);

    verifyObjectProperty(specification, EQUIVALENCES_JSON_KEY, y => {
      this.displayState.segmentEquivalences.restoreState(y);
    });

    const restoreSegmentsList = (key: string, segments: Uint64Set) => {
      verifyObjectProperty(specification, key, y => {
        if (y !== undefined) {
          let {segmentEquivalences} = this.displayState;
          parseArray(y, value => {
            let id = Uint64.parseString(String(value), 10);
            segments.add(segmentEquivalences.get(id));
          });
        }
      });
    };

    restoreSegmentsList(SEGMENTS_JSON_KEY, this.displayState.visibleSegments);
    restoreSegmentsList(HIGHLIGHTS_JSON_KEY, this.displayState.highlightedSegments);

    this.displayState.highlightedSegments.changed.add(() => {
      this.specificationChanged.dispatch();
    });

    verifyObjectProperty(specification, SEGMENT_STATED_COLORS_JSON_KEY, y => {
      if (y !== undefined) {
        let {segmentEquivalences} = this.displayState;
        let result = verifyObjectAsMap(y, x => parseRGBColorSpecification(String(x)));
        for (let [idStr, colorVec] of result) {
          const id = Uint64.parseString(String(idStr));
          const color = new Uint64(packColor(colorVec));
          this.displayState.segmentStatedColors.set(segmentEquivalences.get(id), color);
        }
      }
    });

    const {multiscaleSource} = this;
    let meshPath = this.meshPath = specification[MESH_JSON_KEY] === null ?
        null :
        verifyOptionalString(specification[MESH_JSON_KEY]);
    let skeletonsPath = this.skeletonsPath =
        verifyObjectProperty(specification, SKELETONS_JSON_KEY, verifyOptionalString);

    let remaining = 0;
    if (meshPath != null) {
      ++remaining;
      this.manager.dataSourceProvider.getMeshSource(this.manager.chunkManager, meshPath)
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
      this.manager.dataSourceProvider.getSkeletonSource(this.manager.chunkManager, skeletonsPath)
          .then(skeletonSource => {
            if (!this.wasDisposed) {
              this.addSkeletonSource(skeletonSource);
              if (--remaining === 0) {
                this.isReady = true;
              }
            }
          });
    }

    if (multiscaleSource !== undefined) {
      ++remaining;
      multiscaleSource.then(volume => {
        if (!this.wasDisposed) {
          const {displayState} = this;
          this.addRenderLayer(new SegmentationRenderLayer(volume, {
            ...displayState,
            transform: displayState.objectToDataTransform,
            renderScaleHistogram: this.sliceViewRenderScaleHistogram,
            renderScaleTarget: this.sliceViewRenderScaleTarget,
          }));
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
              if ((objectSource instanceof MeshSource) ||
                  (objectSource instanceof MultiscaleMeshSource)) {
                this.addMesh(objectSource);
              } else if (objectSource instanceof SkeletonSource) {
                this.addSkeletonSource(objectSource);
              }
            });
          }
          if (--remaining === 0) {
            this.isReady = true;
          }
        }
      });
    }
  }

  addMesh(meshSource: MeshSource|MultiscaleMeshSource) {
    if (meshSource instanceof MeshSource) {
      this.meshLayer = new MeshLayer(this.manager.chunkManager, meshSource, this.displayState);
    } else {
      this.meshLayer =
          new MultiscaleMeshLayer(this.manager.chunkManager, meshSource, this.displayState);
    }
    this.addRenderLayer(this.meshLayer);
    this.objectLayerStateChanged.dispatch();
  }

  addSkeletonSource(skeletonSource: SkeletonSource) {
    let base = new SkeletonLayer(
        this.manager.chunkManager, skeletonSource, this.manager.voxelSize, this.displayState);
    this.skeletonLayer = base;
    this.addRenderLayer(new PerspectiveViewSkeletonLayer(base.addRef()));
    this.addRenderLayer(new SliceViewPanelSkeletonLayer(/* transfer ownership */ base));
    this.objectLayerStateChanged.dispatch();
  }

  toJSON() {
    const x = super.toJSON();
    x['type'] = 'segmentation';
    x[MESH_JSON_KEY] = this.meshPath;
    x[SKELETONS_JSON_KEY] = this.skeletonsPath;
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.displayState.hideSegmentZero.toJSON();
    x[COLOR_SEED_JSON_KEY] = this.displayState.segmentColorHash.toJSON();
    let {segmentStatedColors} = this.displayState;
    if (segmentStatedColors.size > 0) {
      let json = segmentStatedColors.toJSON();
      // Convert colors from decimal integers to CSS "#RRGGBB" format.
      Object.keys(json).map(k => json[k] = '#' + parseInt(json[k], 10).toString(16).padStart(6, '0'));
      x[SEGMENT_STATED_COLORS_JSON_KEY] = json;
    }
    let {visibleSegments} = this.displayState;
    if (visibleSegments.size > 0) {
      x[SEGMENTS_JSON_KEY] = visibleSegments.toJSON();
    }
    let {highlightedSegments} = this.displayState;
    if (highlightedSegments.size > 0) {
      x[HIGHLIGHTS_JSON_KEY] = highlightedSegments.toJSON();
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size > 0) {
      x[EQUIVALENCES_JSON_KEY] = segmentEquivalences.toJSON();
    }
    x[SKELETON_RENDERING_JSON_KEY] = this.displayState.skeletonRenderingOptions.toJSON();
    x[MESH_RENDER_SCALE_JSON_KEY] = this.displayState.renderScaleTarget.toJSON();
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
    fragmentMain: layer.displayState.skeletonRenderingOptions.shader,
    shaderError: layer.displayState.shaderError,
    fragmentMainStartLine: SKELETON_FRAGMENT_MAIN_START,
  });
}

class DisplayOptionsTab extends Tab {
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer.displayState));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  selectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.selectedAlpha));
  notSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.notSelectedAlpha));
  saturationWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.saturation));
  objectAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.objectAlpha));
  codeWidget: ShaderCodeWidget|undefined;
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
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

      {
        const renderScaleWidget = this.registerDisposer(new RenderScaleWidget(
            this.layer.sliceViewRenderScaleHistogram, this.layer.sliceViewRenderScaleTarget));
        renderScaleWidget.label.textContent = 'Resolution (slice)';
        element.appendChild(renderScaleWidget.element);
      }
    }
    const has3dLayer = this.registerDisposer(new ComputedWatchableValue(
        () => this.layer.meshPath || this.layer.meshLayer || this.layer.skeletonsPath ||
                this.layer.skeletonLayer ?
            true :
            false,
        this.layer.objectLayerStateChanged));
    this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(has3dLayer, this.objectAlphaWidget.element));

    {
      const renderScaleWidget = this.registerDisposer(new RenderScaleWidget(
          this.layer.displayState.renderScaleHistogram, this.layer.displayState.renderScaleTarget));
      renderScaleWidget.label.textContent = 'Resolution (mesh)';
      element.appendChild(renderScaleWidget.element);
      this.registerDisposer(
          new ElementVisibilityFromTrackableBoolean(has3dLayer, renderScaleWidget.element));
    }
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
      const addViewSpecificSkeletonRenderingControls =
          (options: ViewSpecificSkeletonRenderingOptions, viewName: string) => {
            {
              const widget = this.registerDisposer(new EnumSelectWidget(options.mode));
              const label = document.createElement('label');
              label.className =
                  'neuroglancer-segmentation-dropdown-skeleton-render-mode neuroglancer-noselect';
              label.appendChild(document.createTextNode(`Skeleton mode (${viewName})`));
              label.appendChild(widget.element);
              element.appendChild(label);
            }
            {
              const widget = this.registerDisposer(
                  new RangeWidget(options.lineWidth, {min: 1, max: 40, step: 1}));
              widget.promptElement.textContent = `Skeleton line width (${viewName})`;
              element.appendChild(widget.element);
            }
          };
      addViewSpecificSkeletonRenderingControls(
          layer.displayState.skeletonRenderingOptions.params2d, '2d');
      addViewSpecificSkeletonRenderingControls(
          layer.displayState.skeletonRenderingOptions.params3d, '3d');
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

    this.visibility.changed.add(() => {
      if (this.visible) {
        if (this.codeWidget !== undefined) {
          this.codeWidget.textEditor.refresh();
        }
      }
    });
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
