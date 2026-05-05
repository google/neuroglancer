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

import svg_circle from "ikonate/icons/circle.svg?raw";
import svg_flag from "ikonate/icons/flag.svg?raw";
import svg_minus from "ikonate/icons/minus.svg?raw";
import svg_origin from "ikonate/icons/origin.svg?raw";
import svg_share_android from "ikonate/icons/share-android.svg?raw";
import type { CoordinateTransformSpecification } from "#src/coordinate_transform.js";
import { emptyValidCoordinateSpace } from "#src/coordinate_transform.js";
import type { DataSourceSpecification } from "#src/datasource/index.js";
import {
  LocalDataSource,
  localEquivalencesUrl,
} from "#src/datasource/local.js";
import type {
  LayerActionContext,
  ManagedUserLayer,
  MouseSelectionState,
  UserLayerSelectionState,
} from "#src/layer/index.js";
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
  getNodeIdFromLayerSelectionState,
  getSegmentIdFromLayerSelectionValue,
  SpatialSkeletonHoverState,
} from "#src/layer/segmentation/selection.js";
import {
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonNodeDescriptionUpdate,
  executeSpatialSkeletonNodePropertiesUpdate,
  executeSpatialSkeletonReroot,
  executeSpatialSkeletonNodeTrueEndUpdate,
  getSpatialSkeletonEditCommandSource,
} from "#src/layer/segmentation/spatial_skeleton_commands.js";
import { showSpatialSkeletonActionError } from "#src/layer/segmentation/spatial_skeleton_errors.js";
import {
  MeshLayer,
  MeshSource,
  MultiscaleMeshLayer,
  MultiscaleMeshSource,
} from "#src/mesh/frontend.js";
import {
  RenderScaleHistogram,
  numRenderScaleHistogramBins,
  renderScaleHistogramBinSize,
  renderScaleHistogramOrigin,
  trackableRenderScaleTarget,
} from "#src/render_scale_statistics.js";
import { getCssColor, SegmentColorHash } from "#src/segment_color.js";
import {
  addSegmentToVisibleSets,
  getVisibleSegments,
} from "#src/segmentation_display_state/base.js";
import type {
  SegmentationColorGroupState,
  SegmentationDisplayState,
  SegmentationGroupState,
} from "#src/segmentation_display_state/frontend.js";
import {
  augmentSegmentId,
  bindSegmentListWidth,
  getBaseObjectColor,
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
  DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS,
  getSpatialSkeletonActionSupportLabel,
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonSourceState,
} from "#src/skeleton/api.js";
import {
  findSpatiallyIndexedSkeletonNode,
  getSpatiallyIndexedSkeletonDirectChildren,
  getSpatiallyIndexedSkeletonNodeParent,
} from "#src/skeleton/edit_state.js";
import {
  PerspectiveViewSkeletonLayer,
  SkeletonLayer,
  SkeletonRenderingOptions,
  SliceViewPanelSkeletonLayer,
  PerspectiveViewSpatiallyIndexedSkeletonLayer,
  SliceViewPanelSpatiallyIndexedSkeletonLayer,
  SliceViewSpatiallyIndexedSkeletonLayer,
  SpatiallyIndexedSkeletonLayer,
  SpatiallyIndexedSkeletonSource,
  MultiscaleSpatiallyIndexedSkeletonSource,
  MultiscaleSliceViewSpatiallyIndexedSkeletonLayer,
} from "#src/skeleton/frontend.js";
import {
  classifySpatialSkeletonDisplayNodeType as getSpatialSkeletonDisplayNodeType,
  getSpatialSkeletonNodeFilterLabel,
  getSpatialSkeletonNodeIconFilterType,
  SpatialSkeletonNodeFilterType,
  type SpatialSkeletonDisplayNodeType,
} from "#src/skeleton/node_types.js";
import {
  getEditableSpatiallyIndexedSkeletonSource,
  getSpatiallyIndexedSkeletonSource,
  SpatialSkeletonState,
} from "#src/skeleton/spatial_skeleton_manager.js";
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
  observeWatchable,
  registerNestedSync,
  TrackableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import { UserLayerWithAnnotationsMixin } from "#src/ui/annotations.js";
import { SegmentDisplayTab } from "#src/ui/segment_list.js";
import { registerSegmentSelectTools } from "#src/ui/segment_select_tools.js";
import { registerSegmentSplitMergeTools } from "#src/ui/segment_split_merge_tools.js";
import { DisplayOptionsTab } from "#src/ui/segmentation_display_options_tab.js";
import { SpatialSkeletonEditTab } from "#src/ui/spatial_skeleton_edit_tab.js";
import { registerSpatialSkeletonEditModeTool } from "#src/ui/spatial_skeleton_edit_tool.js";
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
  verifyNonnegativeInt,
  verifyObjectAsMap,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import { Signal } from "#src/util/signal.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";
import { makeWatchableShaderError } from "#src/webgl/dynamic_shader.js";
import { makeDeleteButton } from "#src/widget/delete_button.js";
import type { DependentViewContext } from "#src/widget/dependent_view_widget.js";
import { makeIcon } from "#src/widget/icon.js";
import { registerLayerShaderControlsTool } from "#src/widget/shader_controls.js";

const MAX_LAYER_BAR_UI_INDICATOR_COLORS = 6;

const SPATIAL_SKELETON_NODE_TYPE_ICONS: Record<
  SpatialSkeletonDisplayNodeType,
  string
> = {
  root: svg_origin,
  branchStart: svg_share_android,
  regular: svg_minus,
  virtualEnd: svg_circle,
};

function getSpatialSkeletonNodeTypeLabel(
  nodeType: SpatialSkeletonDisplayNodeType,
  nodeHasTrueEnd: boolean,
) {
  if (nodeHasTrueEnd) return "True end";
  switch (nodeType) {
    case "root":
      return "Root";
    case "branchStart":
      return "Branch point";
    case "virtualEnd":
      return "Leaf";
    default:
      return "Node";
  }
}

function formatSpatialSkeletonPosition(
  modelPosition: ArrayLike<number>,
  names?: readonly string[],
) {
  const x = Math.round(Number(modelPosition[0]));
  const y = Math.round(Number(modelPosition[1]));
  const z = Math.round(Number(modelPosition[2]));
  const n = names ?? ["x", "y", "z"];
  return {
    copyText: `${x}, ${y}, ${z}`,
    displayText: `${x} ${y} ${z}`,
    fullText: `${n[0]}: ${x} ${n[1]}: ${y} ${n[2]}: ${z}`,
    x,
    y,
    z,
  };
}

function formatSpatialSkeletonEditableNumber(
  value: number | undefined,
  fallback = "0",
) {
  return value === undefined ? fallback : `${value}`;
}

function getSpatialSkeletonSegmentChipColors(
  displayState: SegmentationDisplayState | undefined | null,
  segmentId: number,
) {
  const color = getBaseObjectColor(
    displayState,
    BigInt(segmentId),
    new Float32Array(4),
  );
  const r = Math.round(color[0] * 255);
  const g = Math.round(color[1] * 255);
  const b = Math.round(color[2] * 255);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return {
    background: getCssColor(color),
    foreground: luminance > 0.6 ? "#101010" : "#f5f5f5",
  };
}

function bindSpatialSkeletonSegmentSelection(
  element: HTMLElement,
  selectSegment: (id: bigint, pin: true | "force-unpin") => void,
  segmentId: number,
) {
  const id = BigInt(segmentId);
  const hasSegmentSelectionModifiers = (event: MouseEvent) =>
    event.ctrlKey && !event.altKey && !event.metaKey;
  element.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.button !== 2 || !hasSegmentSelectionModifiers(event)) return;
    selectSegment(id, event.shiftKey ? "force-unpin" : true);
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener("contextmenu", (event: MouseEvent) => {
    if (!hasSegmentSelectionModifiers(event)) return;
    if (event.button !== 2) {
      selectSegment(id, event.shiftKey ? "force-unpin" : true);
    }
    event.preventDefault();
    event.stopPropagation();
  });
}

