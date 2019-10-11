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

import {CoordinateTransformSpecification} from 'neuroglancer/coordinate_transform';
import {DataSourceSpecification} from 'neuroglancer/datasource';
import {ManagedUserLayer, registerLayerType, registerLayerTypeDetector, registerVolumeLayerType, UserLayer} from 'neuroglancer/layer';
import {layerDataSourceSpecificationFromJson, LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {MeshLayer, MeshSource, MultiscaleMeshLayer, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {Overlay} from 'neuroglancer/overlay';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonRenderingOptions, SliceViewPanelSkeletonLayer, ViewSpecificSkeletonRenderingOptions} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeCachedLazyDerivedWatchableValue} from 'neuroglancer/trackable_value';
import {UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {Uint64Map} from 'neuroglancer/uint64_map';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {packColor, parseRGBColorSpecification} from 'neuroglancer/util/color';
import {Borrowed} from 'neuroglancer/util/disposable';
import {parseArray, verifyObjectAsMap, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {makeHelpButton} from 'neuroglancer/widget/help_button';
import {makeMaximizeButton} from 'neuroglancer/widget/maximize_button';
import {RangeWidget} from 'neuroglancer/widget/range';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {ShaderControls} from 'neuroglancer/widget/shader_controls';
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
const CROSS_SECTION_RENDER_SCALE_JSON_KEY = 'crossSectionRenderScale';
const SKELETON_RENDERING_JSON_KEY = 'skeletonRendering';
const SKELETON_SHADER_JSON_KEY = 'skeletonShader';

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);

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
    skeletonRenderingOptions: new SkeletonRenderingOptions(),
    shaderError: makeWatchableShaderError(),
    renderScaleHistogram: new RenderScaleHistogram(),
    renderScaleTarget: trackableRenderScaleTarget(1),
  };

  constructor(managedLayer: Borrowed<ManagedUserLayer>, specification: any) {
    super(managedLayer, specification);
    this.displayState.visibleSegments.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentEquivalences.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentSelectionState.bindTo(this.manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.saturation.changed.add(this.specificationChanged.dispatch);
    this.displayState.notSelectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.objectAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.hideSegmentZero.changed.add(this.specificationChanged.dispatch);
    this.displayState.skeletonRenderingOptions.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentColorHash.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentStatedColors.changed.add(this.specificationChanged.dispatch);
    this.displayState.renderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.sliceViewRenderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.tabs.add(
        'rendering', {label: 'Rendering', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.default = 'rendering';
  }

  get volumeOptions() {
    return {volumeType: VolumeType.SEGMENTATION};
  }

  readonly has2dLayer = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
      layers => layers.some(x => x instanceof SegmentationRenderLayer),
      {changed: this.layersChanged, value: this.renderLayers}));

  readonly has3dLayer = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
      layers => layers.some(
          x =>
              (x instanceof MeshLayer || x instanceof MultiscaleMeshLayer ||
               x instanceof PerspectiveViewSkeletonLayer ||
               x instanceof SliceViewPanelSkeletonLayer)),
      {changed: this.layersChanged, value: this.renderLayers}));

  readonly hasSkeletonsLayer = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
      layers => layers.some(x => x instanceof PerspectiveViewSkeletonLayer),
      {changed: this.layersChanged, value: this.renderLayers}));

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    for (const loadedSubsource of subsources) {
      if (this.addStaticAnnotations(loadedSubsource)) continue;
      const {volume, mesh} = loadedSubsource.subsourceEntry.subsource;
      if (volume instanceof MultiscaleVolumeChunkSource) {
        switch (volume.dataType) {
          case DataType.FLOAT32:
            loadedSubsource.deactivate('Data type not compatible with segmentation layer');
            continue;
        }
        loadedSubsource.activate(
            () => loadedSubsource.addRenderLayer(new SegmentationRenderLayer(volume, {
              ...this.displayState,
              transform: loadedSubsource.getRenderLayerTransform(),
              renderScaleTarget: this.sliceViewRenderScaleTarget,
              renderScaleHistogram: this.sliceViewRenderScaleHistogram,
              localPosition: this.localPosition,
            })));
      } else if (mesh !== undefined) {
        loadedSubsource.activate(() => {
          const displayState = {
            ...this.displayState,
            transform: loadedSubsource.getRenderLayerTransform(),
          };
          if (mesh instanceof MeshSource) {
            loadedSubsource.addRenderLayer(
                new MeshLayer(this.manager.chunkManager, mesh, displayState));
          } else if (mesh instanceof MultiscaleMeshSource) {
            loadedSubsource.addRenderLayer(
                new MultiscaleMeshLayer(this.manager.chunkManager, mesh, displayState));
          } else {
            const base = new SkeletonLayer(this.manager.chunkManager, mesh, displayState);
            loadedSubsource.addRenderLayer(new PerspectiveViewSkeletonLayer(base.addRef()));
            loadedSubsource.addRenderLayer(
                new SliceViewPanelSkeletonLayer(/* transfer ownership */ base));
          }
        });
      } else {
        loadedSubsource.deactivate('Not compatible with segmentation layer');
      }
    }
  }

  getLegacyDataSourceSpecifications(
      sourceSpec: any, layerSpec: any,
      legacyTransform: CoordinateTransformSpecification|undefined): DataSourceSpecification[] {
    const specs = super.getLegacyDataSourceSpecifications(sourceSpec, layerSpec, legacyTransform);
    const meshPath = verifyOptionalObjectProperty(
        layerSpec, MESH_JSON_KEY, x => x === null ? null : verifyString(x));
    const skeletonsPath = verifyOptionalObjectProperty(
        layerSpec, SKELETONS_JSON_KEY, x => x === null ? null : verifyString(x));
    if (meshPath !== undefined || skeletonsPath !== undefined) {
      for (const spec of specs) {
        spec.enableDefaultSubsources = false;
        spec.subsources = new Map([
          ['default', {enabled: true}],
          ['bounds', {enabled: true}],
        ]);
      }
    }
    if (meshPath != null) {
      specs.push(layerDataSourceSpecificationFromJson(
          this.manager.dataSourceProviderRegistry.convertLegacyUrl({url: meshPath, type: 'mesh'})));
    }
    if (skeletonsPath != null) {
      specs.push(layerDataSourceSpecificationFromJson(
          this.manager.dataSourceProviderRegistry.convertLegacyUrl(
              {url: skeletonsPath, type: 'skeletons'})));
    }
    return specs;
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
    this.sliceViewRenderScaleTarget.restoreState(
        specification[CROSS_SECTION_RENDER_SCALE_JSON_KEY]);
  }

  toJSON() {
    const x = super.toJSON();
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
      Object.keys(json).map(
          k => json[k] = '#' + parseInt(json[k], 10).toString(16).padStart(6, '0'));
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
    x[CROSS_SECTION_RENDER_SCALE_JSON_KEY] = this.sliceViewRenderScaleTarget.toJSON();
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
  static type = 'segmentation';
}

