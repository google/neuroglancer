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

import {CoordinateTransformSpecification} from 'neuroglancer/coordinate_transform';
import {DataSourceSpecification} from 'neuroglancer/datasource';
import {LayerActionContext, LinkedLayerGroup, ManagedUserLayer, registerLayerType, registerLayerTypeDetector, registerVolumeLayerType, UserLayer} from 'neuroglancer/layer';
import {layerDataSourceSpecificationFromJson, LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {MeshLayer, MeshSource, MultiscaleMeshLayer, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {RenderLayerTransform} from 'neuroglancer/render_coordinate_transform';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {augmentSegmentId, bindSegmentListWidth, makeSegmentWidget, maybeAugmentSegmentId, registerCallbackWhenSegmentationDisplayStateChanged, SegmentationColorGroupState, SegmentationDisplayState, SegmentationGroupState, SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {getPreprocessedSegmentPropertyMap, PreprocessedSegmentPropertyMap, SegmentPropertyMap} from 'neuroglancer/segmentation_display_state/property_map';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonRenderingOptions, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {DataType, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {IndirectTrackableValue, IndirectWatchableValue, makeCachedLazyDerivedWatchableValue, registerNestedSync, TrackableValue, TrackableValueInterface, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {SegmentDisplayTab} from 'neuroglancer/ui/segment_list';
import {DisplayOptionsTab} from 'neuroglancer/ui/segmentation_display_options_tab';
import {Uint64Map} from 'neuroglancer/uint64_map';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {packColor, parseRGBColorSpecification, serializeColor, TrackableOptionalRGB, unpackRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyFiniteNonNegativeFloat, verifyObjectAsMap, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {DependentViewContext} from 'neuroglancer/widget/dependent_view_widget';

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const SATURATION_JSON_KEY = 'saturation';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';
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

const SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY = 'shatterSegmentEquivalences';
const ROOT_SEGMENTS_JSON_KEY = 'segments';
const HIDDEN_ROOT_SEGMENTS_JSON_KEY = 'hiddenSegments';


const lastSegmentSelection = new Uint64();

export class SegmentationUserLayerGroupState extends RefCounted implements SegmentationGroupState {
  specificationChanged = new Signal();
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {specificationChanged} = this;
    this.visibleSegments3D.changed.add(specificationChanged.dispatch);
    this.segmentEquivalences.changed.add(specificationChanged.dispatch);
    this.hideSegmentZero.changed.add(specificationChanged.dispatch);
    this.segmentQuery.changed.add(specificationChanged.dispatch);

    this.visibleSegments2D.changed.add(specificationChanged.dispatch);
  }

  restoreState(specification: unknown) {
    verifyOptionalObjectProperty(
        specification, HIDE_SEGMENT_ZERO_JSON_KEY,
        value => this.hideSegmentZero.restoreState(value));
    verifyOptionalObjectProperty(specification, EQUIVALENCES_JSON_KEY, value => {
      this.segmentEquivalences.restoreState(value);
    });

    verifyOptionalObjectProperty(specification, SEGMENTS_JSON_KEY, segmentsValue => {
      const {segmentEquivalences, visibleSegments3D} = this;
      parseArray(segmentsValue, value => {
        let id = Uint64.parseString(String(value), 10);
        visibleSegments3D.add(segmentEquivalences.get(id));
      });
    });
    verifyOptionalObjectProperty(
        specification, SEGMENT_QUERY_JSON_KEY, value => this.segmentQuery.restoreState(value));
    
    const restoreSegmentsList = (key: string, segments: Uint64Set) => {
      verifyObjectProperty(specification, key, y => {
        if (y !== undefined) {
          let {segmentEquivalences} = this;
          parseArray(y, value => {
            let id = Uint64.parseString(String(value), 10);
            segments.add(segmentEquivalences.get(id));
          });
        }
      });
    };

    restoreSegmentsList(ROOT_SEGMENTS_JSON_KEY, this.rootSegments);
    restoreSegmentsList(HIDDEN_ROOT_SEGMENTS_JSON_KEY, this.hiddenRootSegments!);
  }

  toJSON() {
    const x: any = {};
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.hideSegmentZero.toJSON();
    let {visibleSegments3D: visibleSegments} = this; // TODO should this block be commented out?
    if (visibleSegments.size > 0) {
      x[SEGMENTS_JSON_KEY] = visibleSegments.toJSON();
    }
    let {segmentEquivalences} = this;
    if (segmentEquivalences.size > 0) {
      x[EQUIVALENCES_JSON_KEY] = segmentEquivalences.toJSON();
    }
    x[SEGMENT_QUERY_JSON_KEY] = this.segmentQuery.toJSON();

    x[SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY] =
      this.shatterSegmentEquivalences.toJSON();

    let {rootSegments} = this;
    if (rootSegments.size > 0) {
      x[ROOT_SEGMENTS_JSON_KEY] = rootSegments.toJSON();
    }
    let {hiddenRootSegments} = this;
    if (hiddenRootSegments.size > 0) {
      x[HIDDEN_ROOT_SEGMENTS_JSON_KEY] = hiddenRootSegments.toJSON();  
    }

    return x;
  }

  assignFrom(other: SegmentationUserLayerGroupState) {
    this.maxIdLength.value = other.maxIdLength.value;
    this.hideSegmentZero.value = other.hideSegmentZero.value;
    this.visibleSegments3D.assignFrom(other.visibleSegments3D);
    this.segmentEquivalences.assignFrom(other.segmentEquivalences);
  }

  visibleSegments3D = this.registerDisposer(Uint64Set.makeWithCounterpart(this.layer.manager.rpc));
  segmentPropertyMap = new WatchableValue<PreprocessedSegmentPropertyMap|undefined>(undefined);
  segmentEquivalences =
      this.registerDisposer(SharedDisjointUint64Sets.makeWithCounterpart(this.layer.manager.rpc));
  maxIdLength = new WatchableValue(1);
  hideSegmentZero = new TrackableBoolean(true, true);
  segmentQuery = new TrackableValue<string>('', verifyString);

  visibleSegments2D = new Uint64Set();
  rootSegments = this.registerDisposer(Uint64Set.makeWithCounterpart(this.layer.manager.rpc));
  rootSegmentsAfterEdit = this.registerDisposer(Uint64Set.makeWithCounterpart(this.layer.manager.rpc));
  hiddenRootSegments = new Uint64Set();
  shatterSegmentEquivalences = new TrackableBoolean(false, false);
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

export class SegmentationUserLayerDisplayState implements SegmentationDisplayState {
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

  shatterSegmentEquivalences = new TrackableBoolean(false, false);

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

  selectSegment2() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.selectedSegment;
      let {rootSegments} = this.displayState.segmentationGroupState.value;
      if (rootSegments.has(segment)) {
        rootSegments.delete(segment);
      } else {
        rootSegments.add(segment);
      }
    }
  };

  mergeSelectFirst() {
    const {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      lastSegmentSelection.assign(segmentSelectionState.rawSelectedSegment);
      StatusMessage.showTemporaryMessage(
          `Selected ${lastSegmentSelection} as source for merge. Pick a sink.`, 3000);
    }
  }

  mergeSelectSecond() {
    const {segmentSelectionState} = this.displayState;
    const {segmentEquivalences, rootSegments, visibleSegments3D} = this.displayState.segmentationGroupState.value;
    if (segmentSelectionState.hasSelectedSegment) {
      // Merge both selected segments
      const segment = segmentSelectionState.rawSelectedSegment.clone();
      segmentEquivalences.link(lastSegmentSelection, segment);

      // Cleanup by removing superseded root segments
      const newRootSegment = segmentEquivalences.get(segment);
      const equivalentSegments = [...segmentEquivalences.setElements(newRootSegment)];
      rootSegments.delete(equivalentSegments.filter(
          id => rootSegments.has(id) && !Uint64.equal(id, newRootSegment)));

      // Ensure merged group will be fully visible
      if (rootSegments.has(newRootSegment)) {
        visibleSegments3D.add(equivalentSegments);
      } else {
        rootSegments.add(newRootSegment);
      }
    }
  }

  splitSelectFirst() {
    StatusMessage.showTemporaryMessage('Cut without graph server not yet implemented.', 3000);
  }

  splitSelectSecond() {
    StatusMessage.showTemporaryMessage('Cut without graph server not yet implemented.', 3000);
  }

  rootSegmentChange(rootSegments: Uint64[]|null, added: boolean) {
    const {visibleSegments2D, visibleSegments3D, segmentEquivalences, rootSegments: prevRootSegments} = this.displayState.segmentationGroupState.value;

    if (rootSegments === null) {
      if (added) {
        return;
      } else {
        visibleSegments2D!.clear();
        visibleSegments3D.clear();
      }
    } else if (added) {
      const segments = rootSegments.flatMap(
          rootSegment => [...segmentEquivalences.setElements(rootSegment)]);
      visibleSegments2D!.add(rootSegments!);
      visibleSegments3D.add(segments);
    } else if (!added) {
      for (const rootSegment of rootSegments) {
        const equivalentSegments =
            [...segmentEquivalences.setElements(rootSegment)];
        let removeVisibleSegments = true;
        for (const equivalentSegment of equivalentSegments) {
          if (prevRootSegments.has(equivalentSegment)) {
            removeVisibleSegments = false;
            break;
          }
        }
        if (removeVisibleSegments) {
          visibleSegments2D!.delete(rootSegment);
          visibleSegments3D.delete(equivalentSegments);
        }
      }
    }
    this.specificationChanged.dispatch();
  }

  // restoreSegmentMetadata( voxel count stuff?
  //     segmentToVoxelCountMap: SegmentToVoxelCountMap, segmentCategoriesObj: any,
  //     categorizedSegmentsObj: any) {
  //   this.segmentMetadata = SegmentMetadata.restoreState(
  //       segmentToVoxelCountMap, segmentCategoriesObj, categorizedSegmentsObj);
  //   this.segmentMetadata.changed.add(this.specificationChanged.dispatch);
  //   this.objectLayerStateChanged.dispatch();
  // }

  displayState = new SegmentationUserLayerDisplayState(this);

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
    this.displayState.ignoreNullVisibleSet.changed.add(this.specificationChanged.dispatch);
    this.displayState.skeletonRenderingOptions.changed.add(this.specificationChanged.dispatch);
    this.displayState.renderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.displayState.silhouetteRendering.changed.add(this.specificationChanged.dispatch);
    this.sliceViewRenderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.displayState.linkedSegmentationGroup.changed.add(
        () => this.updateDataSubsourceActivations());
    this.tabs.add(
        'rendering', {label: 'Render', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.add(
        'segments', {label: 'Seg.', order: -50, getter: () => new SegmentDisplayTab(this)});
    this.tabs.default = 'rendering';

    this.displayState.segmentationGroupState.value.rootSegments.changed.add((segmentIds: Uint64[]|Uint64|null, add: boolean) => {
      if (segmentIds !== null) {
        segmentIds = Array<Uint64>().concat(segmentIds);
      }
      this.rootSegmentChange(segmentIds, add);
    });

    this.displayState.segmentationGroupState.value.shatterSegmentEquivalences.changed.add(this.specificationChanged.dispatch);

    // this.ignoreSegmentInteractions.changed.add(this.specificationChanged.dispatch); not doing this yet
  }

  get volumeOptions() {
    return {volumeType: VolumeType.SEGMENTATION};
  }

  someRenderLayer() {
    for (let x of this.renderLayers) {
      if (x instanceof MeshLayer || x instanceof MultiscaleMeshLayer) {
        return x;
      }
    }

    return undefined;
  }

  someSegmentationRenderLayer() {
    for (let x of this.renderLayers) {
      if (x instanceof SegmentationRenderLayer) {
        return x;
      }
    }

    return undefined;
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
              shatterSegmentEquivalences: new TrackableBoolean(false, false), // ...
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
      } else {
        loadedSubsource.deactivate('Not compatible with segmentation layer');
      }
    }
    this.displayState.originalSegmentationGroupState.segmentPropertyMap.value =
        getPreprocessedSegmentPropertyMap(this.manager.chunkManager, updatedSegmentPropertyMaps);
  }

  getLegacyDataSourceSpecifications(
      sourceSpec: any, layerSpec: any,
      legacyTransform: CoordinateTransformSpecification|undefined): DataSourceSpecification[] {
    const specs = super.getLegacyDataSourceSpecifications(sourceSpec, layerSpec, legacyTransform);
    const meshPath = verifyOptionalObjectProperty(
        layerSpec, MESH_JSON_KEY, x => x === null ? null : verifyString(x));
    const skeletonsPath = verifyOptionalObjectProperty(
        layerSpec, SKELETONS_JSON_KEY, x => x === null ? null : verifyString(x));
    // const segmentToVoxelCountMapPath = this.segmentToVoxelCountMapPath = // is this segmentToVoxelCountMapPath stuff necessary?
    //     verifyOptionalString(specification[SEGMENTS_TO_VOXEL_COUNT_MAP_PATH_JSON_KEY]);
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

    this.displayState.segmentationGroupState.value.shatterSegmentEquivalences.restoreState(
      specification[SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY]);
  }

  toJSON() {
    const x = super.toJSON();
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[IGNORE_NULL_VISIBLE_SET_JSON_KEY] = this.displayState.ignoreNullVisibleSet.toJSON();
    x[MESH_SILHOUETTE_RENDERING_JSON_KEY] = this.displayState.silhouetteRendering.toJSON();
    x[SKELETON_RENDERING_JSON_KEY] = this.displayState.skeletonRenderingOptions.toJSON();
    x[MESH_RENDER_SCALE_JSON_KEY] = this.displayState.renderScaleTarget.toJSON();
    x[CROSS_SECTION_RENDER_SCALE_JSON_KEY] = this.sliceViewRenderScaleTarget.toJSON();

    const {linkedSegmentationGroup, linkedSegmentationColorGroup} = this.displayState;
    x[LINKED_SEGMENTATION_GROUP_JSON_KEY] = linkedSegmentationGroup.toJSON();
    if (linkedSegmentationColorGroup.root.value !== linkedSegmentationGroup.root.value) {
      x[LINKED_SEGMENTATION_COLOR_GROUP_JSON_KEY] = linkedSegmentationColorGroup.toJSON() ?? false;
    }
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
    // if (this.ignoreSegmentInteractions.value) {

      // const disposeUndoRedoAfterEdit = () => {

    switch (action) {
      case 'recolor': {
        this.displayState.segmentationColorGroupState.value.segmentColorHash.randomize();
        break;
      }
      case 'clear-segments': {
        if (!this.pick.value) break;
        this.displayState.segmentationGroupState.value.rootSegments.clear();
        this.displayState.segmentationGroupState.value.visibleSegments3D.clear();
        this.displayState.segmentationGroupState.value.visibleSegments2D.clear();
        this.displayState.segmentationGroupState.value.segmentEquivalences.clear();
        break;
      }
      case 'select': {
        this.selectSegment2();
        // if (!this.pick.value) break;
        // const {segmentSelectionState} = this.displayState;
        // if (segmentSelectionState.hasSelectedSegment) {
        //   const segment = segmentSelectionState.selectedSegment;
        //   const {visibleSegments3D} = this.displayState.segmentationGroupState.value;
        //   const newVisible = !visibleSegments3D.has(segment);
        //   if (newVisible || context.segmentationToggleSegmentState === undefined) {
        //     context.segmentationToggleSegmentState = newVisible;
        //   }
        //   context.defer(() => {
        //     if (context.segmentationToggleSegmentState === newVisible) {
        //       visibleSegments3D.set(segment, newVisible);
        //     }
        //   });
        // }
        break;
      }
      case 'merge-select-first': {
        this.mergeSelectFirst();
        break;
      }
      case 'merge-select-second': {
        this.mergeSelectSecond();
        // disposeUndoRedoAfterEdit();
        break;
      }
      case 'split-select-first': {
        this.splitSelectFirst();
        break;
      }
      case 'split-select-second': {
        this.splitSelectSecond();
        break;
      }
      case 'shatter-segment-equivalences': {
        this.displayState.segmentationGroupState.value.shatterSegmentEquivalences.value =
            !this.displayState.segmentationGroupState.value.shatterSegmentEquivalences.value;
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

registerLayerType(SegmentationUserLayer);
registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);
registerLayerTypeDetector(subsource => {
  if (subsource.mesh !== undefined) {
    return {layerConstructor: SegmentationUserLayer, priority: 1};
  }
  return undefined;
});