export class SegmentationUserLayerGroupState
  extends RefCounted
  implements SegmentationGroupState
{
  specificationChanged = new Signal();
  constructor(public layer: SegmentationUserLayer) {
    super();
    const { specificationChanged } = this;
    this.hideSegmentZero.changed.add(specificationChanged.dispatch);
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

type SpatialSkeletonGridSize = { x: number; y: number; z: number };
type SpatialSkeletonGridLevel = { size: SpatialSkeletonGridSize };

function getSpatialSkeletonGridSpacing(size: SpatialSkeletonGridSize) {
  return Math.min(size.x, size.y, size.z);
}

function buildSpatialSkeletonGridLevels(
  gridSizes: SpatialSkeletonGridSize[],
): SpatialSkeletonGridLevel[] {
  return gridSizes.map((size) => ({ size }));
}

function findClosestSpatialSkeletonGridLevelBySpacing(
  levels: SpatialSkeletonGridLevel[],
  spacing: number,
): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < levels.length; ++i) {
    const gridSpacing = getSpatialSkeletonGridSpacing(levels[i].size);
    const distance = Math.abs(gridSpacing - spacing);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function getSpatialSkeletonGridHistogramConfig(
  levels: SpatialSkeletonGridLevel[],
) {
  if (levels.length === 0) {
    return {
      origin: renderScaleHistogramOrigin,
      binSize: renderScaleHistogramBinSize,
    };
  }
  const logSpacings: number[] = [];
  let minLogSpacing = Number.POSITIVE_INFINITY;
  let maxLogSpacing = Number.NEGATIVE_INFINITY;
  for (const level of levels) {
    const spacing = Math.max(getSpatialSkeletonGridSpacing(level.size), 1e-6);
    const logSpacing = Math.log2(spacing);
    logSpacings.push(logSpacing);
    minLogSpacing = Math.min(minLogSpacing, logSpacing);
    maxLogSpacing = Math.max(maxLogSpacing, logSpacing);
  }
  if (!Number.isFinite(minLogSpacing) || !Number.isFinite(maxLogSpacing)) {
    return {
      origin: renderScaleHistogramOrigin,
      binSize: renderScaleHistogramBinSize,
    };
  }
  logSpacings.sort((a, b) => a - b);
  let minDelta = Number.POSITIVE_INFINITY;
  for (let i = 1; i < logSpacings.length; ++i) {
    const delta = logSpacings[i] - logSpacings[i - 1];
    if (delta > 0) minDelta = Math.min(minDelta, delta);
  }
  const span = maxLogSpacing - minLogSpacing;
  const minBinSizeForCoverage =
    span / Math.max(numRenderScaleHistogramBins - 4, 1);
  const lowerBound = Math.max(minBinSizeForCoverage, 0.05);
  let binSize = lowerBound;
  if (Number.isFinite(minDelta)) {
    const maxBinSizeForDistinctBars = minDelta * 0.9;
    if (maxBinSizeForDistinctBars >= lowerBound) {
      binSize = maxBinSizeForDistinctBars;
    }
  }
  if (!Number.isFinite(binSize) || binSize <= 0) {
    binSize = renderScaleHistogramBinSize;
  }

  const range = numRenderScaleHistogramBins * binSize;
  const desiredPadding = binSize * 2;
  const minOrigin = maxLogSpacing + desiredPadding - range;
  const maxOrigin = minLogSpacing - desiredPadding;
  const centeredOrigin = (minLogSpacing + maxLogSpacing - range) / 2;
  const clampedOrigin = Math.min(
    Math.max(centeredOrigin, minOrigin),
    maxOrigin,
  );
  const roundedBinSize = Math.max(binSize, 1e-3);
  const roundedOrigin =
    Math.round(clampedOrigin / roundedBinSize) * roundedBinSize;
  return { origin: roundedOrigin, binSize: roundedBinSize };
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
        (userLayer) => {
          if (!(userLayer instanceof SegmentationUserLayer)) {
            throw new Error(
              "Expected a segmentation layer for the linked segmentation group.",
            );
          }
          return userLayer.displayState.linkedSegmentationGroup;
        },
      ),
    );

    this.linkedSegmentationColorGroup = this.layer.registerDisposer(
      new LinkedLayerGroup(
        layer.manager.rootLayers,
        layer,
        (userLayer) => userLayer instanceof SegmentationUserLayer,
        (userLayer) => {
          if (!(userLayer instanceof SegmentationUserLayer)) {
            throw new Error(
              "Expected a segmentation layer for the linked segmentation color group.",
            );
          }
          return userLayer.displayState.linkedSegmentationColorGroup;
        },
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

    this.spatialSkeletonGridResolutionTarget2d.changed.add(() => {
      const levels = this.spatialSkeletonGridLevels.value;
      if (levels.length > 0) {
        this.setSpatialSkeletonGridLevel(
          "2d",
          findClosestSpatialSkeletonGridLevelBySpacing(
            levels,
            this.spatialSkeletonGridResolutionTarget2d.value,
          ),
        );
      }
    });
    this.spatialSkeletonGridResolutionTarget3d.changed.add(() => {
      const levels = this.spatialSkeletonGridLevels.value;
      if (levels.length > 0) {
        this.setSpatialSkeletonGridLevel(
          "3d",
          findClosestSpatialSkeletonGridLevelBySpacing(
            levels,
            this.spatialSkeletonGridResolutionTarget3d.value,
          ),
        );
      }
    });
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
  hiddenObjectAlpha = trackableAlphaValue(0.5);
  spatialSkeletonGridLevel2d = new TrackableValue<number>(
    0,
    verifyNonnegativeInt,
    0,
  );
  spatialSkeletonGridLevel3d = new TrackableValue<number>(
    0,
    verifyNonnegativeInt,
    0,
  );
  spatialSkeletonGridLevels = new WatchableValue<SpatialSkeletonGridLevel[]>(
    [],
  );
  spatialSkeletonGridResolutionTarget2d = new TrackableValue<number>(
    1,
    verifyFiniteNonNegativeFloat,
    1,
  );
  spatialSkeletonGridResolutionTarget3d = new TrackableValue<number>(
    1,
    verifyFiniteNonNegativeFloat,
    1,
  );
  spatialSkeletonGridRenderScaleHistogram2d = new RenderScaleHistogram();
  spatialSkeletonGridRenderScaleHistogram3d = new RenderScaleHistogram();
  spatialSkeletonNodeQuery = new TrackableValue<string>("", verifyString);
  spatialSkeletonNodeFilter = new TrackableEnum(
    SpatialSkeletonNodeFilterType,
    SpatialSkeletonNodeFilterType.NONE,
  );
  ignoreNullVisibleSet = new TrackableBoolean(true, true);
  skeletonRenderingOptions = new SkeletonRenderingOptions();
  shaderError = makeWatchableShaderError();
  renderScaleHistogram = new RenderScaleHistogram();
  renderScaleTarget = trackableRenderScaleTarget(1);
  selectSegment: (id: bigint, pin: boolean | "toggle" | "force-unpin") => void;
  transparentPickEnabled: TrackableBoolean;
  baseSegmentColoring = new TrackableBoolean(false, false);
  baseSegmentHighlighting = new TrackableBoolean(false, false);
  useTempSegmentStatedColors2d: SharedWatchableValue<boolean>;
  hasVolume = new TrackableBoolean(false, false);

  filterBySegmentLabel: (id: bigint) => void;

  moveToSegment = (id: bigint) => {
    this.layer.moveToSegment(id);
  };

  setSpatialSkeletonGridSizes(gridSizes: SpatialSkeletonGridSize[]) {
    const sortedSizes = [...gridSizes].sort(
      (a, b) => Math.min(b.x, b.y, b.z) - Math.min(a.x, a.y, a.z),
    );
    const levels = buildSpatialSkeletonGridLevels(sortedSizes);
    const { origin: histogramOrigin, binSize: histogramBinSize } =
      getSpatialSkeletonGridHistogramConfig(levels);
    if (
      this.spatialSkeletonGridRenderScaleHistogram2d.logScaleOrigin !==
        histogramOrigin ||
      this.spatialSkeletonGridRenderScaleHistogram2d.logScaleBinSize !==
        histogramBinSize
    ) {
      this.spatialSkeletonGridRenderScaleHistogram2d.logScaleOrigin =
        histogramOrigin;
      this.spatialSkeletonGridRenderScaleHistogram2d.logScaleBinSize =
        histogramBinSize;
      this.spatialSkeletonGridRenderScaleHistogram2d.changed.dispatch();
    }
    if (
      this.spatialSkeletonGridRenderScaleHistogram3d.logScaleOrigin !==
        histogramOrigin ||
      this.spatialSkeletonGridRenderScaleHistogram3d.logScaleBinSize !==
        histogramBinSize
    ) {
      this.spatialSkeletonGridRenderScaleHistogram3d.logScaleOrigin =
        histogramOrigin;
      this.spatialSkeletonGridRenderScaleHistogram3d.logScaleBinSize =
        histogramBinSize;
      this.spatialSkeletonGridRenderScaleHistogram3d.changed.dispatch();
    }
    this.spatialSkeletonGridLevels.value = levels;
    if (levels.length === 0) return;
    const target3dIndex = findClosestSpatialSkeletonGridLevelBySpacing(
      levels,
      this.spatialSkeletonGridResolutionTarget3d.value,
    );
    this.setSpatialSkeletonGridLevel("3d", target3dIndex);
    const target2dIndex = findClosestSpatialSkeletonGridLevelBySpacing(
      levels,
      this.spatialSkeletonGridResolutionTarget2d.value,
    );
    this.setSpatialSkeletonGridLevel("2d", target2dIndex);
  }

  private setSpatialSkeletonGridLevel(kind: "2d" | "3d", index: number) {
    const levels = this.spatialSkeletonGridLevels.value;
    if (levels.length === 0) return 0;
    const clampedIndex = Math.min(Math.max(index, 0), levels.length - 1);
    if (kind === "2d") {
      this.spatialSkeletonGridLevel2d.value = clampedIndex;
      return clampedIndex;
    }
    this.spatialSkeletonGridLevel3d.value = clampedIndex;
    return clampedIndex;
  }

  linkedSegmentationGroup: LinkedLayerGroup;
  linkedSegmentationColorGroup: LinkedLayerGroup;
  originalSegmentationGroupState: SegmentationUserLayerGroupState;
  originalSegmentationColorGroupState: SegmentationUserLayerColorGroupState;

  segmentationGroupState: WatchableValueInterface<SegmentationUserLayerGroupState>;
  segmentationColorGroupState: WatchableValueInterface<SegmentationUserLayerColorGroupState>;

  // Indirect properties
  hideSegmentZero: WatchableValueInterface<boolean>;
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

interface SelectedSpatialSkeletonNodeInfo {
  nodeId: number;
  segmentId?: number;
  position?: Float32Array;
  sourceState?: SpatialSkeletonSourceState;
}

function normalizeOptionalPositiveSafeInteger(value: unknown) {
  if (value === undefined) return undefined;
  const normalized = Math.round(Number(value));
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : undefined;
}

function copyOptionalSpatialSkeletonPosition(
  value: ArrayLike<number> | undefined,
) {
  if (value === undefined) return undefined;
  return new Float32Array(Array.from(value, Number));
}

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
  codeVisible = new TrackableBoolean(true);
  readonly spatialSkeletonState = this.registerDisposer(
    new SpatialSkeletonState(),
  );
  readonly selectedSpatialSkeletonNodeId = new WatchableValue<
    number | undefined
  >(undefined);
  readonly selectedSpatialSkeletonNodeInfo = new WatchableValue<
    SelectedSpatialSkeletonNodeInfo | undefined
  >(undefined);
  readonly hoveredSpatialSkeletonNodeId = this.registerDisposer(
    new SpatialSkeletonHoverState(),
  );
  readonly spatialSkeletonVisibleChunksNeeded = new WatchableValue(0);
  readonly spatialSkeletonVisibleChunksAvailable = new WatchableValue(0);
  readonly spatialSkeletonVisibleChunksLoaded = new WatchableValue(false);

  graphConnection = new WatchableValue<
    SegmentationGraphSourceConnection | undefined
  >(undefined);

  bindSegmentListWidth(element: HTMLElement) {
    return bindSegmentListWidth(this.displayState, element);
  }

  segmentQueryFocusTime = new WatchableValue<number>(Number.NEGATIVE_INFINITY);

  selectSegment = (id: bigint, pin: boolean | "toggle" | "force-unpin") => {
    this.manager.root.selectionState.captureSingleLayerState(
      this,
      (state) => {
        state.value = id;
        return true;
      },
      pin,
    );
  };

  private captureSpatialSkeletonSelectionState(
    capture: (state: this["selectionState"]) => boolean,
    pin: boolean | "toggle" | "force-unpin",
    options: { position?: ArrayLike<number> } = {},
  ) {
    const selectionState = this.manager.root.selectionState;
    if (pin !== false || selectionState.pin.value) {
      selectionState.captureSingleLayerState(this, capture, pin, options);
      return;
    }
    const state = {} as UserLayerSelectionState;
    this.initializeSelectionState(state);
    if (!capture(state)) return;
    selectionState.value = {
      layers: [{ layer: this, state }],
      coordinateSpace: selectionState.coordinateSpace.value,
      position:
        options.position === undefined
          ? undefined
          : new Float32Array(options.position),
    };
  }

  private getGlobalSelectionPositionFromModelPosition(
    modelPosition: ArrayLike<number> | undefined,
  ) {
    if (modelPosition === undefined) return undefined;
    const transform =
      this.getSpatiallyIndexedSkeletonLayer()?.displayState.transform.value;
    if (transform === undefined || transform.error !== undefined)
      return undefined;
    const rank = transform.rank;
    const paddedModelPosition = new Float32Array(rank);
    for (let i = 0; i < Math.min(modelPosition.length, rank); ++i) {
      paddedModelPosition[i] = Number(modelPosition[i]);
    }
    const layerPosition = new Float32Array(rank);
    matrix.transformPoint(
      layerPosition,
      transform.modelToRenderLayerTransform,
      rank + 1,
      paddedModelPosition,
      rank,
    );
    const result = this.manager.root.globalPosition.value.slice();
    gatherUpdate(
      result,
      layerPosition,
      transform.globalToRenderLayerDimensions,
    );
    return result;
  }

  moveViewToSpatialSkeletonNodePosition(position: ArrayLike<number>) {
    const transform =
      this.getSpatiallyIndexedSkeletonLayer()?.displayState.transform.value;
    if (transform === undefined || transform.error !== undefined) return;
    const rank = transform.rank;
    const modelPosition = new Float32Array(rank);
    for (let i = 0; i < Math.min(position.length, rank); ++i) {
      modelPosition[i] = Number(position[i]);
    }
    const layerPosition = new Float32Array(rank);
    matrix.transformPoint(
      layerPosition,
      transform.modelToRenderLayerTransform,
      rank + 1,
      modelPosition,
      rank,
    );
    this.setLayerPosition(transform, layerPosition);
  }

  selectSpatialSkeletonNode = (
    nodeId: number,
    pin: boolean | "toggle" = false,
    options: {
      segmentId?: number;
      position?: ArrayLike<number>;
      sourceState?: SpatialSkeletonSourceState;
    } = {},
  ) => {
    const normalizedNodeId = normalizeOptionalPositiveSafeInteger(nodeId);
    if (normalizedNodeId === undefined) {
      return;
    }
    const selectedNodeInfo =
      this.getSpatiallyIndexedSkeletonLayer()?.getNode(normalizedNodeId);
    const requestedSegmentId =
      options.segmentId ?? selectedNodeInfo?.segmentId ?? undefined;
    const segmentId = normalizeOptionalPositiveSafeInteger(requestedSegmentId);
    const selectedNodePosition = options.position ?? selectedNodeInfo?.position;
    const selectedGlobalPosition =
      this.getGlobalSelectionPositionFromModelPosition(selectedNodePosition);
    const sourceState = options.sourceState ?? selectedNodeInfo?.sourceState;
    this.selectedSpatialSkeletonNodeInfo.value = {
      nodeId: normalizedNodeId,
      segmentId,
      position: copyOptionalSpatialSkeletonPosition(selectedNodePosition),
      sourceState,
    };
    this.captureSpatialSkeletonSelectionState(
      (state) => {
        state.nodeId = normalizedNodeId.toString();
        state.value = segmentId === undefined ? undefined : BigInt(segmentId);
        return true;
      },
      pin,
      { position: selectedGlobalPosition },
    );
  };

  selectAndMoveToSpatialSkeletonNode(
    node:
      | Pick<SpatiallyIndexedSkeletonNode, "nodeId" | "segmentId" | "position">
      | undefined,
    pin: boolean | "toggle" = this.manager.root.selectionState.pin.value,
  ) {
    if (node === undefined) {
      this.clearSpatialSkeletonNodeSelection(pin);
      return false;
    }
    this.selectSpatialSkeletonNode(node.nodeId, pin, {
      segmentId: node.segmentId,
      position: node.position,
    });
    this.moveViewToSpatialSkeletonNodePosition(node.position);
    return true;
  }

  inspectSpatialSkeletonSegment = (
    segmentId: number,
    options: { secondary?: boolean } = {},
  ) => {
    void options;
    const normalizedSegmentId = Math.round(Number(segmentId));
    if (
      !Number.isSafeInteger(normalizedSegmentId) ||
      normalizedSegmentId <= 0
    ) {
      return false;
    }
    const visibleSegments = getVisibleSegments(
      this.displayState.segmentationGroupState.value,
    );
    if (visibleSegments.has(BigInt(normalizedSegmentId))) {
      return false;
    }
    addSegmentToVisibleSets(
      this.displayState.segmentationGroupState.value,
      BigInt(normalizedSegmentId),
    );
    return true;
  };

  setSpatialSkeletonMergeAnchor = (nodeId: number | undefined) => {
    return this.spatialSkeletonState.setMergeAnchor(nodeId);
  };

  clearSpatialSkeletonMergeAnchor = () => {
    return this.spatialSkeletonState.clearMergeAnchor();
  };

  ensureSpatialSkeletonInspectionFromSelection = () => {
    const selectedNodeId = this.selectedSpatialSkeletonNodeId.value;
    const selectedNode =
      selectedNodeId === undefined
        ? undefined
        : this.spatialSkeletonState.getCachedNode(selectedNodeId);
    const visibleSegments = getVisibleSegments(
      this.displayState.segmentationGroupState.value,
    );
    if (
      selectedNode !== undefined &&
      visibleSegments.has(BigInt(selectedNode.segmentId))
    ) {
      return selectedNode.segmentId;
    }
    const selectedSegmentValue =
      this.displayState.segmentSelectionState.baseValue ?? undefined;
    const selectedSegmentId =
      selectedSegmentValue === undefined
        ? undefined
        : Number(selectedSegmentValue);
    if (
      selectedSegmentId === undefined ||
      !Number.isSafeInteger(selectedSegmentId) ||
      selectedSegmentId <= 0
    ) {
      return undefined;
    }
    return visibleSegments.has(BigInt(selectedSegmentId))
      ? selectedSegmentId
      : undefined;
  };

  clearSpatialSkeletonNodeSelection = (
    pin: boolean | "toggle" | "force-unpin" = false,
  ) => {
    this.selectedSpatialSkeletonNodeInfo.value = undefined;
    this.captureSpatialSkeletonSelectionState((state) => {
      state.nodeId = undefined;
      state.value = undefined;
      return true;
    }, pin);
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
  readonly spatialSkeletonEditMode = this.spatialSkeletonState.editMode;
  readonly spatialSkeletonMergeMode = this.spatialSkeletonState.mergeMode;
  readonly spatialSkeletonSplitMode = this.spatialSkeletonState.splitMode;
  readonly spatialSkeletonNodeDataVersion =
    this.spatialSkeletonState.nodeDataVersion;

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
    const syncSelectedSpatialSkeletonNodeIdFromGlobalSelection = () => {
      const nextLayerSelectionState =
        this.manager.root.selectionState.value?.layers.find(
          (entry) => entry.layer === this,
        )?.state;
      const nextSelectedNodeId = getNodeIdFromLayerSelectionState(
        nextLayerSelectionState,
      );
      const nextSelectedSegmentId = getSegmentIdFromLayerSelectionValue(
        nextLayerSelectionState,
      );
      if (this.selectedSpatialSkeletonNodeId.value !== nextSelectedNodeId) {
        this.selectedSpatialSkeletonNodeId.value = nextSelectedNodeId;
      }
      const selectedNodeInfo = this.selectedSpatialSkeletonNodeInfo.value;
      if (
        selectedNodeInfo !== undefined &&
        (selectedNodeInfo.nodeId !== nextSelectedNodeId ||
          selectedNodeInfo.segmentId !== nextSelectedSegmentId)
      ) {
        this.selectedSpatialSkeletonNodeInfo.value = undefined;
      }
    };
    this.registerDisposer(
      this.manager.root.selectionState.changed.add(
        syncSelectedSpatialSkeletonNodeIdFromGlobalSelection,
      ),
    );
    syncSelectedSpatialSkeletonNodeIdFromGlobalSelection();
    this.hoveredSpatialSkeletonNodeId.bindTo(
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
    this.displayState.hiddenObjectAlpha.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.spatialSkeletonNodeQuery.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.spatialSkeletonNodeFilter.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.spatialSkeletonGridResolutionTarget2d.changed.add(
      this.specificationChanged.dispatch,
    );
    this.displayState.spatialSkeletonGridResolutionTarget3d.changed.add(
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
    this.registerDisposer(
      this.layersChanged.add(() => this.updateSpatialSkeletonChunkLoadState()),
    );
    this.registerDisposer(
      this.layersChanged.add(() => this.updateSpatialSkeletonSourceState()),
    );
    this.registerDisposer(
      this.manager.chunkManager.layerChunkStatisticsUpdated.add(() =>
        this.updateSpatialSkeletonChunkLoadState(),
      ),
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
    const hideSpatialSkeletonEditTab = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (layers) =>
          !layers.some(
            (layer) =>
              (layer instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer ||
                layer instanceof SliceViewPanelSpatiallyIndexedSkeletonLayer ||
                layer instanceof SliceViewSpatiallyIndexedSkeletonLayer) &&
              getSpatiallyIndexedSkeletonSource(layer.base) !== undefined,
          ),
        { changed: this.layersChanged, value: this.renderLayers },
      ),
    );
    this.tabs.add("skeleton", {
      label: "Skeleton",
      order: -45,
      getter: () => new SpatialSkeletonEditTab(this),
      hidden: hideSpatialSkeletonEditTab,
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
    this.updateSpatialSkeletonChunkLoadState();
    this.updateSpatialSkeletonSourceState();
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
            x instanceof SliceViewPanelSkeletonLayer ||
            x instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer ||
            x instanceof SliceViewPanelSpatiallyIndexedSkeletonLayer,
        ),
      { changed: this.layersChanged, value: this.renderLayers },
    ),
  );

  readonly hasSkeletonsLayer = this.registerDisposer(
    makeCachedLazyDerivedWatchableValue(
      (layers) =>
        layers.some(
          (x) =>
            x instanceof PerspectiveViewSkeletonLayer ||
            x instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer,
        ),
      { changed: this.layersChanged, value: this.renderLayers },
    ),
  );

  readonly hasSpatiallyIndexedSkeletonsLayer = this.registerDisposer(
    makeCachedLazyDerivedWatchableValue(
      (layers) =>
        layers.some(
          (x) =>
            x instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer ||
            x instanceof SliceViewPanelSpatiallyIndexedSkeletonLayer,
        ),
      { changed: this.layersChanged, value: this.renderLayers },
    ),
  );

  readonly getSkeletonLayer = () => {
    for (const layer of this.renderLayers) {
      if (layer instanceof PerspectiveViewSkeletonLayer) {
        return layer.base;
      }
      if (layer instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer) {
        return layer.base;
      }
    }
    return undefined;
  };

  readonly getSpatiallyIndexedSkeletonLayer = () => {
    for (const layer of this.renderLayers) {
      if (layer instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer) {
        return layer.base;
      }
      if (layer instanceof SliceViewPanelSpatiallyIndexedSkeletonLayer) {
        return layer.base;
      }
      if (layer instanceof SliceViewSpatiallyIndexedSkeletonLayer) {
        return layer.base;
      }
    }
    return undefined;
  };

  getSpatialSkeletonChunkStats(kind: "2d" | "3d") {
    let needed = 0;
    let available = 0;
    for (const layer of this.renderLayers) {
      if (
        kind === "3d" &&
        layer instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer
      ) {
        needed += layer.layerChunkProgressInfo.numVisibleChunksNeeded;
        available += layer.layerChunkProgressInfo.numVisibleChunksAvailable;
        continue;
      }
      if (
        kind === "2d" &&
        (layer instanceof SliceViewSpatiallyIndexedSkeletonLayer ||
          layer instanceof MultiscaleSliceViewSpatiallyIndexedSkeletonLayer)
      ) {
        needed += layer.layerChunkProgressInfo.numVisibleChunksNeeded;
        available += layer.layerChunkProgressInfo.numVisibleChunksAvailable;
      }
    }
    return { presentCount: available, totalCount: needed };
  }

  private setSpatialSkeletonChunkLoadState(needed: number, available: number) {
    if (this.spatialSkeletonVisibleChunksNeeded.value !== needed) {
      this.spatialSkeletonVisibleChunksNeeded.value = needed;
    }
    if (this.spatialSkeletonVisibleChunksAvailable.value !== available) {
      this.spatialSkeletonVisibleChunksAvailable.value = available;
    }
    const loaded = needed > 0 && available >= needed;
    if (this.spatialSkeletonVisibleChunksLoaded.value !== loaded) {
      this.spatialSkeletonVisibleChunksLoaded.value = loaded;
    }
  }

  private updateSpatialSkeletonChunkLoadState() {
    const stats2d = this.getSpatialSkeletonChunkStats("2d");
    const stats3d = this.getSpatialSkeletonChunkStats("3d");
    this.setSpatialSkeletonChunkLoadState(
      stats2d.totalCount + stats3d.totalCount,
      stats2d.presentCount + stats3d.presentCount,
    );
  }

  private updateSpatialSkeletonSourceState() {
    let hasSpatialSkeletonLayer = false;
    for (const layer of this.renderLayers) {
      if (
        layer instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer ||
        layer instanceof SliceViewPanelSpatiallyIndexedSkeletonLayer ||
        layer instanceof SliceViewSpatiallyIndexedSkeletonLayer
      ) {
        hasSpatialSkeletonLayer = true;
        break;
      }
    }
    if (!hasSpatialSkeletonLayer) {
      this.spatialSkeletonState.clearInspectedSkeletonCache();
    }
    this.spatialSkeletonState.updateCommandHistorySource(
      this.getSpatialSkeletonCommandHistorySource(),
    );
  }

  private getSpatialSkeletonCommandHistorySource() {
    for (const layer of this.renderLayers) {
      if (
        layer instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer ||
        layer instanceof SliceViewPanelSpatiallyIndexedSkeletonLayer ||
        layer instanceof SliceViewSpatiallyIndexedSkeletonLayer
      ) {
        return layer.base.source;
      }
    }
    return undefined;
  }

  private supportsSpatialSkeletonAction(action: SpatialSkeletonAction) {
    const skeletonLayer = this.getSpatiallyIndexedSkeletonLayer();
    if (skeletonLayer === undefined) {
      return false;
    }
    if (action === SpatialSkeletonActions.inspect) {
      return getSpatiallyIndexedSkeletonSource(skeletonLayer) !== undefined;
    }
    return (
      getSpatialSkeletonEditCommandSource(skeletonLayer)?.supports(action) ??
      false
    );
  }

  private getMissingSpatialSkeletonSupportReason(
    requiredActions: SpatialSkeletonAction | readonly SpatialSkeletonAction[],
  ) {
    const requirements = Array.isArray(requiredActions)
      ? requiredActions
      : [requiredActions];
    const missingRequirements = requirements.filter(
      (action) => !this.supportsSpatialSkeletonAction(action),
    );
    if (missingRequirements.length === 0) {
      return undefined;
    }
    const names = missingRequirements.map(getSpatialSkeletonActionSupportLabel);
    return `The active spatial skeleton source does not support ${names.join(", ")}.`;
  }

  getSpatialSkeletonActionsDisabledReason(
    requiredActions:
      | SpatialSkeletonAction
      | readonly SpatialSkeletonAction[] = DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS,
    options: {
      requireVisibleChunks?: boolean;
    } = {},
  ) {
    const { requireVisibleChunks = false } = options;
    const missingSupportReason =
      this.getMissingSpatialSkeletonSupportReason(requiredActions);
    if (missingSupportReason !== undefined) {
      return missingSupportReason;
    }
    if (
      requireVisibleChunks &&
      !this.spatialSkeletonVisibleChunksLoaded.value
    ) {
      const needed = this.spatialSkeletonVisibleChunksNeeded.value;
      const available = this.spatialSkeletonVisibleChunksAvailable.value;
      if (needed === 0) {
        return "Waiting for visible skeleton chunks.";
      }
      return `Wait for visible skeleton chunks to load (${available}/${needed}).`;
    }
    return undefined;
  }

  getCachedSpatialSkeletonSegmentNodesForEdit(segmentId: number) {
    const segmentNodes =
      this.spatialSkeletonState.getCachedSegmentNodes(segmentId);
    if (segmentNodes === undefined) {
      throw new Error(
        `Segment ${segmentId} is not available in the inspected skeleton cache. Load the full skeleton before editing it.`,
      );
    }
    return segmentNodes;
  }

  async getSpatialSkeletonDeleteOperationContext(
    node: SpatiallyIndexedSkeletonNode,
  ) {
    const skeletonLayer = this.getSpatiallyIndexedSkeletonLayer();
    if (skeletonLayer === undefined) {
      throw new Error(
        "No active spatial skeleton layer found for delete action.",
      );
    }
    if (getSpatialSkeletonEditCommandSource(skeletonLayer) === undefined) {
      throw new Error(
        "Unable to resolve editable skeleton source for the active layer.",
      );
    }

    const segmentNodes = this.getCachedSpatialSkeletonSegmentNodesForEdit(
      node.segmentId,
    );
    const currentNode = findSpatiallyIndexedSkeletonNode(
      segmentNodes,
      node.nodeId,
    );
    if (currentNode === undefined) {
      throw new Error(
        `Node ${node.nodeId} is not available in the inspected skeleton cache.`,
      );
    }
    const childNodes = getSpatiallyIndexedSkeletonDirectChildren(
      segmentNodes,
      currentNode.nodeId,
    );
    if (currentNode.parentNodeId === undefined && childNodes.length > 0) {
      throw new Error(
        "Deleting a root node with children is blocked. Reroot the skeleton manually before deleting it.",
      );
    }
    return {
      node: currentNode,
      parentNode: getSpatiallyIndexedSkeletonNodeParent(
        segmentNodes,
        currentNode,
      ),
      childNodes,
    };
  }

  getSpatialSkeletonNodeDisplayDescription(node: SpatiallyIndexedSkeletonNode) {
    return node.description?.length ? node.description : undefined;
  }

  async rerootSpatialSkeletonNode(
    node: Pick<
      SpatiallyIndexedSkeletonNode,
      "nodeId" | "segmentId" | "parentNodeId" | "position"
    >,
  ) {
    if (node.parentNodeId === undefined) {
      throw new Error(`Node ${node.nodeId} is already root.`);
    }
    await executeSpatialSkeletonReroot(this, node);
  }

  markSpatialSkeletonNodeDataChanged(options?: {
    invalidateFullSkeletonCache?: boolean;
  }) {
    this.spatialSkeletonState.markNodeDataChanged(options);
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    const updatedSegmentPropertyMaps: SegmentPropertyMap[] = [];
    const isGroupRoot =
      this.displayState.linkedSegmentationGroup.root.value === this;
    let updatedGraph: SegmentationGraphSource | undefined;
    let hasVolume = false;
    let spatialSkeletonGridSizes: SpatialSkeletonGridSize[] | undefined;
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
        hasVolume = true;
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
        if (mesh instanceof MultiscaleSpatiallyIndexedSkeletonSource) {
          // Collect grid metadata outside `activate`, since `activate` is a no-op
          // when guard values are unchanged and may skip the callback.
          spatialSkeletonGridSizes = mesh.getSpatialSkeletonGridSizes();
        }
        loadedSubsource.activate(() => {
          const displayState = {
            ...this.displayState,
            transform: loadedSubsource.getRenderLayerTransform(),
            localPosition: this.localPosition,
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
          } else if (mesh instanceof MultiscaleSpatiallyIndexedSkeletonSource) {
            const base = new MultiscaleSliceViewSpatiallyIndexedSkeletonLayer(
              this.manager.chunkManager,
              mesh,
              displayState,
            );
            loadedSubsource.addRenderLayer(base);

            const perspectiveSources = mesh.getPerspectiveSources();
            const slicePanelSources = mesh.getSliceViewPanelSources();
            const sharedSpatialSkeletonSources =
              perspectiveSources.length > 0
                ? perspectiveSources
                : slicePanelSources;
            if (sharedSpatialSkeletonSources.length > 0) {
              // Share one mutable skeleton base across 2D/3D projections so
              // local edit state stays consistent across panels.
              const base = new SpatiallyIndexedSkeletonLayer(
                this.manager.chunkManager,
                sharedSpatialSkeletonSources,
                displayState,
                {
                  gridLevel: displayState.spatialSkeletonGridLevel3d,
                  sources2d: slicePanelSources,
                  selectedNodeId: this.selectedSpatialSkeletonNodeId,
                  pendingNodePositionVersion:
                    this.spatialSkeletonState.pendingNodePositionVersion,
                  getPendingNodePosition: (nodeId) =>
                    this.spatialSkeletonState.getPendingNodePosition(nodeId),
                  getCachedNode: (nodeId) =>
                    this.spatialSkeletonState.getCachedNode(nodeId),
                  inspectionState: this.spatialSkeletonState,
                },
              );
              if (perspectiveSources.length > 0) {
                loadedSubsource.addRenderLayer(
                  new PerspectiveViewSpatiallyIndexedSkeletonLayer(
                    base.addRef(),
                  ),
                );
              }
              if (slicePanelSources.length > 0) {
                loadedSubsource.addRenderLayer(
                  new SliceViewPanelSpatiallyIndexedSkeletonLayer(
                    /* transfer ownership */ base,
                  ),
                );
              } else {
                base.dispose();
              }
            }
          } else if (mesh instanceof SpatiallyIndexedSkeletonSource) {
            const base = new SpatiallyIndexedSkeletonLayer(
              this.manager.chunkManager,
              mesh,
              displayState,
              {
                gridLevel: displayState.spatialSkeletonGridLevel3d,
                selectedNodeId: this.selectedSpatialSkeletonNodeId,
                pendingNodePositionVersion:
                  this.spatialSkeletonState.pendingNodePositionVersion,
                getPendingNodePosition: (nodeId) =>
                  this.spatialSkeletonState.getPendingNodePosition(nodeId),
                getCachedNode: (nodeId) =>
                  this.spatialSkeletonState.getCachedNode(nodeId),
                inspectionState: this.spatialSkeletonState,
              },
            );
            loadedSubsource.addRenderLayer(
              new PerspectiveViewSpatiallyIndexedSkeletonLayer(base.addRef()),
            );
            loadedSubsource.addRenderLayer(
              new SliceViewSpatiallyIndexedSkeletonLayer(base.addRef()),
            );
            loadedSubsource.addRenderLayer(
              new SliceViewPanelSpatiallyIndexedSkeletonLayer(
                /* transfer ownership */ base,
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
    this.displayState.setSpatialSkeletonGridSizes(
      spatialSkeletonGridSizes ?? [],
    );
    this.displayState.hasVolume.value = hasVolume;
    this.updateSpatialSkeletonChunkLoadState();
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
    this.displayState.hiddenObjectAlpha.restoreState(
      specification[json_keys.HIDDEN_OPACITY_3D_JSON_KEY],
    );
    this.displayState.spatialSkeletonNodeQuery.restoreState(
      specification[json_keys.SPATIAL_SKELETON_NODE_QUERY_JSON_KEY],
    );
    verifyOptionalObjectProperty(
      specification,
      json_keys.SPATIAL_SKELETON_NODE_FILTER_JSON_KEY,
      (value) =>
        this.displayState.spatialSkeletonNodeFilter.restoreState(value),
    );
    this.displayState.spatialSkeletonGridResolutionTarget2d.restoreState(
      specification[json_keys.SKELETON_CROSS_SECTION_RENDER_SCALE_JSON_KEY],
    );
    this.displayState.spatialSkeletonGridResolutionTarget3d.restoreState(
      specification[json_keys.SKELETON_PERSPECTIVE_RENDER_SCALE_JSON_KEY],
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
    x[json_keys.SPATIAL_SKELETON_NODE_QUERY_JSON_KEY] =
      this.displayState.spatialSkeletonNodeQuery.toJSON();
    x[json_keys.SPATIAL_SKELETON_NODE_FILTER_JSON_KEY] =
      this.displayState.spatialSkeletonNodeFilter.toJSON();
    x[json_keys.HIDDEN_OPACITY_3D_JSON_KEY] =
      this.displayState.hiddenObjectAlpha.toJSON();
    x[json_keys.SKELETON_CROSS_SECTION_RENDER_SCALE_JSON_KEY] =
      this.displayState.spatialSkeletonGridResolutionTarget2d.toJSON();
    x[json_keys.SKELETON_PERSPECTIVE_RENDER_SCALE_JSON_KEY] =
      this.displayState.spatialSkeletonGridResolutionTarget3d.toJSON();
    x[json_keys.HOVER_HIGHLIGHT_JSON_KEY] =
      this.displayState.hoverHighlight.toJSON();
    x[json_keys.BASE_SEGMENT_COLORING_JSON_KEY] =
      this.displayState.baseSegmentColoring.toJSON();
    x[json_keys.IGNORE_NULL_VISIBLE_SET_JSON_KEY] =
      this.displayState.ignoreNullVisibleSet.toJSON();
    x[json_keys.MESH_SILHOUETTE_RENDERING_JSON_KEY] =
      this.displayState.silhouetteRendering.toJSON();
    x[json_keys.ANCHOR_SEGMENT_JSON_KEY] = this.anchorSegment
      .toJSON()
      ?.toString();
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
    let parsedValue = state.value;
    if (typeof parsedValue === "number") parsedValue = parsedValue.toString();
    try {
      state.value = parseUint64(parsedValue);
    } catch {
      state.value = undefined;
    }
  }

  captureSelectionState(
    state: this["selectionState"],
    mouseState: MouseSelectionState,
  ) {
    super.captureSelectionState(state, mouseState);
    const pickedSpatialSkeleton = mouseState.pickedSpatialSkeleton;
    if (pickedSpatialSkeleton === undefined) return;
    const pickedRenderLayer = mouseState.pickedRenderLayer;
    if (
      pickedRenderLayer !== null &&
      !this.renderLayers.includes(pickedRenderLayer)
    ) {
      return;
    }
    const nodeId = normalizeOptionalPositiveSafeInteger(
      pickedSpatialSkeleton.nodeId,
    );
    state.nodeId = nodeId === undefined ? undefined : nodeId.toString();
    const segmentId = normalizeOptionalPositiveSafeInteger(
      pickedSpatialSkeleton.segmentId,
    );
    if (segmentId !== undefined) {
      state.value = BigInt(segmentId);
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

  private displaySpatialSkeletonSelection(
    state: this["selectionState"],
    parent: HTMLElement,
    context: DependentViewContext,
  ) {
    context.registerDisposer(
      this.spatialSkeletonNodeDataVersion.changed.add(context.redraw),
    );
    context.registerDisposer(
      this.selectedSpatialSkeletonNodeInfo.changed.add(context.redraw),
    );
    const nodeId = getNodeIdFromLayerSelectionState(state);
    if (nodeId === undefined) {
      return false;
    }

    const selectedSegmentId = getSegmentIdFromLayerSelectionValue(state);
    const skeletonLayer = this.getSpatiallyIndexedSkeletonLayer();
    const cachedNodeInfo = this.spatialSkeletonState.getCachedNode(nodeId);
    const completeNodeInfo = skeletonLayer?.getNode(nodeId) ?? cachedNodeInfo;
    const selectedNodeInfo = this.selectedSpatialSkeletonNodeInfo.value;
    const previewNodeInfo =
      selectedNodeInfo !== undefined &&
      selectedNodeInfo.nodeId === nodeId &&
      selectedNodeInfo.segmentId === selectedSegmentId
        ? selectedNodeInfo
        : undefined;
    const nodeInfo = completeNodeInfo ?? previewNodeInfo;
    const container = document.createElement("div");
    container.classList.add("neuroglancer-spatial-skeleton-selection");
    parent.appendChild(container);

    const appendValue = (label: string, value: string | HTMLElement) => {
      const row = document.createElement("div");
      row.classList.add("neuroglancer-annotation-property");
      const nameElement = document.createElement("div");
      nameElement.classList.add("neuroglancer-annotation-property-label");
      nameElement.textContent = label;
      const valueElement = document.createElement("div");
      valueElement.classList.add("neuroglancer-annotation-property-value");
      if (typeof value === "string") {
        valueElement.textContent = value;
      } else {
        valueElement.appendChild(value);
      }
      row.appendChild(nameElement);
      row.appendChild(valueElement);
      container.appendChild(row);
    };

    const appendSegmentAndNodeIds = (segmentId: number, nodeId: number) => {
      const segmentChipColors = getSpatialSkeletonSegmentChipColors(
        this.displayState,
        segmentId,
      );
      const segmentIdChip = document.createElement("span");
      segmentIdChip.className =
        "neuroglancer-spatial-skeleton-node-segment-chip";
      segmentIdChip.textContent = `${segmentId}`;
      segmentIdChip.style.backgroundColor = segmentChipColors.background;
      segmentIdChip.style.color = segmentChipColors.foreground;
      segmentIdChip.title =
        `Segment ${segmentId}\n` +
        "Ctrl+right-click to pin selection\n" +
        "Ctrl+shift+right-click to unpin";
      bindSpatialSkeletonSegmentSelection(
        segmentIdChip,
        this.selectSegment,
        segmentId,
      );
      appendValue("Segment ID", segmentIdChip);
      appendValue("Node ID", `${nodeId}`);
    };

    if (completeNodeInfo === undefined) {
      const segmentId = nodeInfo?.segmentId ?? selectedSegmentId;
      if (segmentId !== undefined) {
        appendSegmentAndNodeIds(segmentId, nodeId);
        return true;
      }
      const valueElement = document.createElement("div");
      valueElement.classList.add(
        "neuroglancer-selection-details-segment-description",
      );
      valueElement.textContent =
        "Selected node is not available in the current loaded or cached skeleton data.";
      container.appendChild(valueElement);
      return true;
    }

    const fullNodeInfo = completeNodeInfo;
    const segmentId = fullNodeInfo.segmentId;
    const nodePosition = fullNodeInfo.position;
    const segmentNodes =
      this.spatialSkeletonState.getCachedSegmentNodes(segmentId);
    const directChildNodeIds =
      segmentNodes
        ?.filter((candidate) => candidate.parentNodeId === fullNodeInfo.nodeId)
        .map((candidate) => candidate.nodeId) ?? [];
    const nodeHasTrueEnd = fullNodeInfo.isTrueEnd ?? false;
    const nodeType = getSpatialSkeletonDisplayNodeType(
      fullNodeInfo,
      segmentNodes === undefined ? undefined : directChildNodeIds.length,
    );
    const nodeTypeLabel =
      nodeType === undefined
        ? "Unknown"
        : getSpatialSkeletonNodeTypeLabel(nodeType, nodeHasTrueEnd);
    const iconFilterType =
      nodeType === undefined
        ? undefined
        : getSpatialSkeletonNodeIconFilterType({
            nodeIsTrueEnd: nodeHasTrueEnd,
            nodeType,
          });
    const summaryRow = document.createElement("div");
    summaryRow.classList.add("neuroglancer-spatial-skeleton-selection-summary");
    container.appendChild(summaryRow);

    const editCommandSource =
      getSpatialSkeletonEditCommandSource(skeletonLayer);
    const rerootDisabledReason =
      editCommandSource === undefined
        ? "Unable to resolve a reroot-capable skeleton source for the active layer."
        : segmentNodes === undefined
          ? "Load the active skeleton in the Skeleton tab before rerooting from Selection."
          : fullNodeInfo.parentNodeId === undefined
            ? "Selected node is already root."
            : this.getSpatialSkeletonActionsDisabledReason(
                SpatialSkeletonActions.reroot,
                {
                  requireVisibleChunks: false,
                },
              );
    const rerootButton = document.createElement("button");
    rerootButton.type = "button";
    rerootButton.className = "neuroglancer-spatial-skeleton-selection-action";
    rerootButton.disabled = rerootDisabledReason !== undefined;
    rerootButton.title = rerootDisabledReason ?? "Set as root";
    rerootButton.appendChild(
      makeIcon({
        svg: svg_origin,
        title: rerootButton.title,
        clickable: false,
      }),
    );
    let rerootPending = false;
    rerootButton.addEventListener("click", () => {
      if (
        rerootButton.disabled ||
        rerootPending ||
        completeNodeInfo === undefined ||
        completeNodeInfo.parentNodeId === undefined
      ) {
        return;
      }
      rerootPending = true;
      rerootButton.disabled = true;
      void (async () => {
        try {
          await this.rerootSpatialSkeletonNode(completeNodeInfo);
        } catch (error) {
          showSpatialSkeletonActionError("set node as root", error);
        } finally {
          rerootPending = false;
          context.redraw();
        }
      })();
    });
    const deleteDisabledReason =
      editCommandSource === undefined
        ? "Unable to resolve editable skeleton source for the active layer."
        : segmentNodes === undefined
          ? "Load the active skeleton in the Skeleton tab before deleting from Selection."
          : fullNodeInfo.parentNodeId === undefined &&
              directChildNodeIds.length > 0
            ? "Reroot the skeleton manually before deleting the current root node."
            : this.getSpatialSkeletonActionsDisabledReason(
                SpatialSkeletonActions.deleteNodes,
              );
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "neuroglancer-spatial-skeleton-selection-action";
    deleteButton.disabled = deleteDisabledReason !== undefined;
    deleteButton.title = deleteDisabledReason ?? "Delete node";
    deleteButton.appendChild(
      makeDeleteButton({ title: deleteButton.title, clickable: false }),
    );
    let deletePending = false;
    deleteButton.addEventListener("click", () => {
      if (
        deleteButton.disabled ||
        editCommandSource === undefined ||
        completeNodeInfo === undefined ||
        deletePending
      ) {
        return;
      }
      deletePending = true;
      void (async () => {
        try {
          await executeSpatialSkeletonDeleteNode(this, completeNodeInfo);
        } catch (error) {
          showSpatialSkeletonActionError("delete node", error);
        } finally {
          deletePending = false;
        }
      })();
    });
    summaryRow.appendChild(rerootButton);
    summaryRow.appendChild(deleteButton);

    const icon = document.createElement("span");
    icon.className = "neuroglancer-spatial-skeleton-selection-summary-icon";
    const nodeTypeIconTitle =
      iconFilterType !== undefined
        ? getSpatialSkeletonNodeFilterLabel(iconFilterType)
        : nodeTypeLabel;
    icon.appendChild(
      makeIcon({
        svg:
          iconFilterType === SpatialSkeletonNodeFilterType.TRUE_END
            ? svg_flag
            : iconFilterType === SpatialSkeletonNodeFilterType.VIRTUAL_END
              ? svg_circle
              : nodeType === undefined
                ? svg_circle
                : SPATIAL_SKELETON_NODE_TYPE_ICONS[nodeType],
        title: nodeTypeIconTitle,
        clickable: false,
      }),
    );
    summaryRow.appendChild(icon);

    const skeletonDisplayTransform =
      skeletonLayer?.displayState.transform.value;
    let displayPosition: ArrayLike<number> = nodePosition;
    let displayNames: readonly string[] | undefined;
    if (
      skeletonDisplayTransform !== undefined &&
      skeletonDisplayTransform.error === undefined
    ) {
      const rank = skeletonDisplayTransform.rank;
      const modelPos = new Float32Array(rank);
      for (let i = 0; i < Math.min(nodePosition.length, rank); i++) {
        modelPos[i] = Number(nodePosition[i]);
      }
      const layerPos = new Float32Array(rank);
      matrix.transformPoint(
        layerPos,
        skeletonDisplayTransform.modelToRenderLayerTransform,
        rank + 1,
        modelPos,
        rank,
      );
      displayPosition = layerPos;
      displayNames = skeletonDisplayTransform.layerDimensionNames;
    }
    const position = formatSpatialSkeletonPosition(
      displayPosition,
      displayNames,
    );
    const summaryCoordinates = document.createElement("span");
    summaryCoordinates.className =
      "neuroglancer-spatial-skeleton-selection-summary-coordinates";
    summaryCoordinates.textContent = position.displayText;
    summaryCoordinates.title = position.fullText;
    summaryRow.appendChild(summaryCoordinates);

    appendSegmentAndNodeIds(segmentId, fullNodeInfo.nodeId);
    const isLeaf =
      segmentNodes !== undefined && directChildNodeIds.length === 0;
    const leafTypeEditingDisabledReason = () =>
      editCommandSource === undefined
        ? "Unable to resolve editable skeleton source for the active layer."
        : cachedNodeInfo === undefined || segmentNodes === undefined
          ? "Load the active skeleton in the Skeleton tab before changing leaf type."
          : this.getSpatialSkeletonActionsDisabledReason(
              SpatialSkeletonActions.editNodeTrueEnd,
            );
    if (isLeaf || nodeHasTrueEnd) {
      let committedTrueEnd = nodeHasTrueEnd;
      let leafTypeSavePending = false;
      const leafTypeEditor = document.createElement("div");
      leafTypeEditor.className = "neuroglancer-spatial-skeleton-leaf-type";
      const leafTypeRadioName = `neuroglancer-spatial-skeleton-leaf-type-${segmentId}-${fullNodeInfo.nodeId}`;
      const leafTypeOptionElements: HTMLLabelElement[] = [];
      const makeLeafTypeOption = (options: {
        label: string;
        svg: string;
        trueEnd: boolean;
      }) => {
        const option = document.createElement("label");
        option.className = "neuroglancer-spatial-skeleton-leaf-type-option";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = leafTypeRadioName;
        input.value = options.trueEnd ? "trueEnd" : "virtualEnd";
        input.className =
          "neuroglancer-spatial-skeleton-leaf-type-option-input";
        const icon = document.createElement("span");
        icon.className = "neuroglancer-spatial-skeleton-leaf-type-option-icon";
        icon.appendChild(
          makeIcon({
            svg: options.svg,
            title: options.label,
            clickable: false,
          }),
        );
        const text = document.createElement("span");
        text.className = "neuroglancer-spatial-skeleton-leaf-type-option-text";
        text.textContent = options.label;
        option.appendChild(input);
        option.appendChild(icon);
        option.appendChild(text);
        leafTypeOptionElements.push(option);
        leafTypeEditor.appendChild(option);
        return input;
      };
      const virtualEndInput = makeLeafTypeOption({
        label: "Virtual end",
        svg: svg_circle,
        trueEnd: false,
      });
      const trueEndInput = makeLeafTypeOption({
        label: "True end",
        svg: svg_flag,
        trueEnd: true,
      });
      const updateLeafTypeEditorState = () => {
        const disabledReason = leafTypeEditingDisabledReason();
        const editable = disabledReason === undefined && !leafTypeSavePending;
        virtualEndInput.checked = !committedTrueEnd;
        trueEndInput.checked = committedTrueEnd;
        for (const input of [virtualEndInput, trueEndInput]) {
          input.disabled = !editable;
          if (disabledReason !== undefined) {
            input.title = disabledReason;
          } else {
            input.removeAttribute("title");
          }
        }
        for (const option of leafTypeOptionElements) {
          option.classList.toggle(
            "neuroglancer-spatial-skeleton-leaf-type-option-disabled",
            !editable,
          );
          if (disabledReason !== undefined) {
            option.title = disabledReason;
          } else {
            option.removeAttribute("title");
          }
        }
      };
      const commitLeafType = (nextTrueEnd: boolean) => {
        if (leafTypeSavePending) return;
        const disabledReason = leafTypeEditingDisabledReason();
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          updateLeafTypeEditorState();
          return;
        }
        if (committedTrueEnd === nextTrueEnd) {
          updateLeafTypeEditorState();
          return;
        }
        const previousTrueEnd = committedTrueEnd;
        committedTrueEnd = nextTrueEnd;
        leafTypeSavePending = true;
        updateLeafTypeEditorState();
        void (async () => {
          try {
            const currentNode = this.spatialSkeletonState.getCachedNode(
              fullNodeInfo.nodeId,
            );
            if (currentNode === undefined) {
              throw new Error(
                `Node ${fullNodeInfo.nodeId} is missing from the inspected skeleton cache.`,
              );
            }
            await executeSpatialSkeletonNodeTrueEndUpdate(this, {
              node: currentNode,
              nextIsTrueEnd: nextTrueEnd,
            });
            committedTrueEnd = nextTrueEnd;
          } catch (error) {
            committedTrueEnd = previousTrueEnd;
            const message =
              error instanceof Error ? error.message : String(error);
            StatusMessage.showTemporaryMessage(
              `Failed to update leaf type: ${message}`,
            );
          } finally {
            leafTypeSavePending = false;
            updateLeafTypeEditorState();
          }
        })();
      };
      virtualEndInput.addEventListener("change", () => {
        if (!virtualEndInput.checked) return;
        commitLeafType(false);
      });
      trueEndInput.addEventListener("change", () => {
        if (!trueEndInput.checked) return;
        commitLeafType(true);
      });
      updateLeafTypeEditorState();
      appendValue("Node type", leafTypeEditor);
    } else {
      appendValue("Node type", nodeTypeLabel);
    }
    const nodeFeatureCapabilities = getEditableSpatiallyIndexedSkeletonSource(
      this.getSpatiallyIndexedSkeletonLayer(),
    )?.spatialSkeletonEditCapabilities?.nodeFeatures;
    const confidenceCapabilityValues =
      nodeFeatureCapabilities?.confidenceValues;
    const nodePropertiesEditable =
      (nodeFeatureCapabilities?.radius ?? false) &&
      confidenceCapabilityValues !== undefined;
    if (
      cachedNodeInfo === undefined ||
      segmentNodes === undefined ||
      !nodePropertiesEditable
    ) {
      appendValue(
        "Radius",
        formatSpatialSkeletonEditableNumber(fullNodeInfo.radius, "Unavailable"),
      );
      appendValue(
        "Confidence level",
        formatSpatialSkeletonEditableNumber(
          fullNodeInfo.confidence,
          "Unavailable",
        ),
      );
    } else {
      let committedRadius = fullNodeInfo.radius ?? 0;
      let committedConfidence =
        fullNodeInfo.confidence !== undefined &&
        Number.isFinite(fullNodeInfo.confidence)
          ? Number(fullNodeInfo.confidence)
          : 0;
      const radiusInput = document.createElement("input");
      radiusInput.className = "neuroglancer-spatial-skeleton-properties-input";
      radiusInput.type = "number";
      radiusInput.step = "any";
      radiusInput.value = formatSpatialSkeletonEditableNumber(
        fullNodeInfo.radius,
      );
      appendValue("Radius", radiusInput);
      const supportedConfidenceValues = Array.from(
        new Set([...confidenceCapabilityValues!, committedConfidence]),
      ).filter((value): value is number => Number.isFinite(value));
      const confidenceSelectValues = Array.from(
        new Set([...supportedConfidenceValues, committedConfidence]),
      );
      const confidenceControl = document.createElement("select");
      confidenceControl.className =
        "neuroglancer-spatial-skeleton-properties-input";
      for (const value of confidenceSelectValues) {
        const option = document.createElement("option");
        option.value = value.toString();
        option.textContent = formatSpatialSkeletonEditableNumber(value);
        confidenceControl.appendChild(option);
      }
      confidenceControl.value = committedConfidence.toString();
      appendValue("Confidence level", confidenceControl);
      let savePending = false;
      const getPropertyEditingDisabledReason = () =>
        editCommandSource === undefined
          ? "Unable to resolve editable skeleton source for the active layer."
          : this.getSpatialSkeletonActionsDisabledReason(
              SpatialSkeletonActions.editNodeProperties,
            );
      const getConfidenceEditingDisabledReason = () => {
        const disabledReason = getPropertyEditingDisabledReason();
        if (disabledReason !== undefined) {
          return disabledReason;
        }
        return undefined;
      };
      const setPropertyInputValidity = (
        input: HTMLInputElement | HTMLSelectElement,
        valid: boolean,
        invalidTitle: string,
        disabledReason: string | undefined,
      ) => {
        input.classList.toggle(
          "neuroglancer-spatial-skeleton-properties-input-invalid",
          !valid,
        );
        if (disabledReason !== undefined) {
          input.title = disabledReason;
        } else if (!valid) {
          input.title = invalidTitle;
        } else {
          input.removeAttribute("title");
        }
      };
      const getConfidenceValidationError = (confidence: number) => {
        if (!Number.isFinite(confidence)) {
          return "Confidence must be a finite number.";
        }
        return confidenceSelectValues.includes(confidence)
          ? undefined
          : "Confidence must use one of the supported values.";
      };
      const getParsedProperties = () => {
        const radius = Number(radiusInput.value);
        const confidence = Number(confidenceControl.value);
        const radiusValid = Number.isFinite(radius);
        const confidenceInvalidTitle = getConfidenceValidationError(confidence);
        return {
          radius,
          confidence,
          radiusValid,
          confidenceValid: confidenceInvalidTitle === undefined,
          confidenceInvalidTitle,
        };
      };
      const updatePropertyEditorState = () => {
        const radiusDisabledReason = getPropertyEditingDisabledReason();
        const confidenceDisabledReason = getConfidenceEditingDisabledReason();
        const { radiusValid, confidenceValid, confidenceInvalidTitle } =
          getParsedProperties();
        radiusInput.disabled =
          radiusDisabledReason !== undefined || savePending;
        confidenceControl.disabled =
          confidenceDisabledReason !== undefined || savePending;
        setPropertyInputValidity(
          radiusInput,
          radiusValid,
          "Radius must be a finite number.",
          radiusDisabledReason,
        );
        setPropertyInputValidity(
          confidenceControl,
          confidenceValid,
          confidenceInvalidTitle ?? "Confidence is invalid.",
          confidenceDisabledReason,
        );
      };
      const resetPropertyInputs = () => {
        radiusInput.value =
          formatSpatialSkeletonEditableNumber(committedRadius);
        confidenceControl.value = committedConfidence.toString();
        updatePropertyEditorState();
      };
      const handlePropertyInputKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        (event.currentTarget as HTMLElement | null)?.blur();
      };
      const commitProperties = () => {
        if (savePending) return;
        const disabledReason = getPropertyEditingDisabledReason();
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          resetPropertyInputs();
          return;
        }
        const {
          radius,
          confidence,
          radiusValid,
          confidenceValid,
          confidenceInvalidTitle,
        } = getParsedProperties();
        if (!radiusValid || !confidenceValid) {
          StatusMessage.showTemporaryMessage(
            confidenceInvalidTitle ?? "Enter a valid radius and confidence.",
          );
          resetPropertyInputs();
          return;
        }
        const radiusChanged = radius !== committedRadius;
        const confidenceChanged = confidence !== committedConfidence;
        if (!radiusChanged && !confidenceChanged) {
          resetPropertyInputs();
          return;
        }
        savePending = true;
        updatePropertyEditorState();
        void (async () => {
          try {
            const currentNode = this.spatialSkeletonState.getCachedNode(
              fullNodeInfo.nodeId,
            );
            if (currentNode === undefined) {
              throw new Error(
                `Node ${fullNodeInfo.nodeId} is missing from the inspected skeleton cache.`,
              );
            }
            await executeSpatialSkeletonNodePropertiesUpdate(this, {
              node: currentNode,
              next: { radius, confidence },
            });
            committedRadius = radius;
            committedConfidence = confidence;
            resetPropertyInputs();
          } catch (error) {
            showSpatialSkeletonActionError("update node properties", error);
            resetPropertyInputs();
          } finally {
            savePending = false;
            updatePropertyEditorState();
          }
        })();
      };
      radiusInput.addEventListener("input", updatePropertyEditorState);
      radiusInput.addEventListener("keydown", handlePropertyInputKeyDown);
      radiusInput.addEventListener("change", commitProperties);
      confidenceControl.addEventListener("change", commitProperties);
      updatePropertyEditorState();
    }
    const descriptionText =
      cachedNodeInfo?.description ?? completeNodeInfo?.description ?? "";
    const descriptionEditingDisabledReason =
      editCommandSource === undefined
        ? "Unable to resolve editable skeleton source for the active layer."
        : cachedNodeInfo === undefined
          ? "Load the active skeleton in the Skeleton tab before editing description."
          : this.getSpatialSkeletonActionsDisabledReason(
              SpatialSkeletonActions.editNodeDescription,
            );
    if (descriptionEditingDisabledReason === undefined) {
      const descriptionElement = document.createElement("textarea");
      descriptionElement.classList.add(
        "neuroglancer-spatial-skeleton-selection-description",
      );
      descriptionElement.rows = 3;
      descriptionElement.placeholder = "Description";
      descriptionElement.value = descriptionText;
      descriptionElement.addEventListener("change", () => {
        if (editCommandSource === undefined || cachedNodeInfo === undefined) {
          return;
        }
        const nextDescription = descriptionElement.value;
        if (descriptionText === nextDescription) {
          descriptionElement.value = nextDescription;
          return;
        }
        descriptionElement.disabled = true;
        void (async () => {
          try {
            const currentNode = this.spatialSkeletonState.getCachedNode(
              fullNodeInfo.nodeId,
            );
            if (currentNode === undefined) {
              throw new Error(
                `Node ${fullNodeInfo.nodeId} is missing from the inspected skeleton cache.`,
              );
            }
            await executeSpatialSkeletonNodeDescriptionUpdate(this, {
              node: currentNode,
              nextDescription,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            descriptionElement.value = descriptionText;
            StatusMessage.showTemporaryMessage(
              `Failed to update description: ${message}`,
            );
          } finally {
            descriptionElement.disabled = false;
          }
        })();
      });
      container.appendChild(descriptionElement);
    } else if (descriptionText.length > 0) {
      const descriptionElement = document.createElement("div");
      descriptionElement.classList.add(
        "neuroglancer-spatial-skeleton-selection-description",
      );
      descriptionElement.textContent = descriptionText;
      descriptionElement.title = descriptionEditingDisabledReason;
      container.appendChild(descriptionElement);
    } else if (completeNodeInfo === undefined) {
      appendValue("Description", "Unavailable");
    }
    return true;
  }

  displaySelectionState(
    state: this["selectionState"],
    parent: HTMLElement,
    context: DependentViewContext,
  ): boolean {
    let displayed = this.displaySegmentationSelection(state, parent, context);
    if (this.displaySpatialSkeletonSelection(state, parent, context))
      displayed = true;
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

  observeLayerColor(callback: () => void) {
    const disposer = super.observeLayerColor(callback);
    const defaultColorDisposer = observeWatchable(
      callback,
      this.displayState.segmentDefaultColor,
    );
    const visibleSegmentDisposer =
      this.displayState.segmentationGroupState.value.visibleSegments.changed.add(
        callback,
      );
    const colorHashChangeDisposer =
      this.displayState.segmentationColorGroupState.value.segmentColorHash.changed.add(
        callback,
      );
    const showAllByDefaultDisposer =
      this.displayState.ignoreNullVisibleSet.changed.add(callback);
    const hasVolumeDisposer = this.displayState.hasVolume.changed.add(callback);
    return () => {
      disposer();
      defaultColorDisposer();
      visibleSegmentDisposer();
      colorHashChangeDisposer();
      showAllByDefaultDisposer();
      hasVolumeDisposer();
    };
  }

  get automaticLayerBarColors() {
    const { displayState } = this;
    const visibleSegmentsSet =
      displayState.segmentationGroupState.value.visibleSegments;
    const fixedColor = displayState.segmentDefaultColor.value;

    const noVisibleSegments = visibleSegmentsSet.size === 0;
    const tooManyVisibleSegments =
      visibleSegmentsSet.size > MAX_LAYER_BAR_UI_INDICATOR_COLORS;
    const hasMappedColors =
      displayState.segmentationColorGroupState.value.segmentStatedColors.size >
      0;
    const isFixedColorOnly = fixedColor !== undefined && !hasMappedColors;
    const showAllByDefault = displayState.ignoreNullVisibleSet.value;
    const hasVolume = displayState.hasVolume.value;

    if (noVisibleSegments) {
      if (!showAllByDefault || !hasVolume) return []; // No segments visible
      if (isFixedColorOnly) return [getCssColor(fixedColor)];
      return undefined; // Rainbow colors
    }
    if (isFixedColorOnly) {
      return [getCssColor(fixedColor)]; // All segments show as one color
    }

    // Because manually mapped colors are not guaranteed to be unique,
    // we need to actually check all the visible segments if
    // manually mapped colors are used
    if (!hasMappedColors && tooManyVisibleSegments) {
      return undefined; // Too many segments to show
    }

    const visibleSegments = [...visibleSegmentsSet];
    const colors = visibleSegments.map((id) => {
      const color = getCssColor(getBaseObjectColor(displayState, id));
      return { color, id };
    });

    // Sort the colors by their segment ID
    // Otherwise, the order is random which is a bit confusing in the UI
    colors.sort((a, b) => {
      const aId = a.id;
      const bId = b.id;
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    });

    const uniqueColors = [...new Set(colors.map((color) => color.color))];
    if (uniqueColors.length > MAX_LAYER_BAR_UI_INDICATOR_COLORS) {
      return undefined; // Too many colors to show
    }
    return uniqueColors;
  }

  static type = "segmentation";
  static typeAbbreviation = "seg";
  static supportsPickOption = true;
  static supportsLayerBarColorSyncOption = true;
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

registerSpatialSkeletonEditModeTool(SegmentationUserLayer);
registerSegmentSplitMergeTools(SegmentationUserLayer);
registerSegmentSelectTools(SegmentationUserLayer);
