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

import 'neuroglancer/segmentation_user_layer.css';

import {CoordinateTransformSpecification, emptyValidCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {DataSourceSpecification, LocalDataSource, localEquivalencesUrl} from 'neuroglancer/datasource';
import {LayerActionContext, LinkedLayerGroup, ManagedUserLayer, registerLayerType, registerLayerTypeDetector, registerVolumeLayerType, UserLayer} from 'neuroglancer/layer';
import {layerDataSourceSpecificationFromJson, LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {MeshLayer, MeshSource, MultiscaleMeshLayer, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {RenderLayerTransform} from 'neuroglancer/render_coordinate_transform';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {augmentSegmentId, bindSegmentListWidth, makeSegmentWidget, maybeAugmentSegmentId, registerCallbackWhenSegmentationDisplayStateChanged, SegmentationColorGroupState, SegmentationDisplayState, SegmentationGroupState, SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {getPreprocessedSegmentPropertyMap, PreprocessedSegmentPropertyMap, SegmentPropertyMap} from 'neuroglancer/segmentation_display_state/property_map';
import {LocalSegmentationGraphSource} from 'neuroglancer/segmentation_graph/local';
import {SegmentationGraphSource, SegmentationGraphSourceConnection} from 'neuroglancer/segmentation_graph/source';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonRenderingOptions, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {IndirectTrackableValue, IndirectWatchableValue, makeCachedDerivedWatchableValue, makeCachedLazyDerivedWatchableValue, registerNestedSync, TrackableValue, TrackableValueInterface, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {SegmentDisplayTab} from 'neuroglancer/ui/segment_list';
import {registerSegmentSplitMergeTools} from 'neuroglancer/ui/segment_split_merge_tools';
import {DisplayOptionsTab} from 'neuroglancer/ui/segmentation_display_options_tab';
import {Uint64Map} from 'neuroglancer/uint64_map';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {packColor, parseRGBColorSpecification, serializeColor, TrackableOptionalRGB, unpackRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyFiniteNonNegativeFloat, verifyObjectAsMap, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {DependentViewContext} from 'neuroglancer/widget/dependent_view_widget';
import {LayerControlDefinition, registerLayerControl} from 'neuroglancer/widget/layer_control';
import {checkboxLayerControl} from 'neuroglancer/widget/layer_control_checkbox';
import {enumLayerControl} from 'neuroglancer/widget/layer_control_enum';
import {rangeLayerControl} from 'neuroglancer/widget/layer_control_range';
import {renderScaleLayerControl} from 'neuroglancer/widget/render_scale_widget';
import {colorSeedLayerControl, fixedColorLayerControl} from 'neuroglancer/widget/segmentation_color_mode';
import {registerLayerShaderControlsTool} from 'neuroglancer/widget/shader_controls';
import {registerSegmentSelectTools} from 'neuroglancer/ui/segment_select_tools';

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const SATURATION_JSON_KEY = 'saturation';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';
const BASE_SEGMENT_COLORING_JSON_KEY = 'baseSegmentColoring';
const IGNORE_NULL_VISIBLE_SET_JSON_KEY = 'ignoreNullVisibleSet';
const MESH_JSON_KEY = 'mesh';
const SKELETONS_JSON_KEY = 'skeletons';
const SEGMENTS_JSON_KEY = 'segments';
const EQUIVALENCES_JSON_KEY = 'equivalences';
const COLOR_SEED_JSON_KEY = 'colorSeed';
const SEGMENT_STATED_COLORS_JSON_KEY = 'segmentColors';
const MESH_RENDER_SCALE_JSON_KEY = 'meshRenderScale';
const CROSS_SECTION_RENDER_SCALE_JSON_KEY = 'crossSectionRenderScale';
const SKELETON_RENDERING_JSON_KEY = 'skeletonRendering';
const SKELETON_SHADER_JSON_KEY = 'skeletonShader';
const SEGMENT_QUERY_JSON_KEY = 'segmentQuery';
const MESH_SILHOUETTE_RENDERING_JSON_KEY = 'meshSilhouetteRendering';
const LINKED_SEGMENTATION_GROUP_JSON_KEY = 'linkedSegmentationGroup';
const LINKED_SEGMENTATION_COLOR_GROUP_JSON_KEY = 'linkedSegmentationColorGroup';
const SEGMENT_DEFAULT_COLOR_JSON_KEY = 'segmentDefaultColor';
const ANCHOR_SEGMENT_JSON_KEY = 'anchorSegment';

export const SKELETON_RENDERING_SHADER_CONTROL_TOOL_ID = 'skeletonShaderControl';

export class SegmentationUserLayerGroupState extends RefCounted implements SegmentationGroupState {
  specificationChanged = new Signal();
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {specificationChanged} = this;
    this.visibleSegments.changed.add(specificationChanged.dispatch);
    this.hideSegmentZero.changed.add(specificationChanged.dispatch);
    this.segmentQuery.changed.add(specificationChanged.dispatch);
  }

  restoreState(specification: unknown) {
    verifyOptionalObjectProperty(
        specification, HIDE_SEGMENT_ZERO_JSON_KEY,
        value => this.hideSegmentZero.restoreState(value));
    verifyOptionalObjectProperty(specification, EQUIVALENCES_JSON_KEY, value => {
      this.localGraph.restoreState(value);
    });

    verifyOptionalObjectProperty(specification, SEGMENTS_JSON_KEY, segmentsValue => {
      const {segmentEquivalences, visibleSegments} = this;
      parseArray(segmentsValue, value => {
        let id = Uint64.parseString(String(value), 10);
        visibleSegments.add(segmentEquivalences.get(id));
      });
    });
    verifyOptionalObjectProperty(
        specification, SEGMENT_QUERY_JSON_KEY, value => this.segmentQuery.restoreState(value));
  }

  toJSON() {
    const x: any = {};
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.hideSegmentZero.toJSON();
    let {visibleSegments} = this;
    if (visibleSegments.size > 0) {
      x[SEGMENTS_JSON_KEY] = visibleSegments.toJSON();
    }
    let {segmentEquivalences} = this;
    if (this.localSegmentEquivalences && segmentEquivalences.size > 0) {
      x[EQUIVALENCES_JSON_KEY] = segmentEquivalences.toJSON();
    }
    x[SEGMENT_QUERY_JSON_KEY] = this.segmentQuery.toJSON();
    return x;
  }

  assignFrom(other: SegmentationUserLayerGroupState) {
    this.maxIdLength.value = other.maxIdLength.value;
    this.hideSegmentZero.value = other.hideSegmentZero.value;
    this.visibleSegments.assignFrom(other.visibleSegments);
    this.segmentEquivalences.assignFrom(other.segmentEquivalences);
  }

  localGraph = new LocalSegmentationGraphSource();
  visibleSegments = this.registerDisposer(Uint64Set.makeWithCounterpart(this.layer.manager.rpc));
  segmentPropertyMap = new WatchableValue<PreprocessedSegmentPropertyMap|undefined>(undefined);
  graph = new WatchableValue<SegmentationGraphSource|undefined>(undefined);
  segmentEquivalences = this.registerDisposer(SharedDisjointUint64Sets.makeWithCounterpart(
      this.layer.manager.rpc,
      this.layer.registerDisposer(makeCachedDerivedWatchableValue(
          x => x !== undefined && x.highBitRepresentative, [this.graph]))));
  localSegmentEquivalences: boolean = false;
  maxIdLength = new WatchableValue(1);
  hideSegmentZero = new TrackableBoolean(true, true);
  segmentQuery = new TrackableValue<string>('', verifyString);

  temporaryVisibleSegments =
      this.layer.registerDisposer(Uint64Set.makeWithCounterpart(this.layer.manager.rpc));
  temporarySegmentEquivalences =
      this.layer.registerDisposer(SharedDisjointUint64Sets.makeWithCounterpart(
          this.layer.manager.rpc, this.segmentEquivalences.disjointSets.highBitRepresentative));
  useTemporaryVisibleSegments =
      this.layer.registerDisposer(SharedWatchableValue.make(this.layer.manager.rpc, false));
  useTemporarySegmentEquivalences =
      this.layer.registerDisposer(SharedWatchableValue.make(this.layer.manager.rpc, false));
}

export class SegmentationUserLayerColorGroupState extends RefCounted implements
    SegmentationColorGroupState {
  specificationChanged = new Signal();
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {specificationChanged} = this;
    this.segmentColorHash.changed.add(specificationChanged.dispatch);
    this.segmentStatedColors.changed.add(specificationChanged.dispatch);
    this.segmentDefaultColor.changed.add(specificationChanged.dispatch);
  }

  restoreState(specification: unknown) {
    verifyOptionalObjectProperty(
        specification, COLOR_SEED_JSON_KEY, value => this.segmentColorHash.restoreState(value));
    verifyOptionalObjectProperty(
        specification, SEGMENT_DEFAULT_COLOR_JSON_KEY,
        value => this.segmentDefaultColor.restoreState(value));
    verifyOptionalObjectProperty(specification, SEGMENT_STATED_COLORS_JSON_KEY, y => {
      let result = verifyObjectAsMap(y, x => parseRGBColorSpecification(String(x)));
      for (let [idStr, colorVec] of result) {
        const id = Uint64.parseString(String(idStr));
        const color = new Uint64(packColor(colorVec));
        this.segmentStatedColors.set(id, color);
      }
    });
  }

  toJSON() {
    const x: any = {};
    x[COLOR_SEED_JSON_KEY] = this.segmentColorHash.toJSON();
    x[SEGMENT_DEFAULT_COLOR_JSON_KEY] = this.segmentDefaultColor.toJSON();
    const {segmentStatedColors} = this;
    if (segmentStatedColors.size > 0) {
      const j: any = x[SEGMENT_STATED_COLORS_JSON_KEY] = {};
      for (const [key, value] of segmentStatedColors) {
        j[key.toString()] = serializeColor(unpackRGB(value.low));
      }
    }
    return x;
  }

  assignFrom(other: SegmentationUserLayerColorGroupState) {
    this.segmentColorHash.value = other.segmentColorHash.value;
    this.segmentStatedColors.assignFrom(other.segmentStatedColors);
    this.segmentDefaultColor.value = other.segmentDefaultColor.value;
  }

  segmentColorHash = SegmentColorHash.getDefault();
  segmentStatedColors = this.registerDisposer(new Uint64Map());
  segmentDefaultColor = new TrackableOptionalRGB();
}

class LinkedSegmentationGroupState<State extends SegmentationUserLayerGroupState|
                                   SegmentationUserLayerColorGroupState> extends RefCounted
    implements WatchableValueInterface<State> {
  private curRoot: SegmentationUserLayer|undefined;
  private curGroupState: Owned<State>|undefined;
  get changed() {
    return this.linkedGroup.root.changed;
  }
  get value() {
    const root = this.linkedGroup.root.value as SegmentationUserLayer;
    if (root !== this.curRoot) {
      this.curRoot = root;
      const groupState = root.displayState[this.propertyName] as State;
      if (root === this.linkedGroup.layer) {
        const {curGroupState} = this;
        if (curGroupState !== undefined) {
          groupState.assignFrom(curGroupState as any);
          curGroupState.dispose();
        }
      }
      this.curGroupState = groupState.addRef() as State;
    }
    return this.curGroupState!;
  }
  disposed() {
    this.curGroupState?.dispose();
  }
  constructor(public linkedGroup: LinkedLayerGroup,
              private propertyName: State extends SegmentationUserLayerGroupState?
              'originalSegmentationGroupState': 'originalSegmentationColorGroupState') {
    super();
    this.value;
  }
}

class SegmentationUserLayerDisplayState implements SegmentationDisplayState {
  constructor(public layer: SegmentationUserLayer) {
    // Even though `SegmentationUserLayer` assigns this to its `displayState` property, redundantly
    // assign it here first in order to allow it to be accessed by `segmentationGroupState`.
    layer.displayState = this;
    this.segmentationGroupState = this.layer.registerDisposer(
        new LinkedSegmentationGroupState<SegmentationUserLayerGroupState>(
            this.linkedSegmentationGroup, 'originalSegmentationGroupState'));
    this.segmentationColorGroupState = this.layer.registerDisposer(
        new LinkedSegmentationGroupState<SegmentationUserLayerColorGroupState>(
            this.linkedSegmentationColorGroup, 'originalSegmentationColorGroupState'));

    this.hideSegmentZero = this.layer.registerDisposer(
        new IndirectWatchableValue(this.segmentationGroupState, group => group.hideSegmentZero));
    this.segmentColorHash = this.layer.registerDisposer(new IndirectTrackableValue(
        this.segmentationColorGroupState, group => group.segmentColorHash));
    this.segmentStatedColors = this.layer.registerDisposer(new IndirectTrackableValue(
        this.segmentationColorGroupState, group => group.segmentStatedColors));
    this.segmentDefaultColor = this.layer.registerDisposer(new IndirectTrackableValue(
        this.segmentationColorGroupState, group => group.segmentDefaultColor));
    this.segmentQuery = this.layer.registerDisposer(
        new IndirectWatchableValue(this.segmentationGroupState, group => group.segmentQuery));
    this.segmentPropertyMap = this.layer.registerDisposer(
        new IndirectWatchableValue(this.segmentationGroupState, group => group.segmentPropertyMap));
  }

  segmentSelectionState = new SegmentSelectionState();
  selectedAlpha = trackableAlphaValue(0.5);
  saturation = trackableAlphaValue(1.0);
  notSelectedAlpha = trackableAlphaValue(0);
  silhouetteRendering = new TrackableValue<number>(0, verifyFiniteNonNegativeFloat, 0);
  objectAlpha = trackableAlphaValue(1.0);
  ignoreNullVisibleSet = new TrackableBoolean(true, true);
  skeletonRenderingOptions = new SkeletonRenderingOptions();
  shaderError = makeWatchableShaderError();
  renderScaleHistogram = new RenderScaleHistogram();
  renderScaleTarget = trackableRenderScaleTarget(1);
  selectSegment = this.layer.selectSegment;
  transparentPickEnabled = this.layer.pick;
  baseSegmentColoring = new TrackableBoolean(false, false);

  filterBySegmentLabel = this.layer.filterBySegmentLabel;

  moveToSegment = (id: Uint64) => {
    this.layer.moveToSegment(id);
  };

  linkedSegmentationGroup: LinkedLayerGroup = this.layer.registerDisposer(new LinkedLayerGroup(
      this.layer.manager.rootLayers, this.layer,
      userLayer => (userLayer instanceof SegmentationUserLayer),
      (userLayer: SegmentationUserLayer) => userLayer.displayState.linkedSegmentationGroup));

  linkedSegmentationColorGroup: LinkedLayerGroup = this.layer.registerDisposer(new LinkedLayerGroup(
      this.layer.manager.rootLayers, this.layer,
      userLayer => (userLayer instanceof SegmentationUserLayer),
      (userLayer: SegmentationUserLayer) => userLayer.displayState.linkedSegmentationColorGroup));

  originalSegmentationGroupState =
      this.layer.registerDisposer(new SegmentationUserLayerGroupState(this.layer));

  originalSegmentationColorGroupState =
      this.layer.registerDisposer(new SegmentationUserLayerColorGroupState(this.layer));

  segmentationGroupState: WatchableValueInterface<SegmentationUserLayerGroupState>;
  segmentationColorGroupState: WatchableValueInterface<SegmentationUserLayerColorGroupState>;

  // Indirect properties
  hideSegmentZero: WatchableValueInterface<boolean>;
  segmentColorHash: TrackableValueInterface<number>;
  segmentStatedColors: WatchableValueInterface<Uint64Map>;
  segmentDefaultColor: WatchableValueInterface<vec3|undefined>;
  segmentQuery: WatchableValueInterface<string>;
  segmentPropertyMap: WatchableValueInterface<PreprocessedSegmentPropertyMap|undefined>;
}

interface SegmentationActionContext extends LayerActionContext {
  // Restrict the `select` action not to both toggle on and off segments.  If segment would be
  // toggled on in at least one layer, only toggle segments on.
  segmentationToggleSegmentState?: boolean|undefined;
}

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);

  graphConnection: SegmentationGraphSourceConnection|undefined;

  bindSegmentListWidth(element: HTMLElement) {
    return bindSegmentListWidth(this.displayState, element);
  }

  segmentQueryFocusTime = new WatchableValue<number>(Number.NEGATIVE_INFINITY);

  selectSegment = (id: Uint64, pin: boolean|'toggle') => {
    this.manager.root.selectionState.captureSingleLayerState(this, state => {
      state.value = id.clone();
      return true;
    }, pin);
  };

  filterBySegmentLabel = (id: Uint64) => {
    const augmented = augmentSegmentId(this.displayState, id);
    const {label} = augmented;
    if (!label) return;
    this.filterSegments(label);
  };

  filterSegments = (query: string) => {
    this.displayState.segmentationGroupState.value.segmentQuery.value = query;
    this.segmentQueryFocusTime.value = Date.now();
    this.tabs.value = 'segments';
    this.manager.root.selectedLayer.layer = this.managedLayer;
  };

  displayState = new SegmentationUserLayerDisplayState(this);

  anchorSegment = new TrackableValue<Uint64|undefined>(
      undefined, x => x === undefined ? undefined : Uint64.parseString(x));

  constructor(managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.registerDisposer(registerNestedSync((context, group) => {
      context.registerDisposer(group.specificationChanged.add(this.specificationChanged.dispatch));
      this.specificationChanged.dispatch();
    }, this.displayState.segmentationGroupState));
    this.registerDisposer(registerNestedSync((context, group) => {
      context.registerDisposer(group.specificationChanged.add(this.specificationChanged.dispatch));
      this.specificationChanged.dispatch();
    }, this.displayState.segmentationColorGroupState));
    this.displayState.segmentSelectionState.bindTo(this.manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.saturation.changed.add(this.specificationChanged.dispatch);
    this.displayState.notSelectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.objectAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.baseSegmentColoring.changed.add(this.specificationChanged.dispatch);
    this.displayState.ignoreNullVisibleSet.changed.add(this.specificationChanged.dispatch);
    this.displayState.skeletonRenderingOptions.changed.add(this.specificationChanged.dispatch);
    this.displayState.renderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.displayState.silhouetteRendering.changed.add(this.specificationChanged.dispatch);
    this.anchorSegment.changed.add(this.specificationChanged.dispatch);
    this.sliceViewRenderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.displayState.originalSegmentationGroupState.localGraph.changed.add(
        this.specificationChanged.dispatch);
    this.displayState.linkedSegmentationGroup.changed.add(
        () => this.updateDataSubsourceActivations());
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
    const updatedSegmentPropertyMaps: SegmentPropertyMap[] = [];
    const isGroupRoot = this.displayState.linkedSegmentationGroup.root.value === this;
    let updatedGraph: SegmentationGraphSource|undefined;
    for (const loadedSubsource of subsources) {
      if (this.addStaticAnnotations(loadedSubsource)) continue;
      const {volume, mesh, segmentPropertyMap, segmentationGraph, local} =
          loadedSubsource.subsourceEntry.subsource;
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
            })),
            this.displayState.segmentationGroupState.value);
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
        }, this.displayState.segmentationGroupState.value);
      } else if (segmentPropertyMap !== undefined) {
        if (!isGroupRoot) {
          loadedSubsource.deactivate(`Not supported on non-root linked segmentation layers`);
        } else {
          loadedSubsource.activate(() => {});
          updatedSegmentPropertyMaps.push(segmentPropertyMap);
        }
      } else if (segmentationGraph !== undefined) {
        if (!isGroupRoot) {
          loadedSubsource.deactivate(`Not supported on non-root linked segmentation layers`);
        } else {
          if (updatedGraph !== undefined) {
            loadedSubsource.deactivate('Only one segmentation graph is supported');
          } else {
            updatedGraph = segmentationGraph;
            loadedSubsource.activate(refCounted => {
              this.graphConnection = refCounted.registerDisposer(
                  segmentationGraph.connect(this.displayState.segmentationGroupState.value));
              refCounted.registerDisposer(() => {
                this.graphConnection = undefined;
              });
            });
          }
        }
      } else if (local === LocalDataSource.equivalences) {
        if (!isGroupRoot) {
          loadedSubsource.deactivate(`Not supported on non-root linked segmentation layers`);
        } else {
          if (updatedGraph !== undefined) {
            loadedSubsource.deactivate('Only one segmentation graph is supported');
          } else {
            updatedGraph = this.displayState.originalSegmentationGroupState.localGraph;
            loadedSubsource.activate(refCounted => {
              this.graphConnection = refCounted.registerDisposer(
                  updatedGraph!.connect(this.displayState.segmentationGroupState.value));
              refCounted.registerDisposer(() => {
                this.graphConnection = undefined;
              });
            });
          }
        }
      } else {
        loadedSubsource.deactivate('Not compatible with segmentation layer');
      }
    }
    this.displayState.originalSegmentationGroupState.segmentPropertyMap.value =
        getPreprocessedSegmentPropertyMap(this.manager.chunkManager, updatedSegmentPropertyMaps);
    this.displayState.originalSegmentationGroupState.graph.value = updatedGraph;
  }

  getLegacyDataSourceSpecifications(
      sourceSpec: any, layerSpec: any, legacyTransform: CoordinateTransformSpecification|undefined,
      explicitSpecs: DataSourceSpecification[]): DataSourceSpecification[] {
    const specs = super.getLegacyDataSourceSpecifications(
        sourceSpec, layerSpec, legacyTransform, explicitSpecs);
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
    if (layerSpec[EQUIVALENCES_JSON_KEY] !== undefined &&
        explicitSpecs.find(spec => spec.url === localEquivalencesUrl) === undefined) {
      specs.push({
        url: localEquivalencesUrl,
        enableDefaultSubsources: true,
        transform: {
          outputSpace: emptyValidCoordinateSpace,
          sourceRank: 0,
          transform: undefined,
          inputSpace: emptyValidCoordinateSpace
        },
        subsources: new Map(),
      });
    }
    return specs;
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.displayState.selectedAlpha.restoreState(specification[SELECTED_ALPHA_JSON_KEY]);
    this.displayState.saturation.restoreState(specification[SATURATION_JSON_KEY]);
    this.displayState.notSelectedAlpha.restoreState(specification[NOT_SELECTED_ALPHA_JSON_KEY]);
    this.displayState.objectAlpha.restoreState(specification[OBJECT_ALPHA_JSON_KEY]);
    this.displayState.baseSegmentColoring.restoreState(
        specification[BASE_SEGMENT_COLORING_JSON_KEY]);
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
    this.displayState.renderScaleTarget.restoreState(specification[MESH_RENDER_SCALE_JSON_KEY]);
    this.anchorSegment.restoreState(specification[ANCHOR_SEGMENT_JSON_KEY]);
    this.sliceViewRenderScaleTarget.restoreState(
        specification[CROSS_SECTION_RENDER_SCALE_JSON_KEY]);
    const linkedSegmentationGroupName = verifyOptionalObjectProperty(
        specification, LINKED_SEGMENTATION_GROUP_JSON_KEY, verifyString);
    if (linkedSegmentationGroupName !== undefined) {
      this.displayState.linkedSegmentationGroup.linkByName(linkedSegmentationGroupName);
    }
    const linkedSegmentationColorGroupName = verifyOptionalObjectProperty(
        specification, LINKED_SEGMENTATION_COLOR_GROUP_JSON_KEY,
        x => x === false ? undefined : verifyString(x), linkedSegmentationGroupName);
    if (linkedSegmentationColorGroupName !== undefined) {
      this.displayState.linkedSegmentationColorGroup.linkByName(linkedSegmentationColorGroupName);
    }
    this.displayState.segmentationGroupState.value.restoreState(specification);
    this.displayState.segmentationColorGroupState.value.restoreState(specification);
  }

  toJSON() {
    const x = super.toJSON();
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[BASE_SEGMENT_COLORING_JSON_KEY] = this.displayState.baseSegmentColoring.toJSON();
    x[IGNORE_NULL_VISIBLE_SET_JSON_KEY] = this.displayState.ignoreNullVisibleSet.toJSON();
    x[MESH_SILHOUETTE_RENDERING_JSON_KEY] = this.displayState.silhouetteRendering.toJSON();
    x[ANCHOR_SEGMENT_JSON_KEY] = this.anchorSegment.toJSON();
    x[SKELETON_RENDERING_JSON_KEY] = this.displayState.skeletonRenderingOptions.toJSON();
    x[MESH_RENDER_SCALE_JSON_KEY] = this.displayState.renderScaleTarget.toJSON();
    x[CROSS_SECTION_RENDER_SCALE_JSON_KEY] = this.sliceViewRenderScaleTarget.toJSON();

    const {linkedSegmentationGroup, linkedSegmentationColorGroup} = this.displayState;
    x[LINKED_SEGMENTATION_GROUP_JSON_KEY] = linkedSegmentationGroup.toJSON();
    if (linkedSegmentationColorGroup.root.value !== linkedSegmentationGroup.root.value) {
      x[LINKED_SEGMENTATION_COLOR_GROUP_JSON_KEY] = linkedSegmentationColorGroup.toJSON() ?? false;
    }
    x[EQUIVALENCES_JSON_KEY] = this.displayState.originalSegmentationGroupState.localGraph.toJSON();
    if (linkedSegmentationGroup.root.value === this) {
      Object.assign(x, this.displayState.segmentationGroupState.value.toJSON());
    }
    if (linkedSegmentationColorGroup.root.value === this) {
      Object.assign(x, this.displayState.segmentationColorGroupState.value.toJSON());
    }
    return x;
  }

  transformPickedValue(value: any) {
    if (value == null) {
      return value;
    }
    // Must copy, because `value` may be a temporary Uint64 returned by PickIDManager.
    return maybeAugmentSegmentId(this.displayState, value, /*mustCopy=*/ true);
  }

  handleAction(action: string, context: SegmentationActionContext) {
    switch (action) {
      case 'recolor': {
        this.displayState.segmentationColorGroupState.value.segmentColorHash.randomize();
        break;
      }
      case 'clear-segments': {
        if (!this.pick.value) break;
        this.displayState.segmentationGroupState.value.visibleSegments.clear();
        break;
      }
      case 'select': {
        if (!this.pick.value) break;
        const {segmentSelectionState} = this.displayState;
        if (segmentSelectionState.hasSelectedSegment) {
          const segment = segmentSelectionState.selectedSegment;
          const {visibleSegments} = this.displayState.segmentationGroupState.value;
          const newVisible = !visibleSegments.has(segment);
          if (newVisible || context.segmentationToggleSegmentState === undefined) {
            context.segmentationToggleSegmentState = newVisible;
          }
          context.defer(() => {
            if (context.segmentationToggleSegmentState === newVisible) {
              visibleSegments.set(segment, newVisible);
            }
          });
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
      state: this['selectionState'], parent: HTMLElement, context: DependentViewContext): boolean {
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
    const {displayState} = this;
    const normalizedId = augmentSegmentId(displayState, id);
    const {
      segmentEquivalences,
      segmentPropertyMap: {value: segmentPropertyMap},
    } = this.displayState.segmentationGroupState.value;
    const mapped = segmentEquivalences.get(id);
    const row = makeSegmentWidget(this.displayState, normalizedId);
    registerCallbackWhenSegmentationDisplayStateChanged(displayState, context, context.redraw);
    context.registerDisposer(bindSegmentListWidth(displayState, row));
    row.classList.add('neuroglancer-selection-details-segment');
    parent.appendChild(row);

    if (segmentPropertyMap !== undefined) {
      const {inlineProperties} = segmentPropertyMap.segmentPropertyMap;
      if (inlineProperties !== undefined) {
        const index = segmentPropertyMap.getSegmentInlineIndex(mapped);
        if (index !== -1) {
          for (const property of inlineProperties.properties) {
            if (property.type === 'label') continue;
            if (property.type === 'description') {
              const value = property.values[index];
              if (!value) continue;
              const descriptionElement = document.createElement('div');
              descriptionElement.classList.add(
                  'neuroglancer-selection-details-segment-description');
              descriptionElement.textContent = value;
              parent.appendChild(descriptionElement);
            } else if (property.type === 'number' || property.type === 'string') {
              const value = property.values[index];
              if (property.type === 'number' ? isNaN(value as number) : !value) continue;
              const propertyElement = document.createElement('div');
              propertyElement.classList.add('neuroglancer-selection-details-segment-property');
              const nameElement = document.createElement('div');
              nameElement.classList.add('neuroglancer-selection-details-segment-property-name');
              nameElement.textContent = property.id;
              if (property.description) {
                nameElement.title = property.description;
              }
              const valueElement = document.createElement('div');
              valueElement.classList.add('neuroglancer-selection-details-segment-property-value');
              valueElement.textContent = value.toString();
              propertyElement.appendChild(nameElement);
              propertyElement.appendChild(valueElement);
              parent.appendChild(propertyElement);
            }
          }
        }
      }
    }
    return true;
  }

  displaySelectionState(
      state: this['selectionState'], parent: HTMLElement, context: DependentViewContext): boolean {
    let displayed = this.displaySegmentationSelection(state, parent, context);
    if (super.displaySelectionState(state, parent, context)) displayed = true;
    return displayed;
  }

  moveToSegment(id: Uint64) {
    for (const layer of this.renderLayers) {
      if (!(layer instanceof MultiscaleMeshLayer)) continue;
      const layerPosition = layer.getObjectPosition(id);
      if (layerPosition === undefined) continue;
      this.setLayerPosition(
          layer.displayState.transform.value as RenderLayerTransform, layerPosition);
      return;
    }
    StatusMessage.showTemporaryMessage(`No position information loaded for segment ${id}`);
  }

  static type = 'segmentation';
  static typeAbbreviation = 'seg';
  static supportsPickOption = true;
}

const maxSilhouettePower = 10;

function getViewSpecificSkeletonRenderingControl(viewName: '2d'|'3d'):
    LayerControlDefinition<SegmentationUserLayer>[] {
  return [
    {
      label: `Skeleton mode (${viewName})`,
      toolJson: `${SKELETON_RENDERING_JSON_KEY}.mode${viewName}`,
      isValid: layer => layer.hasSkeletonsLayer,
      ...enumLayerControl(

          layer => layer.displayState.skeletonRenderingOptions[`params${viewName}` as const].mode),
    },
    {
      label: `Line width (${viewName})`,
      toolJson: `${SKELETON_RENDERING_JSON_KEY}.lineWidth${viewName}`,
      isValid: layer => layer.hasSkeletonsLayer,
      toolDescription: `Skeleton line width (${viewName})`,
      title: `Skeleton line width (${viewName})`,
      ...rangeLayerControl(

          layer => ({
            value:
                layer.displayState.skeletonRenderingOptions[`params${viewName}` as const].lineWidth,
            options: {min: 1, max: 40, step: 1},
          })),
    },
  ];
}

export const LAYER_CONTROLS: LayerControlDefinition<SegmentationUserLayer>[] = [
  {
    label: 'Color seed',
    title: 'Color segments based on a hash of their id',
    toolJson: COLOR_SEED_JSON_KEY,
    ...colorSeedLayerControl(),
  },
  {
    label: 'Fixed color',
    title: 'Use a fixed color for all segments without an explicitly-specified color',
    toolJson: SEGMENT_DEFAULT_COLOR_JSON_KEY,
    ...fixedColorLayerControl(),
  },
  {
    label: 'Saturation',
    toolJson: SATURATION_JSON_KEY,
    title: 'Saturation of segment colors',
    ...rangeLayerControl(layer => ({value: layer.displayState.saturation})),
  },
  {
    label: 'Opacity (on)',
    toolJson: SELECTED_ALPHA_JSON_KEY,
    isValid: layer => layer.has2dLayer,
    title: 'Opacity in cross-section views of segments that are selected',
    ...rangeLayerControl(layer => ({value: layer.displayState.selectedAlpha})),
  },
  {
    label: 'Opacity (off)',
    toolJson: NOT_SELECTED_ALPHA_JSON_KEY,
    isValid: layer => layer.has2dLayer,
    title: 'Opacity in cross-section views of segments that are not selected',
    ...rangeLayerControl(layer => ({value: layer.displayState.notSelectedAlpha})),
  },
  {
    label: 'Resolution (slice)',
    toolJson: CROSS_SECTION_RENDER_SCALE_JSON_KEY,
    isValid: layer => layer.has2dLayer,
    ...renderScaleLayerControl(layer => ({
                                 histogram: layer.sliceViewRenderScaleHistogram,
                                 target: layer.sliceViewRenderScaleTarget
                               })),
  },
  {
    label: 'Resolution (mesh)',
    toolJson: MESH_RENDER_SCALE_JSON_KEY,
    isValid: layer => layer.has3dLayer,
    ...renderScaleLayerControl(layer => ({
                                 histogram: layer.displayState.renderScaleHistogram,
                                 target: layer.displayState.renderScaleTarget
                               })),
  },
  {
    label: 'Opacity (3d)',
    toolJson: OBJECT_ALPHA_JSON_KEY,
    isValid: layer => layer.has3dLayer,
    title: 'Opacity of meshes and skeletons',
    ...rangeLayerControl(layer => ({value: layer.displayState.objectAlpha})),
  },
  {
    label: 'Silhouette (3d)',
    toolJson: MESH_SILHOUETTE_RENDERING_JSON_KEY,
    isValid: layer => layer.has3dLayer,
    title:
        'Set to a non-zero value to increase transparency of object faces perpendicular to view direction',
    ...rangeLayerControl(layer => ({
                           value: layer.displayState.silhouetteRendering,
                           options: {min: 0, max: maxSilhouettePower, step: 0.1}
                         })),
  },
  {
    label: 'Hide segment ID 0',
    toolJson: HIDE_SEGMENT_ZERO_JSON_KEY,
    title: 'Disallow selection and display of segment id 0',
    ...checkboxLayerControl(layer => layer.displayState.hideSegmentZero),
  },
  {
    label: 'Base segment coloring',
    toolJson: BASE_SEGMENT_COLORING_JSON_KEY,
    title: 'Color base segments individually',
    ...checkboxLayerControl(layer => layer.displayState.baseSegmentColoring),
  },
  {
    label: 'Show all by default',
    title: 'Show all segments if none are selected',
    toolJson: IGNORE_NULL_VISIBLE_SET_JSON_KEY,
    ...checkboxLayerControl(layer => layer.displayState.ignoreNullVisibleSet),
  },
  ...getViewSpecificSkeletonRenderingControl('2d'),
  ...getViewSpecificSkeletonRenderingControl('3d'),
];

for (const control of LAYER_CONTROLS) {
  registerLayerControl(SegmentationUserLayer, control);
}

registerLayerType(SegmentationUserLayer);
registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);
registerLayerTypeDetector(subsource => {
  if (subsource.mesh !== undefined) {
    return {layerConstructor: SegmentationUserLayer, priority: 1};
  }
  return undefined;
});

registerLayerShaderControlsTool(
    SegmentationUserLayer,
    layer => ({
      shaderControlState: layer.displayState.skeletonRenderingOptions.shaderControlState,
    }),
    SKELETON_RENDERING_SHADER_CONTROL_TOOL_ID);

registerSegmentSplitMergeTools();
registerSegmentSelectTools();
