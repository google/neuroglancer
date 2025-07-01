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

import "#src/layer/segmentation/style.css";

import type { CoordinateTransformSpecification } from "#src/coordinate_transform.js";
import { emptyValidCoordinateSpace } from "#src/coordinate_transform.js";
import type { DataSourceSpecification } from "#src/datasource/index.js";
import {
  LocalDataSource,
  localEquivalencesUrl,
} from "#src/datasource/local.js";
import type { LayerActionContext, ManagedUserLayer } from "#src/layer/index.js";
import {
  LinkedLayerGroup,
  registerLayerType,
  registerLayerTypeDetector,
  registerVolumeLayerType,
  UserLayer,
} from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { layerDataSourceSpecificationFromJson } from "#src/layer/layer_data_source.js";
import * as json_keys from "#src/layer/segmentation/json_keys.js";
import { registerLayerControls } from "#src/layer/segmentation/layer_controls.js";
import {
  MeshLayer,
  MeshSource,
  MultiscaleMeshLayer,
  MultiscaleMeshSource,
} from "#src/mesh/frontend.js";
import {
  RenderScaleHistogram,
  trackableRenderScaleTarget,
} from "#src/render_scale_statistics.js";
import { SegmentColorHash } from "#src/segment_color.js";
import type {
  SegmentationColorGroupState,
  SegmentationDisplayState,
  SegmentationGroupState,
} from "#src/segmentation_display_state/frontend.js";
import {
  augmentSegmentId,
  bindSegmentListWidth,
  makeSegmentWidget,
  maybeAugmentSegmentId,
  registerCallbackWhenSegmentationDisplayStateChanged,
  SegmentSelectionState,
  Uint64MapEntry,
} from "#src/segmentation_display_state/frontend.js";
import type {
  PreprocessedSegmentPropertyMap,
  SegmentPropertyMap,
} from "#src/segmentation_display_state/property_map.js";
import { getPreprocessedSegmentPropertyMap } from "#src/segmentation_display_state/property_map.js";
import { LocalSegmentationGraphSource } from "#src/segmentation_graph/local.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type {
  SegmentationGraphSource,
  SegmentationGraphSourceConnection,
} from "#src/segmentation_graph/source.js";
import { SegmentationGraphSourceTab } from "#src/segmentation_graph/source.js";
import { SharedDisjointUint64Sets } from "#src/shared_disjoint_sets.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import {
  PerspectiveViewSkeletonLayer,
  SkeletonLayer,
  SkeletonRenderingOptions,
  SliceViewPanelSkeletonLayer,
} from "#src/skeleton/frontend.js";
import { DataType, VolumeType } from "#src/sliceview/volume/base.js";
import { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { StatusMessage } from "#src/status.js";
import { trackableAlphaValue } from "#src/trackable_alpha.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type {
  TrackableValueInterface,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import {
  IndirectTrackableValue,
  IndirectWatchableValue,
  makeCachedDerivedWatchableValue,
  makeCachedLazyDerivedWatchableValue,
  registerNestedSync,
  TrackableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import { UserLayerWithAnnotationsMixin } from "#src/ui/annotations.js";
import { SegmentDisplayTab } from "#src/ui/segment_list.js";
import { registerSegmentSelectTools } from "#src/ui/segment_select_tools.js";
import { registerSegmentSplitMergeTools } from "#src/ui/segment_split_merge_tools.js";
import { DisplayOptionsTab } from "#src/ui/segmentation_display_options_tab.js";
import { Uint64Map } from "#src/uint64_map.js";
import { Uint64OrderedSet } from "#src/uint64_ordered_set.js";
import { Uint64Set } from "#src/uint64_set.js";
import { gatherUpdate } from "#src/util/array.js";
import {
  packColor,
  parseRGBColorSpecification,
  serializeColor,
  TrackableOptionalRGB,
  unpackRGB,
} from "#src/util/color.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { vec3, vec4 } from "#src/util/geom.js";
import {
  parseArray,
  parseUint64,
  verifyFiniteNonNegativeFloat,
  verifyObjectAsMap,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { Signal } from "#src/util/signal.js";
import { makeWatchableShaderError } from "#src/webgl/dynamic_shader.js";
import type { DependentViewContext } from "#src/widget/dependent_view_widget.js";
import { registerLayerShaderControlsTool } from "#src/widget/shader_controls.js";

export class SegmentationUserLayerGroupState
  extends RefCounted
  implements SegmentationGroupState
{
  specificationChanged = new Signal();
  constructor(public layer: SegmentationUserLayer) {
    super();
    const { specificationChanged } = this;
    this.hideSegmentZero.changed.add(specificationChanged.dispatch);
    this.allowBrush.changed.add(specificationChanged.dispatch);
    this.segmentQuery.changed.add(specificationChanged.dispatch);

    const { selectedSegments } = this;
    const visibleSegments = (this.visibleSegments = this.registerDisposer(
      Uint64Set.makeWithCounterpart(layer.manager.rpc),
    ));
    this.segmentEquivalences = this.registerDisposer(
      SharedDisjointUint64Sets.makeWithCounterpart(
        layer.manager.rpc,
        layer.registerDisposer(
          makeCachedDerivedWatchableValue(
            (x) =>
              x?.visibleSegmentEquivalencePolicy ||
              VisibleSegmentEquivalencePolicy.MIN_REPRESENTATIVE,
            [this.graph],
          ),
        ),
      ),
    );

    this.temporaryVisibleSegments = layer.registerDisposer(
      Uint64Set.makeWithCounterpart(layer.manager.rpc),
    );
    this.temporarySegmentEquivalences = layer.registerDisposer(
      SharedDisjointUint64Sets.makeWithCounterpart(
        layer.manager.rpc,
        this.segmentEquivalences.disjointSets.visibleSegmentEquivalencePolicy,
      ),
    );
    this.useTemporaryVisibleSegments = layer.registerDisposer(
      SharedWatchableValue.make(layer.manager.rpc, false),
    );
    this.useTemporarySegmentEquivalences = layer.registerDisposer(
      SharedWatchableValue.make(layer.manager.rpc, false),
    );

    visibleSegments.changed.add(specificationChanged.dispatch);
    selectedSegments.changed.add(specificationChanged.dispatch);
    selectedSegments.changed.add((x, add) => {
      if (!add) {
        if (x) {
          visibleSegments.delete(x);
        } else {
          visibleSegments.clear();
        }
      }
    });
    visibleSegments.changed.add((x, add) => {
      if (add) {
        if (x) {
          selectedSegments.add(x);
        }
      }
    });
  }

  restoreState(specification: unknown) {
    verifyOptionalObjectProperty(
      specification,
      json_keys.HIDE_SEGMENT_ZERO_JSON_KEY,
      (value) => this.hideSegmentZero.restoreState(value),
    );
    verifyOptionalObjectProperty(
      specification,
      json_keys.ALLOW_BRUSH_JSON_KEY,
      (value) => this.allowBrush.restoreState(value),
    );
    verifyOptionalObjectProperty(
      specification,
      json_keys.EQUIVALENCES_JSON_KEY,
      (value) => {
        this.localGraph.restoreState(value);
      },
    );

    verifyOptionalObjectProperty(
      specification,
      json_keys.SEGMENTS_JSON_KEY,
      (segmentsValue) => {
        const { segmentEquivalences, selectedSegments, visibleSegments } = this;
        parseArray(segmentsValue, (value) => {
          let stringValue = String(value);
          const hidden = stringValue.startsWith("!");
          if (hidden) {
            stringValue = stringValue.substring(1);
          }
          const id = parseUint64(stringValue);
          const segmentId = segmentEquivalences.get(id);
          selectedSegments.add(segmentId);
          if (!hidden) {
            visibleSegments.add(segmentId);
          }
        });
      },
    );
    verifyOptionalObjectProperty(
      specification,
      json_keys.SEGMENT_QUERY_JSON_KEY,
      (value) => this.segmentQuery.restoreState(value),
    );
  }

  toJSON() {
    const x: any = {};
    x[json_keys.HIDE_SEGMENT_ZERO_JSON_KEY] = this.hideSegmentZero.toJSON();
    x[json_keys.ALLOW_BRUSH_JSON_KEY] = this.allowBrush.toJSON();
    const { selectedSegments, visibleSegments } = this;
    if (selectedSegments.size > 0) {
      x[json_keys.SEGMENTS_JSON_KEY] = [...selectedSegments].map((segment) => {
        if (visibleSegments.has(segment)) {
          return segment.toString();
        }
        return "!" + segment.toString();
      });
    } else {
      x[json_keys.SEGMENTS_JSON_KEY] = [];
    }
    const { segmentEquivalences } = this;
    if (this.localSegmentEquivalences && segmentEquivalences.size > 0) {
      x[json_keys.EQUIVALENCES_JSON_KEY] = segmentEquivalences.toJSON();
    }
    x[json_keys.SEGMENT_QUERY_JSON_KEY] = this.segmentQuery.toJSON();
    return x;
  }

  assignFrom(other: SegmentationUserLayerGroupState) {
    this.maxIdLength.value = other.maxIdLength.value;
    this.hideSegmentZero.value = other.hideSegmentZero.value;
    this.allowBrush.value = other.allowBrush.value;
    this.selectedSegments.assignFrom(other.selectedSegments);
    this.visibleSegments.assignFrom(other.visibleSegments);
    this.segmentEquivalences.assignFrom(other.segmentEquivalences);
  }

  localGraph = new LocalSegmentationGraphSource();
  visibleSegments: Uint64Set;
  selectedSegments = this.registerDisposer(new Uint64OrderedSet());

  segmentPropertyMap = new WatchableValue<
    PreprocessedSegmentPropertyMap | undefined
  >(undefined);
  graph = new WatchableValue<SegmentationGraphSource | undefined>(undefined);
  segmentEquivalences: SharedDisjointUint64Sets;
  localSegmentEquivalences = false;
  maxIdLength = new WatchableValue(1);
  hideSegmentZero = new TrackableBoolean(true, true);
  allowBrush = new TrackableBoolean(true, true);
  segmentQuery = new TrackableValue<string>("", verifyString);

  temporaryVisibleSegments: Uint64Set;
  temporarySegmentEquivalences: SharedDisjointUint64Sets;
  useTemporaryVisibleSegments: SharedWatchableValue<boolean>;
  useTemporarySegmentEquivalences: SharedWatchableValue<boolean>;
}

export class SegmentationUserLayerColorGroupState
  extends RefCounted
  implements SegmentationColorGroupState
{
  specificationChanged = new Signal();
  constructor(public layer: SegmentationUserLayer) {
    super();
    const { specificationChanged } = this;
    this.segmentColorHash.changed.add(specificationChanged.dispatch);
    this.segmentStatedColors.changed.add(specificationChanged.dispatch);
    this.tempSegmentStatedColors2d.changed.add(specificationChanged.dispatch);
    this.segmentDefaultColor.changed.add(specificationChanged.dispatch);
    this.tempSegmentDefaultColor2d.changed.add(specificationChanged.dispatch);
    this.highlightColor.changed.add(specificationChanged.dispatch);
  }

  restoreState(specification: unknown) {
    verifyOptionalObjectProperty(
      specification,
      json_keys.COLOR_SEED_JSON_KEY,
      (value) => this.segmentColorHash.restoreState(value),
    );
    verifyOptionalObjectProperty(
      specification,
      json_keys.SEGMENT_DEFAULT_COLOR_JSON_KEY,
      (value) => this.segmentDefaultColor.restoreState(value),
    );
    verifyOptionalObjectProperty(
      specification,
      json_keys.SEGMENT_STATED_COLORS_JSON_KEY,
      (y) => {
        const result = verifyObjectAsMap(y, (x) =>
          parseRGBColorSpecification(String(x)),
        );
        for (const [idStr, colorVec] of result) {
          const id = parseUint64(idStr);
          const color = BigInt(packColor(colorVec));
          this.segmentStatedColors.set(id, color);
        }
      },
    );
  }

  toJSON() {
    const x: any = {};
    x[json_keys.COLOR_SEED_JSON_KEY] = this.segmentColorHash.toJSON();
    x[json_keys.SEGMENT_DEFAULT_COLOR_JSON_KEY] =
      this.segmentDefaultColor.toJSON();
    const { segmentStatedColors } = this;
    if (segmentStatedColors.size > 0) {
      const j: any = (x[json_keys.SEGMENT_STATED_COLORS_JSON_KEY] = {});
      for (const [key, value] of segmentStatedColors) {
        j[key.toString()] = serializeColor(unpackRGB(Number(value)));
      }
    }
    return x;
  }

  assignFrom(other: SegmentationUserLayerColorGroupState) {
    this.segmentColorHash.value = other.segmentColorHash.value;
    this.segmentStatedColors.assignFrom(other.segmentStatedColors);
    this.tempSegmentStatedColors2d.assignFrom(other.tempSegmentStatedColors2d);
    this.segmentDefaultColor.value = other.segmentDefaultColor.value;
    this.highlightColor.value = other.highlightColor.value;
  }

  segmentColorHash = SegmentColorHash.getDefault();
  segmentStatedColors = this.registerDisposer(new Uint64Map());
  tempSegmentStatedColors2d = this.registerDisposer(new Uint64Map());
  segmentDefaultColor = new TrackableOptionalRGB();
  tempSegmentDefaultColor2d = new WatchableValue<vec3 | vec4 | undefined>(
    undefined,
  );
  highlightColor = new WatchableValue<vec4 | undefined>(undefined);
}

class LinkedSegmentationGroupState<
    State extends
      | SegmentationUserLayerGroupState
      | SegmentationUserLayerColorGroupState,
  >
  extends RefCounted
  implements WatchableValueInterface<State>
{
  private curRoot: SegmentationUserLayer | undefined;
  private curGroupState: Owned<State> | undefined;
  get changed() {
    return this.linkedGroup.root.changed;
  }
  get value() {
    const root = this.linkedGroup.root.value as SegmentationUserLayer;
    if (root !== this.curRoot) {
      this.curRoot = root;
      const groupState = root.displayState[this.propertyName] as State;
      if (root === this.linkedGroup.layer) {
        const { curGroupState } = this;
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
  constructor(
    public linkedGroup: LinkedLayerGroup,
    private propertyName: State extends SegmentationUserLayerGroupState
      ? "originalSegmentationGroupState"
      : "originalSegmentationColorGroupState",
  ) {
    super();
    this.value;
  }
}

class SegmentationUserLayerDisplayState implements SegmentationDisplayState {
  constructor(public layer: SegmentationUserLayer) {
    // Even though `SegmentationUserLayer` assigns this to its `displayState` property, redundantly
    // assign it here first in order to allow it to be accessed by `segmentationGroupState`.
    layer.displayState = this;

    this.linkedSegmentationGroup = layer.registerDisposer(
      new LinkedLayerGroup(
        layer.manager.rootLayers,
        layer,
        (userLayer) => userLayer instanceof SegmentationUserLayer,
        (userLayer: SegmentationUserLayer) =>
          userLayer.displayState.linkedSegmentationGroup,
      ),
    );

    this.linkedSegmentationColorGroup = this.layer.registerDisposer(
      new LinkedLayerGroup(
        layer.manager.rootLayers,
        layer,
        (userLayer) => userLayer instanceof SegmentationUserLayer,
        (userLayer: SegmentationUserLayer) =>
          userLayer.displayState.linkedSegmentationColorGroup,
      ),
    );

    this.originalSegmentationGroupState = layer.registerDisposer(
      new SegmentationUserLayerGroupState(layer),
    );

    this.originalSegmentationColorGroupState = layer.registerDisposer(
      new SegmentationUserLayerColorGroupState(layer),
    );

    this.transparentPickEnabled = layer.pick;

    this.useTempSegmentStatedColors2d = layer.registerDisposer(
      SharedWatchableValue.make(layer.manager.rpc, false),
    );

    this.segmentationGroupState = this.layer.registerDisposer(
      new LinkedSegmentationGroupState<SegmentationUserLayerGroupState>(
        this.linkedSegmentationGroup,
        "originalSegmentationGroupState",
      ),
    );
    this.segmentationColorGroupState = this.layer.registerDisposer(
      new LinkedSegmentationGroupState<SegmentationUserLayerColorGroupState>(
        this.linkedSegmentationColorGroup,
        "originalSegmentationColorGroupState",
      ),
    );

    this.selectSegment = layer.selectSegment;
    this.filterBySegmentLabel = layer.filterBySegmentLabel;

    this.hideSegmentZero = this.layer.registerDisposer(
      new IndirectWatchableValue(
        this.segmentationGroupState,
        (group) => group.hideSegmentZero,
      ),
    );
    this.allowBrush = this.layer.registerDisposer(
      new IndirectWatchableValue(
        this.segmentationGroupState,
        (group) => group.allowBrush,
      ),
    );
    this.segmentColorHash = this.layer.registerDisposer(
      new IndirectTrackableValue(
        this.segmentationColorGroupState,
        (group) => group.segmentColorHash,
      ),
    );
    this.segmentStatedColors = this.layer.registerDisposer(
      new IndirectTrackableValue(
        this.segmentationColorGroupState,
        (group) => group.segmentStatedColors,
      ),
    );
    this.tempSegmentStatedColors2d = this.layer.registerDisposer(
      new IndirectTrackableValue(
        this.segmentationColorGroupState,
        (group) => group.tempSegmentStatedColors2d,
      ),
    );
    this.segmentDefaultColor = this.layer.registerDisposer(
      new IndirectTrackableValue(
        this.segmentationColorGroupState,
        (group) => group.segmentDefaultColor,
      ),
    );
    this.tempSegmentDefaultColor2d = this.layer.registerDisposer(
      new IndirectTrackableValue(
        this.segmentationColorGroupState,
        (group) => group.tempSegmentDefaultColor2d,
      ),
    );
    this.highlightColor = this.layer.registerDisposer(
      new IndirectTrackableValue(
        this.segmentationColorGroupState,
        (group) => group.highlightColor,
      ),
    );
    this.segmentQuery = this.layer.registerDisposer(
      new IndirectWatchableValue(
        this.segmentationGroupState,
        (group) => group.segmentQuery,
      ),
    );
    this.segmentPropertyMap = this.layer.registerDisposer(
      new IndirectWatchableValue(
        this.segmentationGroupState,
        (group) => group.segmentPropertyMap,
      ),
    );
  }

  segmentSelectionState = new SegmentSelectionState();
  selectedAlpha = trackableAlphaValue(0.5);
  saturation = trackableAlphaValue(1.0);
  notSelectedAlpha = trackableAlphaValue(0);
  hoverHighlight = new TrackableBoolean(true, true);
  silhouetteRendering = new TrackableValue<number>(
    0,
    verifyFiniteNonNegativeFloat,
    0,
  );
  objectAlpha = trackableAlphaValue(1.0);
  ignoreNullVisibleSet = new TrackableBoolean(true, true);
  skeletonRenderingOptions = new SkeletonRenderingOptions();
  shaderError = makeWatchableShaderError();
  renderScaleHistogram = new RenderScaleHistogram();
  renderScaleTarget = trackableRenderScaleTarget(1);
  selectSegment: (id: bigint, pin: boolean | "toggle") => void;
  transparentPickEnabled: TrackableBoolean;
  baseSegmentColoring = new TrackableBoolean(false, false);
  baseSegmentHighlighting = new TrackableBoolean(false, false);
  useTempSegmentStatedColors2d: SharedWatchableValue<boolean>;

  filterBySegmentLabel: (id: bigint) => void;

  moveToSegment = (id: bigint) => {
    this.layer.moveToSegment(id);
  };

  linkedSegmentationGroup: LinkedLayerGroup;
  linkedSegmentationColorGroup: LinkedLayerGroup;
  originalSegmentationGroupState: SegmentationUserLayerGroupState;
  originalSegmentationColorGroupState: SegmentationUserLayerColorGroupState;

  segmentationGroupState: WatchableValueInterface<SegmentationUserLayerGroupState>;
  segmentationColorGroupState: WatchableValueInterface<SegmentationUserLayerColorGroupState>;

  // Indirect properties
  hideSegmentZero: WatchableValueInterface<boolean>;
  allowBrush: WatchableValueInterface<boolean>;
  segmentColorHash: TrackableValueInterface<number>;
  segmentStatedColors: WatchableValueInterface<Uint64Map>;
  tempSegmentStatedColors2d: WatchableValueInterface<Uint64Map>;
  segmentDefaultColor: WatchableValueInterface<vec3 | undefined>;
  tempSegmentDefaultColor2d: WatchableValueInterface<vec3 | vec4 | undefined>;
  highlightColor: WatchableValueInterface<vec4 | undefined>;
  segmentQuery: WatchableValueInterface<string>;
  segmentPropertyMap: WatchableValueInterface<
    PreprocessedSegmentPropertyMap | undefined
  >;
}

interface SegmentationActionContext extends LayerActionContext {
  // Restrict the `select` action not to both toggle on and off segments.  If segment would be
  // toggled on in at least one layer, only toggle segments on.
  segmentationToggleSegmentState?: boolean | undefined;
}

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
  codeVisible = new TrackableBoolean(true);

  graphConnection = new WatchableValue<
    SegmentationGraphSourceConnection | undefined
  >(undefined);

  bindSegmentListWidth(element: HTMLElement) {
    return bindSegmentListWidth(this.displayState, element);
  }

  segmentQueryFocusTime = new WatchableValue<number>(Number.NEGATIVE_INFINITY);

  selectSegment = (id: bigint, pin: boolean | "toggle") => {
    this.manager.root.selectionState.captureSingleLayerState(
      this,
      (state) => {
        state.value = id;
        return true;
      },
      pin,
    );
  };

  filterBySegmentLabel = (id: bigint) => {
    const augmented = augmentSegmentId(this.displayState, id);
    const { label } = augmented;
    if (!label) return;
    this.filterSegments(label);
  };

  filterSegments = (query: string) => {
    this.displayState.segmentationGroupState.value.segmentQuery.value = query;
    this.segmentQueryFocusTime.value = Date.now();
    this.tabs.value = "segments";
    this.manager.root.selectedLayer.layer = this.managedLayer;
  };

  displayState = new SegmentationUserLayerDisplayState(this);

  anchorSegment = new TrackableValue<bigint | undefined>(undefined, (x) =>
    x === undefined ? undefined : parseUint64(x),
  );

  constructor(managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.codeVisible.changed.add(this.specificationChanged.dispatch);
    this.registerDisposer(
      registerNestedSync((context, group) => {
        context.registerDisposer(
          group.specificationChanged.add(this.specificationChanged.dispatch),
        );
        this.specificationChanged.dispatch();
      }, this.displayState.segmentationGroupState),
    );
    this.registerDisposer(
      registerNestedSync((context, group) => {
        context.registerDisposer(
          group.specificationChanged.add(this.specificationChanged.dispatch),
        );
        this.specificationChanged.dispatch();
      }, this.displayState.segmentationColorGroupState),
    );
    this.displayState.segmentSelectionState.bindTo(
      this.manager.layerSelectedValues,
      this,
    );
    this.displayState.selectedAlpha.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.saturation.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.notSelectedAlpha.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.objectAlpha.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.hoverHighlight.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.baseSegmentColoring.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.ignoreNullVisibleSet.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.skeletonRenderingOptions.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.renderScaleTarget.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.silhouetteRendering.changed.add(
      this.specificationChanged.dispatch,
    );
    this.anchorSegment.changed.add(this.specificationChanged.dispatch);
    this.sliceViewRenderScaleTarget.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.originalSegmentationGroupState.localGraph.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.linkedSegmentationGroup.changed.add(() =>
      this.updateDataSubsourceActivations(),
    );
    this.tabs.add("rendering", {
      label: "Render",
      order: -100,
      getter: () => new DisplayOptionsTab(this),
    });
    this.tabs.add("segments", {
      label: "Seg.",
      order: -50,
      getter: () => new SegmentDisplayTab(this),
    });
    const hideGraphTab = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (x) => x === undefined,
        [this.displayState.segmentationGroupState.value.graph],
      ),
    );
    this.tabs.add("graph", {
      label: "Graph",
      order: -25,
      getter: () => new SegmentationGraphSourceTab(this),
      hidden: hideGraphTab,
    });
    this.tabs.default = "rendering";
  }

  get volumeOptions() {
    return { volumeType: VolumeType.SEGMENTATION };
  }

  readonly has2dLayer = this.registerDisposer(
    makeCachedLazyDerivedWatchableValue(
      (layers) => layers.some((x) => x instanceof SegmentationRenderLayer),
      { changed: this.layersChanged, value: this.renderLayers },
    ),
  );

  readonly has3dLayer = this.registerDisposer(
    makeCachedLazyDerivedWatchableValue(
      (layers) =>
        layers.some(
          (x) =>
            x instanceof MeshLayer ||
            x instanceof MultiscaleMeshLayer ||
            x instanceof PerspectiveViewSkeletonLayer ||
            x instanceof SliceViewPanelSkeletonLayer,
        ),
      { changed: this.layersChanged, value: this.renderLayers },
    ),
  );

  readonly hasSkeletonsLayer = this.registerDisposer(
    makeCachedLazyDerivedWatchableValue(
      (layers) => layers.some((x) => x instanceof PerspectiveViewSkeletonLayer),
      { changed: this.layersChanged, value: this.renderLayers },
    ),
  );

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    const updatedSegmentPropertyMaps: SegmentPropertyMap[] = [];
    const isGroupRoot =
      this.displayState.linkedSegmentationGroup.root.value === this;
    let updatedGraph: SegmentationGraphSource | undefined;
    for (const loadedSubsource of subsources) {
      if (this.addStaticAnnotations(loadedSubsource)) continue;
      const { volume, mesh, segmentPropertyMap, segmentationGraph, local } =
        loadedSubsource.subsourceEntry.subsource;
      if (volume instanceof MultiscaleVolumeChunkSource) {
        switch (volume.dataType) {
          case DataType.FLOAT32:
            loadedSubsource.deactivate(
              "Data type not compatible with segmentation layer",
            );
            continue;
        }
        loadedSubsource.activate(
          () =>
            loadedSubsource.addRenderLayer(
              new SegmentationRenderLayer(volume, {
                ...this.displayState,
                transform: loadedSubsource.getRenderLayerTransform(),
                renderScaleTarget: this.sliceViewRenderScaleTarget,
                renderScaleHistogram: this.sliceViewRenderScaleHistogram,
                localPosition: this.localPosition,
              }),
            ),
          this.displayState.segmentationGroupState.value,
        );
      } else if (mesh !== undefined) {
        loadedSubsource.activate(() => {
          const displayState = {
            ...this.displayState,
            transform: loadedSubsource.getRenderLayerTransform(),
          };
          if (mesh instanceof MeshSource) {
            loadedSubsource.addRenderLayer(
              new MeshLayer(this.manager.chunkManager, mesh, displayState),
            );
          } else if (mesh instanceof MultiscaleMeshSource) {
            loadedSubsource.addRenderLayer(
              new MultiscaleMeshLayer(
                this.manager.chunkManager,
                mesh,
                displayState,
              ),
            );
          } else {
            const base = new SkeletonLayer(
              this.manager.chunkManager,
              mesh,
              displayState,
            );
            loadedSubsource.addRenderLayer(
              new PerspectiveViewSkeletonLayer(base.addRef()),
            );
            loadedSubsource.addRenderLayer(
              new SliceViewPanelSkeletonLayer(/* transfer ownership */ base),
            );
          }
        }, this.displayState.segmentationGroupState.value);
      } else if (segmentPropertyMap !== undefined) {
        if (!isGroupRoot) {
          loadedSubsource.deactivate(
            "Not supported on non-root linked segmentation layers",
          );
        } else {
          loadedSubsource.activate(() => {});
          updatedSegmentPropertyMaps.push(segmentPropertyMap);
        }
      } else if (segmentationGraph !== undefined) {
        if (!isGroupRoot) {
          loadedSubsource.deactivate(
            "Not supported on non-root linked segmentation layers",
          );
        } else {
          if (updatedGraph !== undefined) {
            loadedSubsource.deactivate(
              "Only one segmentation graph is supported",
            );
          } else {
            updatedGraph = segmentationGraph;
            loadedSubsource.activate((refCounted) => {
              const graphConnection = segmentationGraph.connect(this);
              refCounted.registerDisposer(() => {
                graphConnection.dispose();
                this.graphConnection.value = undefined;
              });
              const displayState = {
                ...this.displayState,
                transform: loadedSubsource.getRenderLayerTransform(),
              };

              const graphRenderLayers = graphConnection.createRenderLayers(
                this.manager.chunkManager,
                displayState,
                this.localPosition,
              );
              this.graphConnection.value = graphConnection;
              for (const renderLayer of graphRenderLayers) {
                loadedSubsource.addRenderLayer(renderLayer);
              }
            });
          }
        }
      } else if (local === LocalDataSource.equivalences) {
        if (!isGroupRoot) {
          loadedSubsource.deactivate(
            "Not supported on non-root linked segmentation layers",
          );
        } else {
          if (updatedGraph !== undefined) {
            loadedSubsource.deactivate(
              "Only one segmentation graph is supported",
            );
          } else {
            updatedGraph =
              this.displayState.originalSegmentationGroupState.localGraph;
            loadedSubsource.activate((refCounted) => {
              this.graphConnection.value = refCounted.registerDisposer(
                updatedGraph!.connect(this),
              );
              refCounted.registerDisposer(() => {
                this.graphConnection.value = undefined;
              });
            });
          }
        }
        // } else if (local === LocalDataSource.brush) {
        //   if (!isGroupRoot) {
        //     loadedSubsource.deactivate(
        //       "Not supported on non-root linked segmentation layers",
        //     );
        //   } else {
        //     console.log("selected brush! do something later");
        //     this.displayState.allowBrush = true
        //   }
      } else {
        loadedSubsource.deactivate("Not compatible with segmentation layer");
      }
    }
    this.displayState.originalSegmentationGroupState.segmentPropertyMap.value =
      getPreprocessedSegmentPropertyMap(
        this.manager.chunkManager,
        updatedSegmentPropertyMaps,
      );
    this.displayState.originalSegmentationGroupState.graph.value = updatedGraph;
  }

  getLegacyDataSourceSpecifications(
    sourceSpec: any,
    layerSpec: any,
    legacyTransform: CoordinateTransformSpecification | undefined,
    explicitSpecs: DataSourceSpecification[],
  ): DataSourceSpecification[] {
    const specs = super.getLegacyDataSourceSpecifications(
      sourceSpec,
      layerSpec,
      legacyTransform,
      explicitSpecs,
    );
    const meshPath = verifyOptionalObjectProperty(
      layerSpec,
      json_keys.MESH_JSON_KEY,
      (x) => (x === null ? null : verifyString(x)),
    );
    const skeletonsPath = verifyOptionalObjectProperty(
      layerSpec,
      json_keys.SKELETONS_JSON_KEY,
      (x) => (x === null ? null : verifyString(x)),
    );
    if (meshPath !== undefined || skeletonsPath !== undefined) {
      for (const spec of specs) {
        spec.enableDefaultSubsources = false;
        spec.subsources = new Map([
          ["default", { enabled: true }],
          ["bounds", { enabled: true }],
        ]);
      }
    }
    if (meshPath != null) {
      specs.push(
        layerDataSourceSpecificationFromJson(
          this.manager.dataSourceProviderRegistry.convertLegacyUrl({
            url: meshPath,
            type: "mesh",
          }),
        ),
      );
    }
    if (skeletonsPath != null) {
      specs.push(
        layerDataSourceSpecificationFromJson(
          this.manager.dataSourceProviderRegistry.convertLegacyUrl({
            url: skeletonsPath,
            type: "skeletons",
          }),
        ),
      );
    }
    if (
      layerSpec[json_keys.EQUIVALENCES_JSON_KEY] !== undefined &&
      explicitSpecs.find((spec) => spec.url === localEquivalencesUrl) ===
        undefined
    ) {
      specs.push({
        url: localEquivalencesUrl,
        enableDefaultSubsources: true,
        transform: {
          outputSpace: emptyValidCoordinateSpace,
          sourceRank: 0,
          transform: undefined,
          inputSpace: emptyValidCoordinateSpace,
        },
        subsources: new Map(),
      });
    }
    return specs;
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.displayState.selectedAlpha.restoreState(
      specification[json_keys.SELECTED_ALPHA_JSON_KEY],
    );
    this.displayState.saturation.restoreState(
      specification[json_keys.SATURATION_JSON_KEY],
    );
    this.displayState.notSelectedAlpha.restoreState(
      specification[json_keys.NOT_SELECTED_ALPHA_JSON_KEY],
    );
    this.displayState.hoverHighlight.restoreState(
      specification[json_keys.HOVER_HIGHLIGHT_JSON_KEY],
    );
    this.displayState.objectAlpha.restoreState(
      specification[json_keys.OBJECT_ALPHA_JSON_KEY],
    );
    this.displayState.baseSegmentColoring.restoreState(
      specification[json_keys.BASE_SEGMENT_COLORING_JSON_KEY],
    );
    this.displayState.silhouetteRendering.restoreState(
      specification[json_keys.MESH_SILHOUETTE_RENDERING_JSON_KEY],
    );
    this.displayState.ignoreNullVisibleSet.restoreState(
      specification[json_keys.IGNORE_NULL_VISIBLE_SET_JSON_KEY],
    );

    const { skeletonRenderingOptions } = this.displayState;
    skeletonRenderingOptions.restoreState(
      specification[json_keys.SKELETON_RENDERING_JSON_KEY],
    );
    const skeletonShader = specification[json_keys.SKELETON_SHADER_JSON_KEY];
    if (skeletonShader !== undefined) {
      skeletonRenderingOptions.shader.restoreState(skeletonShader);
    }
    this.codeVisible.restoreState(json_keys.SKELETON_CODE_VISIBLE_KEY);
    this.displayState.renderScaleTarget.restoreState(
      specification[json_keys.MESH_RENDER_SCALE_JSON_KEY],
    );
    this.anchorSegment.restoreState(
      specification[json_keys.ANCHOR_SEGMENT_JSON_KEY],
    );
    this.sliceViewRenderScaleTarget.restoreState(
      specification[json_keys.CROSS_SECTION_RENDER_SCALE_JSON_KEY],
    );
    const linkedSegmentationGroupName = verifyOptionalObjectProperty(
      specification,
      json_keys.LINKED_SEGMENTATION_GROUP_JSON_KEY,
      verifyString,
    );
    if (linkedSegmentationGroupName !== undefined) {
      this.displayState.linkedSegmentationGroup.linkByName(
        linkedSegmentationGroupName,
      );
    }
    const linkedSegmentationColorGroupName = verifyOptionalObjectProperty(
      specification,
      json_keys.LINKED_SEGMENTATION_COLOR_GROUP_JSON_KEY,
      (x) => (x === false ? undefined : verifyString(x)),
      linkedSegmentationGroupName,
    );
    if (linkedSegmentationColorGroupName !== undefined) {
      this.displayState.linkedSegmentationColorGroup.linkByName(
        linkedSegmentationColorGroupName,
      );
    }
    this.displayState.segmentationGroupState.value.restoreState(specification);
    this.displayState.segmentationColorGroupState.value.restoreState(
      specification,
    );
  }

  toJSON() {
    const x = super.toJSON();
    x[json_keys.SELECTED_ALPHA_JSON_KEY] =
      this.displayState.selectedAlpha.toJSON();
    x[json_keys.NOT_SELECTED_ALPHA_JSON_KEY] =
      this.displayState.notSelectedAlpha.toJSON();
    x[json_keys.SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[json_keys.OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[json_keys.HOVER_HIGHLIGHT_JSON_KEY] =
      this.displayState.hoverHighlight.toJSON();
    x[json_keys.BASE_SEGMENT_COLORING_JSON_KEY] =
      this.displayState.baseSegmentColoring.toJSON();
    x[json_keys.IGNORE_NULL_VISIBLE_SET_JSON_KEY] =
      this.displayState.ignoreNullVisibleSet.toJSON();
    x[json_keys.MESH_SILHOUETTE_RENDERING_JSON_KEY] =
      this.displayState.silhouetteRendering.toJSON();
    x[json_keys.ANCHOR_SEGMENT_JSON_KEY] = this.anchorSegment.toJSON();
    x[json_keys.SKELETON_RENDERING_JSON_KEY] =
      this.displayState.skeletonRenderingOptions.toJSON();
    x[json_keys.SKELETON_CODE_VISIBLE_KEY] = this.codeVisible.toJSON();
    x[json_keys.MESH_RENDER_SCALE_JSON_KEY] =
      this.displayState.renderScaleTarget.toJSON();
    x[json_keys.CROSS_SECTION_RENDER_SCALE_JSON_KEY] =
      this.sliceViewRenderScaleTarget.toJSON();

    const { linkedSegmentationGroup, linkedSegmentationColorGroup } =
      this.displayState;
    x[json_keys.LINKED_SEGMENTATION_GROUP_JSON_KEY] =
      linkedSegmentationGroup.toJSON();
    if (
      linkedSegmentationColorGroup.root.value !==
      linkedSegmentationGroup.root.value
    ) {
      x[json_keys.LINKED_SEGMENTATION_COLOR_GROUP_JSON_KEY] =
        linkedSegmentationColorGroup.toJSON() ?? false;
    }
    x[json_keys.EQUIVALENCES_JSON_KEY] =
      this.displayState.originalSegmentationGroupState.localGraph.toJSON();
    if (linkedSegmentationGroup.root.value === this) {
      Object.assign(x, this.displayState.segmentationGroupState.value.toJSON());
    }
    if (linkedSegmentationColorGroup.root.value === this) {
      Object.assign(
        x,
        this.displayState.segmentationColorGroupState.value.toJSON(),
      );
    }
    return x;
  }

  transformPickedValue(value: any) {
    if (value == null) {
      return value;
    }
    return maybeAugmentSegmentId(this.displayState, value);
  }

  handleAction(action: string, context: SegmentationActionContext) {
    switch (action) {
      case "recolor": {
        this.displayState.segmentationColorGroupState.value.segmentColorHash.randomize();
        break;
      }
      case "clear-segments": {
        if (!this.pick.value) break;
        this.displayState.segmentationGroupState.value.visibleSegments.clear();
        break;
      }
      case "select":
      case "star": {
        if (!this.pick.value) break;
        const { segmentSelectionState } = this.displayState;
        if (segmentSelectionState.hasSelectedSegment) {
          const segment = segmentSelectionState.selectedSegment;
          const group = this.displayState.segmentationGroupState.value;
          const segmentSet =
            action === "select"
              ? group.visibleSegments
              : group.selectedSegments;
          const newValue = !segmentSet.has(segment);
          if (
            newValue ||
            context.segmentationToggleSegmentState === undefined
          ) {
            context.segmentationToggleSegmentState = newValue;
          }
          context.defer(() => {
            if (context.segmentationToggleSegmentState === newValue) {
              segmentSet.set(segment, newValue);
            }
          });
        }
        break;
      }
    }
  }
  selectionStateFromJson(state: this["selectionState"], json: any) {
    super.selectionStateFromJson(state, json);
    let { value } = state;
    if (typeof value === "number") value = value.toString();
    try {
      state.value = parseUint64(value);
    } catch {
      state.value = undefined;
    }
  }
  selectionStateToJson(state: this["selectionState"], forPython: boolean): any {
    const json = super.selectionStateToJson(state, forPython);
    const { value } = state;
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
    } else if (typeof value === "bigint") {
      json.value = value.toString();
    }
    return json;
  }

  private displaySegmentationSelection(
    state: this["selectionState"],
    parent: HTMLElement,
    context: DependentViewContext,
  ): boolean {
    const { value } = state;
    let id: bigint;
    if (typeof value === "number" || typeof value === "string") {
      try {
        id = parseUint64(value);
      } catch {
        return false;
      }
    }
    if (typeof value === "bigint") {
      id = value;
    } else if (value instanceof Uint64MapEntry) {
      id = value.key;
    } else {
      return false;
    }
    const { displayState } = this;
    const normalizedId = augmentSegmentId(displayState, id);
    const {
      segmentEquivalences,
      segmentPropertyMap: { value: segmentPropertyMap },
    } = this.displayState.segmentationGroupState.value;
    const mapped = segmentEquivalences.get(id);
    const row = makeSegmentWidget(this.displayState, normalizedId);
    registerCallbackWhenSegmentationDisplayStateChanged(
      displayState,
      context,
      context.redraw,
    );
    context.registerDisposer(bindSegmentListWidth(displayState, row));
    row.classList.add("neuroglancer-selection-details-segment");
    parent.appendChild(row);

    if (segmentPropertyMap !== undefined) {
      const { inlineProperties } = segmentPropertyMap.segmentPropertyMap;
      if (inlineProperties !== undefined) {
        const index = segmentPropertyMap.getSegmentInlineIndex(mapped);
        if (index !== -1) {
          for (const property of inlineProperties.properties) {
            if (property.type === "label") continue;
            if (property.type === "description") {
              const value = property.values[index];
              if (!value) continue;
              const descriptionElement = document.createElement("div");
              descriptionElement.classList.add(
                "neuroglancer-selection-details-segment-description",
              );
              descriptionElement.textContent = value;
              parent.appendChild(descriptionElement);
            } else if (
              property.type === "number" ||
              property.type === "string"
            ) {
              const value = property.values[index];
              if (
                property.type === "number"
                  ? Number.isNaN(value as number)
                  : !value
              )
                continue;
              const propertyElement = document.createElement("div");
              propertyElement.classList.add(
                "neuroglancer-selection-details-segment-property",
              );
              const nameElement = document.createElement("div");
              nameElement.classList.add(
                "neuroglancer-selection-details-segment-property-name",
              );
              nameElement.textContent = property.id;
              if (property.description) {
                nameElement.title = property.description;
              }
              const valueElement = document.createElement("div");
              valueElement.classList.add(
                "neuroglancer-selection-details-segment-property-value",
              );
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
    state: this["selectionState"],
    parent: HTMLElement,
    context: DependentViewContext,
  ): boolean {
    let displayed = this.displaySegmentationSelection(state, parent, context);
    if (super.displaySelectionState(state, parent, context)) displayed = true;
    return displayed;
  }

  moveToSegment(id: bigint) {
    for (const layer of this.renderLayers) {
      if (
        !(layer instanceof MultiscaleMeshLayer || layer instanceof MeshLayer)
      ) {
        continue;
      }
      const transform = layer.displayState.transform.value;
      if (transform.error !== undefined) return undefined;
      const { rank, globalToRenderLayerDimensions } = transform;
      const { globalPosition } = this.manager.root;
      const globalLayerPosition = new Float32Array(rank);
      const renderToGlobalLayerDimensions = [];
      for (let i = 0; i < rank; i++) {
        renderToGlobalLayerDimensions[globalToRenderLayerDimensions[i]] = i;
      }
      gatherUpdate(
        globalLayerPosition,
        globalPosition.value,
        renderToGlobalLayerDimensions,
      );
      const layerPosition =
        layer instanceof MeshLayer
          ? layer.getObjectPosition(id, globalLayerPosition)
          : layer.getObjectPosition(id);
      if (layerPosition === undefined) continue;
      this.setLayerPosition(transform, layerPosition);
      return;
    }
    StatusMessage.showTemporaryMessage(
      `No position information loaded for segment ${id}`,
    );
  }

  static type = "segmentation";
  static typeAbbreviation = "seg";
  static supportsPickOption = true;
}

registerLayerControls(SegmentationUserLayer);

registerLayerType(SegmentationUserLayer);
registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);
registerLayerTypeDetector((subsource) => {
  if (subsource.mesh !== undefined) {
    return { layerConstructor: SegmentationUserLayer, priority: 1 };
  }
  return undefined;
});

registerLayerShaderControlsTool(
  SegmentationUserLayer,
  (layer) => ({
    shaderControlState:
      layer.displayState.skeletonRenderingOptions.shaderControlState,
  }),
  json_keys.SKELETON_RENDERING_SHADER_CONTROL_TOOL_ID,
);

registerSegmentSplitMergeTools(SegmentationUserLayer);
registerSegmentSelectTools(SegmentationUserLayer);
