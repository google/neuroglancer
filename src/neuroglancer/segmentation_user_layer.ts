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

import debounce from 'lodash/debounce';
import {CoordinateTransformSpecification} from 'neuroglancer/coordinate_transform';
import {DataSourceSpecification} from 'neuroglancer/datasource';
import {ManagedUserLayer, registerLayerType, registerLayerTypeDetector, registerVolumeLayerType, UserLayer} from 'neuroglancer/layer';
import {layerDataSourceSpecificationFromJson, LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {MeshLayer, MeshSource, MultiscaleMeshLayer, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {Overlay} from 'neuroglancer/overlay';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {getCssColor, SegmentColorHash} from 'neuroglancer/segment_color';
import {getBaseObjectColor, SegmentationDisplayState, SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {compareSegmentLabels, normalizeSegmentLabel, SegmentLabelMap, SegmentPropertyMap} from 'neuroglancer/segmentation_display_state/property_map';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonRenderingOptions, SliceViewPanelSkeletonLayer, ViewSpecificSkeletonRenderingOptions} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeCachedLazyDerivedWatchableValue, observeWatchable, TrackableValue, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {getDefaultSelectBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {Uint64Map} from 'neuroglancer/uint64_map';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {arraysEqual, ArraySpliceOp, binarySearchLowerBound, getMergeSplices} from 'neuroglancer/util/array';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {packColor, parseRGBColorSpecification} from 'neuroglancer/util/color';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {parseArray, verifyFiniteNonNegativeFloat, verifyObjectAsMap, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {ActionEvent, EventActionMap, KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {observeSignal, Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {makeCopyButton} from 'neuroglancer/widget/copy_button';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {makeFilterButton} from 'neuroglancer/widget/filter_button';
import {makeHelpButton} from 'neuroglancer/widget/help_button';
import {makeMaximizeButton} from 'neuroglancer/widget/maximize_button';
import {RangeWidget} from 'neuroglancer/widget/range';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {ShaderControls} from 'neuroglancer/widget/shader_controls';
import {Tab} from 'neuroglancer/widget/tab_view';
import {VirtualList, VirtualListSource} from 'neuroglancer/widget/virtual_list';

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const SATURATION_JSON_KEY = 'saturation';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';
const IGNORE_NULL_VISIBLE_SET_JSON_KEY = 'ignoreNullVisibleSet';
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
const SEGMENT_QUERY_JSON_KEY = 'segmentQuery';
const MESH_SILHOUETTE_RENDERING_JSON_KEY = 'meshSilhouetteRendering';

const maxSilhouettePower = 10;

const tempUint64 = new Uint64();

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);

  bindSegmentListWidth(element: HTMLElement) {
    return observeWatchable(
        width => element.style.setProperty('--neuroglancer-segment-list-width', `${width}ch`),
        this.displayState.maxIdLength);
  }

  segmentQuery = new TrackableValue<string>('', verifyString);
  segmentQueryFocusTime = new WatchableValue<number>(Number.NEGATIVE_INFINITY);

  selectSegment = (id: Uint64, pin: boolean|'toggle') => {
    this.manager.root.selectionState.captureSingleLayerState(this, state => {
      state.value = id.clone();
      return true;
    }, pin);
  };

  filterBySegmentLabel = (id: Uint64) => {
    const idString = id.toString();
    const segmentLabelMap = this.displayState.segmentLabelMap.value;
    if (segmentLabelMap === undefined) return;
    const label = segmentLabelMap.idToLabel[idString];
    if (!label) return;
    this.filterSegments(label);
  };

  filterSegments = (query: string) => {
    this.segmentQuery.value = query;
    this.segmentQueryFocusTime.value = Date.now();
    this.tabs.value = 'segments';
    this.manager.root.selectedLayer.layer = this.managedLayer;
  };

  displayState = {
    segmentColorHash: SegmentColorHash.getDefault(),
    segmentStatedColors: Uint64Map.makeWithCounterpart(this.manager.worker),
    segmentSelectionState: new SegmentSelectionState(),
    selectedAlpha: trackableAlphaValue(0.5),
    saturation: trackableAlphaValue(1.0),
    notSelectedAlpha: trackableAlphaValue(0),
    silhouetteRendering: new TrackableValue<number>(0, verifyFiniteNonNegativeFloat, 0),
    objectAlpha: trackableAlphaValue(1.0),
    hideSegmentZero: new TrackableBoolean(true, true),
    ignoreNullVisibleSet: new TrackableBoolean(true, true),
    visibleSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    highlightedSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    segmentEquivalences: SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker),
    skeletonRenderingOptions: new SkeletonRenderingOptions(),
    shaderError: makeWatchableShaderError(),
    renderScaleHistogram: new RenderScaleHistogram(),
    renderScaleTarget: trackableRenderScaleTarget(1),
    segmentLabelMap: new WatchableValue<SegmentLabelMap|undefined>(undefined),
    segmentPropertyMaps: new WatchableValue<SegmentPropertyMap[]>([]),
    maxIdLength: new WatchableValue(1),
    selectSegment: this.selectSegment,
    filterBySegmentLabel: this.filterBySegmentLabel,
    transparentPickEnabled: this.pick,
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
    this.displayState.ignoreNullVisibleSet.changed.add(this.specificationChanged.dispatch);
    this.displayState.skeletonRenderingOptions.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentColorHash.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentStatedColors.changed.add(this.specificationChanged.dispatch);
    this.displayState.renderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.displayState.silhouetteRendering.changed.add(this.specificationChanged.dispatch);
    this.sliceViewRenderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.segmentQuery.changed.add(this.specificationChanged.dispatch);
    this.tabs.add(
        'rendering', {label: 'Render', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.add(
        'segments', {label: 'Seg.', order: -50, getter: () => new SegmentDisplayTab(this)});
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
    let updatedSegmentLabelMap: SegmentLabelMap|undefined;
    const updatedSegmentPropertyMaps: SegmentPropertyMap[] = [];
    for (const loadedSubsource of subsources) {
      if (this.addStaticAnnotations(loadedSubsource)) continue;
      const {volume, mesh, segmentPropertyMap} = loadedSubsource.subsourceEntry.subsource;
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
      } else if (segmentPropertyMap !== undefined) {
        const {labelMap} = segmentPropertyMap;
        if (labelMap !== undefined) {
          if (updatedSegmentLabelMap !== undefined) {
            loadedSubsource.deactivate('Only one segment label map is supported');
            continue;
          }
          loadedSubsource.activate(() => {});
          updatedSegmentLabelMap = labelMap;
        }
        updatedSegmentPropertyMaps.push(segmentPropertyMap);
      } else {
        loadedSubsource.deactivate('Not compatible with segmentation layer');
      }
    }
    this.displayState.segmentLabelMap.value = updatedSegmentLabelMap;
    if (!arraysEqual(updatedSegmentPropertyMaps, this.displayState.segmentPropertyMaps.value)) {
      this.displayState.segmentPropertyMaps.value = updatedSegmentPropertyMaps;
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
    this.displayState.silhouetteRendering.restoreState(
        specification[MESH_SILHOUETTE_RENDERING_JSON_KEY]);
    this.displayState.ignoreNullVisibleSet.restoreState(
        specification[IGNORE_NULL_VISIBLE_SET_JSON_KEY]);

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

    this.displayState.highlightedSegments.changed.add(this.specificationChanged.dispatch);

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
    this.segmentQuery.restoreState(specification[SEGMENT_QUERY_JSON_KEY]);
  }

  toJSON() {
    const x = super.toJSON();
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.displayState.hideSegmentZero.toJSON();
    x[IGNORE_NULL_VISIBLE_SET_JSON_KEY] = this.displayState.ignoreNullVisibleSet.toJSON();
    x[COLOR_SEED_JSON_KEY] = this.displayState.segmentColorHash.toJSON();
    x[MESH_SILHOUETTE_RENDERING_JSON_KEY] = this.displayState.silhouetteRendering.toJSON();
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
    x[SEGMENT_QUERY_JSON_KEY] = this.segmentQuery.toJSON();
    return x;
  }

  transformPickedValue(value: any) {
    if (value == null) {
      return value;
    }
    const {segmentEquivalences, segmentLabelMap: {value: segmentLabelMap}} = this.displayState;
    let id: Uint64;
    let mappedValue: Uint64;
    let mapped: Uint64|undefined;
    let label: string|undefined;
    if (typeof value === 'number') {
      id = new Uint64(value, 0);
    } else {
      id = value;
    }
    if (segmentEquivalences.size !== 0) {
      mappedValue = segmentEquivalences.get(value);
      if (Uint64.equal(mappedValue, value)) {
        mapped = undefined;
      } else {
        mapped = mappedValue;
      }
    } else {
      mappedValue = id;
    }
    if (segmentLabelMap !== undefined) {
      label = segmentLabelMap.get(mappedValue.toString());
    }
    if (label === undefined && mapped === undefined) {
      return id;
    }
    return new Uint64MapEntry(id, mapped, label);
  }

  handleAction(action: string) {
    switch (action) {
      case 'recolor': {
        this.displayState.segmentColorHash.randomize();
        break;
      }
      case 'clear-segments': {
        if (!this.pick.value) break;
        this.displayState.visibleSegments.clear();
        break;
      }
      case 'select': {
        if (!this.pick.value) break;
        const {segmentSelectionState} = this.displayState;
        if (segmentSelectionState.hasSelectedSegment) {
          const segment = segmentSelectionState.selectedSegment;
          const {visibleSegments} = this.displayState;
          visibleSegments.set(segment, !visibleSegments.has(segment));
        }
        break;
      }
      case 'highlight': {
        if (!this.pick.value) break;
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
  selectionStateFromJson(state: this['selectionState'], json: any) {
    super.selectionStateFromJson(state, json);
    const v = new Uint64();
    let {value} = state;
    if (typeof value === 'number') value = value.toString();
    if (typeof value !== 'string' || !v.tryParseString(value)) {
      state.value = undefined;
    } else {
      state.value = v;
    }
  }
  selectionStateToJson(state: this['selectionState'], forPython: boolean): any {
    const json = super.selectionStateToJson(state, forPython);
    let {value} = state;
    if (value instanceof Uint64MapEntry) {
      if (forPython) {
        json.value = {
          key: value.key.toString(),
          value: value.value ? value.value.toString() : undefined,
          label: value.label,
        };
      } else {
        json.value = (value.value || value.key).toString();
      }
    } else if (value instanceof Uint64) {
      json.value = value.toString();
    }
    return json;
  }

  private displaySegmentationSelection(
      state: this['selectionState'], parent: HTMLElement, context: RefCounted): boolean {
    const {value} = state;
    let id: Uint64;
    if (typeof value === 'number' || typeof value === 'string') {
      id = new Uint64();
      if (!id.tryParseString(value.toString())) return false;
    }
    if (value instanceof Uint64) {
      id = value.clone();
    } else if (value instanceof Uint64MapEntry) {
      id = value.key.clone();
    } else {
      return false;
    }
    const {
      segmentEquivalences,
      segmentLabelMap: {value: segmentLabelMap},
      segmentPropertyMaps: {value: segmentPropertyMaps},
      visibleSegments,
      segmentSelectionState
    } = this.displayState;
    const mapped = segmentEquivalences.get(id);
    const row = document.createElement('div');
    row.classList.add('neuroglancer-selection-details-segment');
    row.classList.add('neuroglancer-segment-list-entry');
    let label: string|undefined;
    if (segmentLabelMap !== undefined) {
      label = segmentLabelMap.get(mapped.toString());
    }

    const watchableHas = context.registerDisposer(makeCachedLazyDerivedWatchableValue(
        visibleSegments => visibleSegments.has(mapped), visibleSegments));
    const checkbox = context
                         .registerDisposer(new TrackableBooleanCheckbox({
                           changed: watchableHas.changed,
                           get value() {
                             return watchableHas.value;
                           },
                           set value(value: boolean) {
                             visibleSegments.set(mapped, value);
                           },
                         }))
                         .element;
    context.registerDisposer(observeSignal(() => {
      row.dataset.selected = (segmentSelectionState.hasSelectedSegment &&
                              Uint64.equal(segmentSelectionState.selectedSegment, mapped)) ?
          'true' :
          'false';
    }, segmentSelectionState.changed));
    row.addEventListener('mouseenter', () => {
      this.displayState.segmentSelectionState.set(mapped);
    });
    row.addEventListener('mouseleave', () => {
      this.displayState.segmentSelectionState.set(null);
    });
    checkbox.title = 'Toggle segment visibility';
    const copyButton = makeCopyButton({
      title: `Copy segment ID`,
      onClick: () => {
        setClipboard(mappedIdString);
      },
    });
    copyButton.classList.add('neuroglancer-segment-list-entry-copy');
    row.appendChild(copyButton);
    row.appendChild(checkbox);
    const mappedIdString = mapped.toString();
    context.registerDisposer(this.bindSegmentListWidth(row));
    const idElement = document.createElement('span');
    idElement.classList.add('neuroglancer-selection-details-segment-id');
    const idString = id.toString();
    idElement.textContent = idString;
    updateIdStringWidth(this.displayState.maxIdLength, idString);
    updateIdStringWidth(this.displayState.maxIdLength, mappedIdString);
    row.appendChild(idElement);
    if (!Uint64.equal(mapped, id)) {
      const mappedIdElement = document.createElement('span');
      mappedIdElement.classList.add('neuroglancer-selection-details-segment-mapped-id');
      mappedIdElement.textContent = mapped.toString();
      context.registerDisposer(observeSignal(
          () => {
            mappedIdElement.style.backgroundColor =
                getCssColor(getBaseObjectColor(this.displayState, mapped));
          },
          this.displayState.segmentStatedColors.changed,
          this.displayState.segmentColorHash.changed));
      idElement.style.backgroundColor = 'white';
      row.appendChild(mappedIdElement);
    } else {
      context.registerDisposer(observeSignal(
          () => {
            idElement.style.backgroundColor =
                getCssColor(getBaseObjectColor(this.displayState, mapped));
          },
          this.displayState.segmentStatedColors.changed,
          this.displayState.segmentColorHash.changed));
    }
    const filterElement = makeFilterButton({
      title: 'Filter by label',
      onClick: () => {
        this.filterBySegmentLabel(mapped);
      }
    });
    filterElement.classList.add('neuroglancer-segment-list-entry-filter');
    row.appendChild(filterElement);
    if (!label) {
      filterElement.style.visibility = 'hidden';
    }
    const nameElement = document.createElement('span');
    nameElement.classList.add('neuroglancer-segment-list-entry-name');
    nameElement.textContent = label || '';
    row.appendChild(nameElement);
    parent.appendChild(row);

    // First extract all description properties
    for (const propertyMap of segmentPropertyMaps) {
      const {inlineProperties} = propertyMap;
      if (inlineProperties === undefined) continue;
      const index = propertyMap.inlineIdToIndex![mappedIdString];
      if (index === undefined) continue;
      for (const property of inlineProperties.properties) {
        if (property.type === 'label') continue;
        if (property.type === 'description') {
          const value = property.values[index];
          if (!value) continue;
          const descriptionElement = document.createElement('div');
          descriptionElement.classList.add('neuroglancer-selection-details-segment-description');
          descriptionElement.textContent = value;
          parent.appendChild(descriptionElement);
        }
      }
    }
    return true;
  }

  displaySelectionState(state: this['selectionState'], parent: HTMLElement, context: RefCounted):
      boolean {
    let displayed = this.displaySegmentationSelection(state, parent, context);
    if (super.displaySelectionState(state, parent, context)) displayed = true;
    return displayed;
  }
  static type = 'segmentation';
  static supportsPickOption = true;
}


function updateIdStringWidth(idStringWidth: WatchableValueInterface<number>, idString: string) {
  const {length} = idString;
  if (idStringWidth.value < length) {
    idStringWidth.value = length;
  }
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
          const silhouetteWidget = refCounted.registerDisposer(new RangeWidget(
              this.layer.displayState.silhouetteRendering,
              {min: 0, max: maxSilhouettePower, step: 0.1}));
          silhouetteWidget.promptElement.textContent = 'Silhouette (3d)';
          silhouetteWidget.element.title =
              'Set to a non-zero value to increase transparency of object faces perpendicular to view direction';
          parent.appendChild(silhouetteWidget.element);
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

    {
      const checkbox = this.registerDisposer(
          new TrackableBooleanCheckbox(layer.displayState.ignoreNullVisibleSet));
      checkbox.element.className = 'neuroglancer-noselect';
      const label = document.createElement('label');
      label.className = 'neuroglancer-noselect';
      label.appendChild(document.createTextNode('Show all segments if none selected'));
      label.appendChild(checkbox.element);
      element.appendChild(label);
    }

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
          parent.appendChild(refCounted
                                 .registerDisposer(new ShaderControls(
                                     layer.displayState.skeletonRenderingOptions.shaderControlState,
                                     this.layer.manager.root.display, {
                                       visibility: this.visibility,
                                     }))
                                 .element);
          codeWidget.textEditor.refresh();
        }, this.visibility));
    element.appendChild(skeletonControls.element);
  }
}

const idPattern = /^[,\s]*[0-9]+(?:[,\s]+[0-9]+)*[,\s]*$/;

class SegmentListSource extends RefCounted implements VirtualListSource {
  length: number;

  changed = new Signal<(splices: readonly Readonly<ArraySpliceOp>[]) => void>();
  sortedVisibleSegments: Uint64[]|undefined;
  visibleSegmentsGeneration = -1;
  prevQuery: string|undefined;
  matches: readonly(readonly[string, string])[]|undefined;
  matchPredicate: ((idString: string) => boolean)|undefined;
  statusText = new WatchableValue<string>('');
  selectedMatches: number = 0;
  matchStatusTextPrefix: string = '';

  get numMatches() {
    const {matches} = this;
    return matches === undefined ? 0 : matches.length;
  }

  private update() {
    const query = this.query.value;
    const {segmentLabelMap} = this;
    const splices: ArraySpliceOp[] = [];
    let newMatches: readonly(readonly[string, string])[]|undefined;
    let changed = false;
    let matchStatusTextPrefix = '';
    const {visibleSegments} = this.segmentationDisplayState;
    const visibleSegmentsGeneration = visibleSegments.changed.count;
    const prevVisibleSegmentsGeneration = this.visibleSegmentsGeneration;
    let matchPredicate: ((idString: string) => boolean)|undefined;
    if (query.length === 0) {
      if (prevVisibleSegmentsGeneration !== visibleSegmentsGeneration ||
          this.sortedVisibleSegments === undefined) {
        this.visibleSegmentsGeneration = visibleSegmentsGeneration;
        const newSortedVisibleSegments = Array.from(visibleSegments, x => x.clone());
        newSortedVisibleSegments.sort(Uint64.compare);
        const {sortedVisibleSegments} = this;
        if (sortedVisibleSegments === undefined) {
          this.sortedVisibleSegments = newSortedVisibleSegments;
          splices.push(
              {retainCount: 0, insertCount: newSortedVisibleSegments.length, deleteCount: 0});
        } else {
          splices.push(
              ...getMergeSplices(sortedVisibleSegments, newSortedVisibleSegments, Uint64.compare));
        }
        this.sortedVisibleSegments = newSortedVisibleSegments;
        changed = true;
      } else {
        splices.push(
            {retainCount: this.sortedVisibleSegments!.length, deleteCount: 0, insertCount: 0});
      }
      if (segmentLabelMap !== undefined) {
        newMatches = segmentLabelMap.sortedNames;
        matchStatusTextPrefix = `${newMatches.length} listed ids`;
        matchPredicate = idString => segmentLabelMap.has(idString);
      }
    } else {
      if (this.sortedVisibleSegments !== undefined) {
        splices.push(
            {deleteCount: this.sortedVisibleSegments.length, retainCount: 0, insertCount: 0});
        this.sortedVisibleSegments = undefined;
        changed = true;
      }
      this.visibleSegmentsGeneration = visibleSegmentsGeneration;
      if (this.prevQuery === query) {
        newMatches = this.matches;
        matchPredicate = this.matchPredicate;
        matchStatusTextPrefix = this.matchStatusTextPrefix;
      } else {
        // Check for numerical match
        if (query.match(idPattern) !== null) {
          const parts = query.split(/[\s,]+/);
          const ids: Uint64[] = [];
          const idSet = new Set<string>();
          for (let i = 0, n = parts.length; i < n; ++i) {
            const part = parts[i];
            if (part === '') continue;
            const id = new Uint64();
            if (!id.tryParseString(part)) continue;
            const idString = id.toString();
            if (idSet.has(idString)) continue;
            idSet.add(idString);
            ids.push(id);
          }
          ids.sort(Uint64.compare);
          newMatches = ids.map(id => {
            const idString = id.toString();
            const name = segmentLabelMap === undefined ? '' : (segmentLabelMap.get(idString) || '');
            return [idString, name];
          });
          matchPredicate = idString => idSet.has(idString);
          matchStatusTextPrefix = `${newMatches.length} ids`;
        } else if (query.startsWith('/')) {
          // Regular expression match
          try {
            const m = new RegExp(query.substring(1));
            if (segmentLabelMap !== undefined) {
              newMatches = segmentLabelMap.sortedNames.filter(x => x[1].match(m));
              matchStatusTextPrefix =
                  `${newMatches.length}/${segmentLabelMap.sortedNames.length} regexp matches`;
              matchPredicate = idString => {
                const name = segmentLabelMap.get(idString);
                return name !== undefined && name.match(m) !== null;
              };
            }
          } catch {
            // no matches
          }
        } else {
          // prefix match
          if (segmentLabelMap !== undefined) {
            const {sortedNames} = segmentLabelMap;
            const normalizedQuery = normalizeSegmentLabel(query);
            const lower = binarySearchLowerBound(
                0, sortedNames.length,
                i => compareSegmentLabels(sortedNames[i][1], normalizedQuery) >= 0);
            const upper = binarySearchLowerBound(
                lower, sortedNames.length,
                i => !normalizeSegmentLabel(sortedNames[i][1]).startsWith(normalizedQuery));
            newMatches = sortedNames.slice(lower, upper);
            matchPredicate = idString => {
              const name = segmentLabelMap.get(idString);
              return name !== undefined && normalizeSegmentLabel(name).startsWith(normalizedQuery);
            };
            matchStatusTextPrefix =
                `${newMatches.length}/${segmentLabelMap.sortedNames.length} prefix matches`;
          }
        }
      }
    }
    const prevMatches = this.matches;
    if (newMatches !== prevMatches) {
      splices.push({
        retainCount: 0,
        deleteCount: prevMatches === undefined ? 0 : prevMatches.length,
        insertCount: newMatches === undefined ? 0 : newMatches.length
      });
      changed = true;
    }
    if (newMatches !== prevMatches || visibleSegmentsGeneration !== prevVisibleSegmentsGeneration) {
      let statusText = matchStatusTextPrefix;
      // Recompute selectedMatches.
      let selectedMatches = 0;
      if (matchPredicate !== undefined) {
        for (const id of visibleSegments) {
          if (matchPredicate(id.toString())) ++selectedMatches;
        }
        statusText += ` (${selectedMatches} visible)`;
      }
      this.selectedMatches = selectedMatches;
      this.statusText.value = statusText;
    }
    this.prevQuery = query;
    this.matches = newMatches;
    this.matchStatusTextPrefix = matchStatusTextPrefix;
    this.matchPredicate = matchPredicate;
    const {sortedVisibleSegments} = this;
    this.length = (sortedVisibleSegments === undefined ? 0 : sortedVisibleSegments.length) +
        ((newMatches === undefined) ? 0 : newMatches.length);
    if (changed) {
      this.changed.dispatch(splices);
    }
  }
  debouncedUpdate = debounce(() => this.update(), 0);

  constructor(
      public query: WatchableValueInterface<string>,
      public segmentLabelMap: SegmentLabelMap|undefined,
      public segmentationDisplayState: SegmentationDisplayState) {
    super();
    this.update();

    this.registerDisposer(
        segmentationDisplayState.visibleSegments.changed.add(this.debouncedUpdate));
    this.registerDisposer(query.changed.add(this.debouncedUpdate));
  }

  private updateRendering(element: HTMLElement) {
    const idString = element.dataset.id;
    if (idString === undefined) return;
    tempUint64.tryParseString(idString);
    const {children} = element;
    const checkbox = children[1] as HTMLInputElement;
    const idElement = children[2] as HTMLElement;
    const {visibleSegments} = this.segmentationDisplayState;
    checkbox.checked = visibleSegments.has(tempUint64);
    idElement.style.backgroundColor =
        getCssColor(getBaseObjectColor(this.segmentationDisplayState, tempUint64));
    idElement.textContent = idString;
  }

  render = (() => {
    const containerTemplate = document.createElement('div');
    containerTemplate.classList.add('neuroglancer-segment-list-entry');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.title = 'Toggle segment visibility';
    const copyButton = makeCopyButton({
      title: `Copy segment ID`,
    });
    copyButton.classList.add('neuroglancer-segment-list-entry-copy');
    containerTemplate.appendChild(copyButton);
    containerTemplate.appendChild(checkbox);
    const idElement = document.createElement('span');
    idElement.classList.add('neuroglancer-segment-list-entry-id');
    containerTemplate.appendChild(idElement);
    const filterElement = makeFilterButton({
      title: 'Filter by label',
    });
    filterElement.classList.add('neuroglancer-segment-list-entry-filter');
    containerTemplate.appendChild(filterElement);
    const nameElement = document.createElement('span');
    nameElement.classList.add('neuroglancer-segment-list-entry-name');
    containerTemplate.appendChild(nameElement);
    const {segmentationDisplayState} = this;
    function onMouseEnter(this: HTMLElement) {
      const idString = this.dataset.id!;
      if (!tempUint64.tryParseString(idString)) return;
      segmentationDisplayState.segmentSelectionState.set(tempUint64);
      segmentationDisplayState.selectSegment(tempUint64, false);
    }
    function selectHandler(this: HTMLElement, event: ActionEvent<Event>) {
      event.stopPropagation();
      const idString = this.dataset.id!;
      if (!tempUint64.tryParseString(idString)) return;
      segmentationDisplayState.selectSegment(tempUint64, 'toggle');
    }
    function filterHandler(this: HTMLElement) {
      const idString = this.parentElement!.dataset.id!;
      if (!tempUint64.tryParseString(idString)) return;
      segmentationDisplayState.filterBySegmentLabel(tempUint64);
    }
    function onMouseLeave(this: HTMLElement) {
      const idString = this.dataset.id!;
      if (!tempUint64.tryParseString(idString)) return;
      segmentationDisplayState.segmentSelectionState.set(null);
    }

    function checkboxHandler(this: HTMLInputElement, event: Event) {
      event.stopPropagation();
      const idString = this.parentElement!.dataset.id!;
      tempUint64.parseString(idString);
      const {visibleSegments} = segmentationDisplayState;
      if (this.checked) {
        visibleSegments.add(tempUint64);
      } else {
        visibleSegments.delete(tempUint64);
      }
    }
    function copyHandler(this: HTMLElement, event: MouseEvent) {
      setClipboard(this.parentElement!.dataset.id!);
      event.stopPropagation();
    }
    const {segmentSelectionState} = segmentationDisplayState;
    return (index: number) => {
      const {sortedVisibleSegments, segmentLabelMap} = this;
      let idString: string;
      let name: string|undefined;
      const container = containerTemplate.cloneNode(/*deep=*/ true) as HTMLDivElement;
      if (sortedVisibleSegments !== undefined && index < sortedVisibleSegments.length) {
        idString = sortedVisibleSegments[index].toString();
        if (segmentLabelMap !== undefined) {
          name = segmentLabelMap.get(idString);
        }
        container.dataset.visibleList = 'true';
      } else {
        if (sortedVisibleSegments !== undefined) {
          index = index - sortedVisibleSegments.length;
        }
        [idString, name] = this.matches![index];
      }
      container.dataset.selected = (segmentSelectionState.hasSelectedSegment &&
                                    segmentSelectionState.selectedSegment.toString() === idString) ?
          'true' :
          'false';
      const {children} = container;
      const checkbox = children[1];
      checkbox.addEventListener('change', checkboxHandler);
      const filterElement = children[3];
      filterElement.addEventListener('click', filterHandler);
      container.addEventListener('mouseenter', onMouseEnter);
      container.addEventListener('mouseleave', onMouseLeave);
      const copyButton = children[0];
      copyButton.addEventListener('click', copyHandler);
      container.addEventListener('action:select-position', selectHandler);
      const idElement = children[2];
      const nameElement = children[4];
      container.dataset.id = idString;
      idElement.textContent = idString;
      nameElement.textContent = name || '';
      if (!name) {
        (filterElement as HTMLElement).style.visibility = 'hidden';
      }
      this.updateRendering(container);
      updateIdStringWidth(segmentationDisplayState.maxIdLength, idString);
      return container;
    };
  })();

  updateRenderedItems(list: VirtualList) {
    const {segmentSelectionState} = this.segmentationDisplayState;
    const idString = segmentSelectionState.hasSelectedSegment ?
        segmentSelectionState.selectedSegment.toString() :
        '';
    list.forEachRenderedItem(element => {
      this.updateRendering(element);
      element.dataset.selected = (element.dataset.id === idString) ? 'true' : 'false';
    });
  }
}

const keyMap = EventActionMap.fromObject({
  'enter': {action: 'toggle-listed'},
  'shift+enter': {action: 'hide-listed'},
  'control+enter': {action: 'hide-all'},
  'escape': {action: 'cancel'},
});

const selectSegmentConfirmationThreshold = 100;

class SegmentDisplayTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-segment-display-tab');
    const queryElement = document.createElement('input');
    queryElement.classList.add('neuroglancer-segment-list-query');
    queryElement.addEventListener('focus', () => {
      queryElement.select();
    });
    const keyboardHandler = this.registerDisposer(new KeyboardEventBinder(queryElement, keyMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    const debouncedUpdateQueryModel = this.registerCancellable(debounce(() => {
      this.layer.segmentQuery.value = queryElement.value;
    }, 200));
    queryElement.autocomplete = 'off';
    queryElement.title = keyMap.describe();
    queryElement.spellcheck = false;
    queryElement.placeholder = 'Enter ID, name prefix or /regexp';
    this.registerDisposer(observeWatchable(q => {
      queryElement.value = q;
    }, this.layer.segmentQuery));
    this.registerDisposer(observeWatchable(t => {
      if (Date.now() - t < 100) {
        setTimeout(() => {
          queryElement.focus();
        }, 0);
        this.layer.segmentQueryFocusTime.value = Number.NEGATIVE_INFINITY;
      }
    }, this.layer.segmentQueryFocusTime));
    element.appendChild(queryElement);
    element.appendChild(
        this
            .registerDisposer(new DependentViewWidget(
                layer.displayState.segmentLabelMap,
                (segmentLabelMap, parent, context) => {
                  const listSource = context.registerDisposer(new SegmentListSource(
                      this.layer.segmentQuery, segmentLabelMap, layer.displayState));
                  const selectionStatusContainer = document.createElement('span');
                  const selectionClearButton = document.createElement('input');
                  selectionClearButton.type = 'checkbox';
                  selectionClearButton.checked = true;
                  selectionClearButton.title = 'Deselect all segment IDs';
                  selectionClearButton.addEventListener('change', () => {
                    layer.displayState.visibleSegments.clear();
                  });
                  const selectionCopyButton = makeCopyButton({
                    title: 'Copy visible segment IDs',
                    onClick: () => {
                      const visibleSegments =
                          Array.from(layer.displayState.visibleSegments, x => x.clone());
                      visibleSegments.sort(Uint64.compare);
                      setClipboard(visibleSegments.join(', '));
                    },
                  });
                  const selectionStatusMessage = document.createElement('span');
                  selectionStatusContainer.appendChild(selectionCopyButton);
                  selectionStatusContainer.appendChild(selectionClearButton);
                  selectionStatusContainer.appendChild(selectionStatusMessage);
                  const matchStatusContainer = document.createElement('span');
                  const matchCheckbox = document.createElement('input');
                  const matchCopyButton = makeCopyButton({
                    onClick: () => {
                      debouncedUpdateQueryModel();
                      debouncedUpdateQueryModel.flush();
                      listSource.debouncedUpdate.flush();
                      const {matches} = listSource;
                      if (matches === undefined) return;
                      setClipboard(Array.from(matches, x => x[0]).join(', '));
                    },
                  });
                  matchCheckbox.type = 'checkbox';
                  const toggleMatches = () => {
                    debouncedUpdateQueryModel();
                    debouncedUpdateQueryModel.flush();
                    listSource.debouncedUpdate.flush();
                    const {matches} = listSource;
                    if (matches === undefined) return;
                    const {visibleSegments} = layer.displayState;
                    const {selectedMatches} = listSource;
                    const shouldSelect = (selectedMatches !== matches.length);
                    if (shouldSelect &&
                        matches.length - selectedMatches > selectSegmentConfirmationThreshold) {
                      if (!hasConfirmed) {
                        hasConfirmed = true;
                        matchStatusMessage.textContent =
                            `Confirm: show ${matches.length - selectedMatches} segments?`;
                        return false;
                      }
                      hasConfirmed = false;
                      updateStatus();
                    }
                    for (const [idString] of matches) {
                      tempUint64.tryParseString(idString);
                      visibleSegments.set(tempUint64, shouldSelect);
                    }
                    return true;
                  };
                  matchCheckbox.addEventListener('click', event => {
                    if (!toggleMatches()) event.preventDefault();
                  });
                  const matchStatusMessage = document.createElement('span');
                  matchStatusContainer.appendChild(matchCopyButton);
                  matchStatusContainer.appendChild(matchCheckbox);
                  matchStatusContainer.appendChild(matchStatusMessage);
                  selectionStatusContainer.classList.add('neuroglancer-segment-list-status');
                  matchStatusContainer.classList.add('neuroglancer-segment-list-status');
                  parent.appendChild(matchStatusContainer);
                  parent.appendChild(selectionStatusContainer);
                  let prevNumSelected = -1;
                  const updateStatus = () => {
                    const numSelected = layer.displayState.visibleSegments.size;
                    if (prevNumSelected !== numSelected) {
                      prevNumSelected = numSelected;
                      selectionStatusMessage.textContent = `${numSelected} visible in total`;
                      selectionClearButton.checked = numSelected > 0;
                      selectionClearButton.style.visibility = numSelected ? 'visible' : 'hidden';
                      selectionCopyButton.style.visibility = numSelected ? 'visible' : 'hidden';
                    }
                    matchStatusMessage.textContent = listSource.statusText.value;
                    const {numMatches, selectedMatches} = listSource;
                    matchCopyButton.style.visibility = numMatches ? 'visible' : 'hidden';
                    matchCopyButton.title = `Copy ${numMatches} segment ID(s)`;
                    matchCheckbox.style.visibility = numMatches ? 'visible' : 'hidden';
                    if (selectedMatches === 0) {
                      matchCheckbox.checked = false;
                      matchCheckbox.indeterminate = false;
                      matchCheckbox.title = `Show ${numMatches} segment ID(s)`;
                    } else if (selectedMatches === numMatches) {
                      matchCheckbox.checked = true;
                      matchCheckbox.indeterminate = false;
                      matchCheckbox.title = `Hide ${selectedMatches} segment ID(s)`;
                    } else {
                      matchCheckbox.checked = true;
                      matchCheckbox.indeterminate = true;
                      matchCheckbox.title = `Show ${numMatches - selectedMatches} segment ID(s)`;
                    }
                  };
                  updateStatus();
                  listSource.statusText.changed.add(updateStatus);
                  context.registerDisposer(
                      layer.displayState.visibleSegments.changed.add(updateStatus));
                  let hasConfirmed = false;
                  context.registerEventListener(queryElement, 'input', () => {
                    debouncedUpdateQueryModel();
                    if (hasConfirmed) {
                      hasConfirmed = false;
                      updateStatus();
                    }
                  });
                  registerActionListener(queryElement, 'cancel', () => {
                    queryElement.blur();
                    queryElement.value = '';
                    this.layer.segmentQuery.value = '';
                    hasConfirmed = false;
                    updateStatus();
                  });
                  registerActionListener(queryElement, 'toggle-listed', toggleMatches);
                  registerActionListener(queryElement, 'hide-all', () => {
                    layer.displayState.visibleSegments.clear();
                  });
                  registerActionListener(queryElement, 'hide-listed', () => {
                    debouncedUpdateQueryModel();
                    debouncedUpdateQueryModel.flush();
                    listSource.debouncedUpdate.flush();
                    const {visibleSegments} = layer.displayState;
                    if (layer.segmentQuery.value === '') {
                      visibleSegments.clear();
                    } else {
                      const {matches} = listSource;
                      if (matches === undefined) return;
                      for (const [idString] of matches) {
                        tempUint64.tryParseString(idString);
                        visibleSegments.delete(tempUint64);
                      }
                    }
                  });
                  const list = context.registerDisposer(new VirtualList({source: listSource}));
                  const updateListItems = context.registerCancellable(animationFrameDebounce(() => {
                    listSource.updateRenderedItems(list);
                  }));
                  const {displayState} = this.layer;
                  context.registerDisposer(
                      displayState.segmentSelectionState.changed.add(updateListItems));
                  context.registerDisposer(
                      displayState.visibleSegments.changed.add(updateListItems));
                  context.registerDisposer(
                      displayState.segmentColorHash.changed.add(updateListItems));
                  context.registerDisposer(
                      displayState.segmentStatedColors.changed.add(updateListItems));
                  list.element.classList.add('neuroglancer-segment-list');
                  context.registerDisposer(layer.bindSegmentListWidth(list.element));
                  context.registerDisposer(
                      new MouseEventBinder(list.element, getDefaultSelectBindings()));
                  parent.appendChild(list.element);
                }))
            .element);
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
  if (subsource.mesh !== undefined) {
    return {layerConstructor: SegmentationUserLayer, priority: 1};
  }
  return undefined;
});