function makeSkeletonShaderCodeWidget(layer: SegmentationUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.skeletonRenderingOptions.shader,
    shaderError: layer.displayState.shaderError,
    shaderControlState: layer.displayState.skeletonRenderingOptions.shaderControlState,
  });
}

class DisplayOptionsTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
    element.classList.add('segmentation-dropdown');

    {
      const saturationWidget =
          this.registerDisposer(new RangeWidget(this.layer.displayState.saturation));
      saturationWidget.promptElement.textContent = 'Saturation';
      element.appendChild(saturationWidget.element);
    }

    // 2-d only controls
    const controls2d = this.registerDisposer(
        new DependentViewWidget(layer.has2dLayer, (has2dLayer, parent, refCounted) => {
          if (!has2dLayer) return;
          const selectedAlphaWidget =
              refCounted.registerDisposer(new RangeWidget(this.layer.displayState.selectedAlpha));
          selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
          parent.appendChild(selectedAlphaWidget.element);
          const notSelectedAlphaWidget = refCounted.registerDisposer(
              new RangeWidget(this.layer.displayState.notSelectedAlpha));
          notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';
          parent.appendChild(notSelectedAlphaWidget.element);
          {
            const renderScaleWidget = refCounted.registerDisposer(new RenderScaleWidget(
                this.layer.sliceViewRenderScaleHistogram, this.layer.sliceViewRenderScaleTarget));
            renderScaleWidget.label.textContent = 'Resolution (slice)';
            parent.appendChild(renderScaleWidget.element);
          }
        }, this.visibility));
    element.appendChild(controls2d.element);

    const controls3d = this.registerDisposer(
        new DependentViewWidget(layer.has3dLayer, (has3dLayer, parent, refCounted) => {
          if (!has3dLayer) return;
          {
            const renderScaleWidget = refCounted.registerDisposer(new RenderScaleWidget(
                this.layer.displayState.renderScaleHistogram,
                this.layer.displayState.renderScaleTarget));
            renderScaleWidget.label.textContent = 'Resolution (mesh)';
            parent.appendChild(renderScaleWidget.element);
          }
          const objectAlphaWidget =
              refCounted.registerDisposer(new RangeWidget(this.layer.displayState.objectAlpha));
          objectAlphaWidget.promptElement.textContent = 'Opacity (3d)';
          parent.appendChild(objectAlphaWidget.element);
        }, this.visibility));
    element.appendChild(controls3d.element);

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

    const visibleSegmentWidget =
        this.registerDisposer(new SegmentSetWidget(this.layer.displayState));
    const addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());

    addSegmentWidget.element.classList.add('add-segment');
    addSegmentWidget.element.title = 'Add one or more segment IDs';
    element.appendChild(this.registerDisposer(addSegmentWidget).element);
    this.registerDisposer(addSegmentWidget.valuesEntered.add((values: Uint64[]) => {
      for (const value of values) {
        this.layer.displayState.visibleSegments.add(value);
      }
    }));
    element.appendChild(this.registerDisposer(visibleSegmentWidget).element);

    const skeletonControls = this.registerDisposer(new DependentViewWidget(
        layer.hasSkeletonsLayer, (hasSkeletonsLayer, parent, refCounted) => {
          if (!hasSkeletonsLayer) return;
          const addViewSpecificSkeletonRenderingControls =
              (options: ViewSpecificSkeletonRenderingOptions, viewName: string) => {
                {
                  const widget = refCounted.registerDisposer(new EnumSelectWidget(options.mode));
                  const label = document.createElement('label');
                  label.className =
                      'neuroglancer-segmentation-dropdown-skeleton-render-mode neuroglancer-noselect';
                  label.appendChild(document.createTextNode(`Skeleton mode (${viewName})`));
                  label.appendChild(widget.element);
                  parent.appendChild(label);
                }
                {
                  const widget = this.registerDisposer(
                      new RangeWidget(options.lineWidth, {min: 1, max: 40, step: 1}));
                  widget.promptElement.textContent = `Skeleton line width (${viewName})`;
                  parent.appendChild(widget.element);
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
          topRow.appendChild(label);
          topRow.appendChild(makeMaximizeButton({
            title: 'Show larger editor view',
            onClick: () => {
              new ShaderCodeOverlay(this.layer);
            }
          }));
          topRow.appendChild(makeHelpButton({
            title: 'Documentation on skeleton rendering',
            href:
                'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md',
          }));
          parent.appendChild(topRow);

          const codeWidget = refCounted.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
          parent.appendChild(codeWidget.element);
          parent.appendChild(
              refCounted
                  .registerDisposer(new ShaderControls(
                      layer.displayState.skeletonRenderingOptions.shaderControlState))
                  .element);
          codeWidget.textEditor.refresh();
        }, this.visibility));
    element.appendChild(skeletonControls.element);
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
registerLayerTypeDetector(subsource => {
  if (subsource.mesh !== undefined) return SegmentationUserLayer;
  return undefined;
});
