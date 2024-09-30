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

import { debounce, throttle } from "lodash-es";
import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import type { AnnotationType } from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type {
  CoordinateSpace,
  CoordinateTransformSpecification,
} from "#src/coordinate_transform.js";
import {
  CoordinateSpaceCombiner,
  coordinateTransformSpecificationFromLegacyJson,
  emptyInvalidCoordinateSpace,
  isGlobalDimension,
  isLocalDimension,
  isLocalOrChannelDimension,
  TrackableCoordinateSpace,
} from "#src/coordinate_transform.js";
import type {
  DataSourceProviderRegistry,
  DataSourceSpecification,
  DataSubsource,
} from "#src/datasource/index.js";
import { makeEmptyDataSourceSpecification } from "#src/datasource/index.js";
import type { DisplayContext, RenderedPanel } from "#src/display_context.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import {
  LayerDataSource,
  layerDataSourceSpecificationFromJson,
} from "#src/layer/layer_data_source.js";
import type {
  DisplayDimensions,
  WatchableDisplayDimensionRenderInfo,
} from "#src/navigation_state.js";
import {
  CoordinateSpacePlaybackVelocity,
  PlaybackManager,
  Position,
} from "#src/navigation_state.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import {
  RENDERED_VIEW_ADD_LAYER_RPC_ID,
  RENDERED_VIEW_REMOVE_LAYER_RPC_ID,
} from "#src/render_layer_common.js";
import type {
  RenderLayer,
  RenderLayerRole,
  VisibilityTrackedRenderLayer,
} from "#src/renderlayer.js";
import type { VolumeType } from "#src/sliceview/volume/base.js";
import { StatusMessage } from "#src/status.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type {
  TrackableValueInterface,
  WatchableSet,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import { registerNested, WatchableValue } from "#src/trackable_value.js";
import {
  SELECTED_LAYER_SIDE_PANEL_DEFAULT_LOCATION,
  UserLayerSidePanelsState,
} from "#src/ui/layer_side_panel_state.js";
import {
  DEFAULT_SIDE_PANEL_LOCATION,
  TrackableSidePanelLocation,
} from "#src/ui/side_panel_location.js";
import type { GlobalToolBinder } from "#src/ui/tool.js";
import { LocalToolBinder, SelectedLegacyTool } from "#src/ui/tool.js";
import { gatherUpdate } from "#src/util/array.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { invokeDisposers, RefCounted } from "#src/util/disposable.js";
import {
  emptyToUndefined,
  parseArray,
  parseFixedLengthArray,
  verifyBoolean,
  verifyFiniteFloat,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyOptionalString,
  verifyString,
} from "#src/util/json.js";
import { MessageList } from "#src/util/message_list.js";
import type { AnyConstructor } from "#src/util/mixin.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import type { SignalBindingUpdater } from "#src/util/signal_binding_updater.js";
import {
  addSignalBinding,
  removeSignalBinding,
} from "#src/util/signal_binding_updater.js";
import type { Trackable } from "#src/util/trackable.js";
import { Uint64 } from "#src/util/uint64.js";
import { kEmptyFloat32Vec } from "#src/util/vector.js";
import type { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";
import type { DependentViewContext } from "#src/widget/dependent_view_widget.js";
import type { Tab } from "#src/widget/tab_view.js";
import { TabSpecification } from "#src/widget/tab_view.js";
import type { RPC } from "#src/worker_rpc.js";

const TOOL_JSON_KEY = "tool";
const TOOL_BINDINGS_JSON_KEY = "toolBindings";
const LOCAL_POSITION_JSON_KEY = "localPosition";
const LOCAL_VELOCITY_JSON_KEY = "localVelocity";
const LOCAL_COORDINATE_SPACE_JSON_KEY = "localDimensions";
const SOURCE_JSON_KEY = "source";
const TRANSFORM_JSON_KEY = "transform";
const PICK_JSON_KEY = "pick";

export interface UserLayerSelectionState {
  generation: number;

  // If `false`, selection is not associated with a position.
  localPositionValid: boolean;
  localPosition: Float32Array;
  localCoordinateSpace: CoordinateSpace | undefined;

  annotationId: string | undefined;
  annotationType: AnnotationType | undefined;
  annotationBuffer: Uint8Array | undefined;
  annotationIndex: number | undefined;
  annotationCount: number | undefined;
  annotationSourceIndex: number | undefined;
  annotationSubsource: string | undefined;
  annotationSubsubsourceId: string | undefined;
  annotationPartIndex: number | undefined;

  value: any;
}

export class LayerActionContext {
  callbacks: (() => void)[] = [];
  defer(callback: () => void) {
    this.callbacks.push(callback);
  }
}

export interface UserLayerTab {
  id: string;
  label: string;
  order: number;
  getter: (layer: UserLayer) => Tab;
}

export const USER_LAYER_TABS: UserLayerTab[] = [];

export class UserLayer extends RefCounted {
  get localPosition() {
    return this.managedLayer.localPosition;
  }

  get localVelocity() {
    return this.managedLayer.localVelocity;
  }

  get localCoordinateSpaceCombiner() {
    return this.managedLayer.localCoordinateSpaceCombiner;
  }

  get localCoordinateSpace() {
    return this.managedLayer.localCoordinateSpace;
  }

  static type: string;
  static typeAbbreviation: string;

  get type() {
    return (this.constructor as typeof UserLayer).type;
  }

  static supportsPickOption = false;

  pick = new TrackableBoolean(true, true);

  selectionState: UserLayerSelectionState;

  messages = new MessageList();

  layerEventListeners = new Map<string, Signal>();

  dispatchLayerEvent(type: string) {
    this.layerEventListeners.get(type)?.dispatch();
  }

  registerLayerEvent(type: string, handler: () => void) {
    const { layerEventListeners } = this;
    let existingSignal = layerEventListeners.get(type);
    if (!existingSignal) {
      existingSignal = new Signal();
      layerEventListeners.set(type, existingSignal);
    }
    const unregister = existingSignal.add(handler);
    return () => {
      const res = unregister();
      // TODO delete from layerEventListeners if no other handlers attached? currently Signal.handlers is private
      /*
      if (existingSignal.handlers.length === 0) {
        layerEventListeners.delete(type);
      }
      */
      return res;
    };
  }

  initializeSelectionState(state: this["selectionState"]) {
    state.generation = -1;
    state.localPositionValid = false;
    state.localPosition = kEmptyFloat32Vec;
    state.localCoordinateSpace = undefined;
    state.annotationId = undefined;
    state.annotationType = undefined;
    state.annotationBuffer = undefined;
    state.annotationIndex = undefined;
    state.annotationCount = undefined;
    state.annotationSourceIndex = undefined;
    state.annotationSubsource = undefined;
    state.annotationPartIndex = undefined;
    state.value = undefined;
  }

  resetSelectionState(state: this["selectionState"]) {
    state.localPositionValid = false;
    state.annotationId = undefined;
    state.value = undefined;
  }

  selectionStateFromJson(state: this["selectionState"], json: any) {
    const localCoordinateSpace = (state.localCoordinateSpace =
      this.localCoordinateSpace.value);
    const { rank } = localCoordinateSpace;
    if (rank !== 0) {
      const localPosition = verifyOptionalObjectProperty(
        json,
        LOCAL_POSITION_JSON_KEY,
        (positionObj) =>
          parseFixedLengthArray(
            new Float32Array(rank),
            positionObj,
            verifyFiniteFloat,
          ),
      );
      if (localPosition === undefined) {
        state.localPositionValid = false;
      } else {
        state.localPositionValid = true;
        state.localPosition = localPosition;
      }
    }
    const annotationId = (state.annotationId = verifyOptionalObjectProperty(
      json,
      "annotationId",
      verifyString,
    ));
    if (annotationId !== undefined) {
      state.annotationSourceIndex = verifyOptionalObjectProperty(
        json,
        "annotationSource",
        verifyInt,
        0,
      );
      state.annotationPartIndex = verifyOptionalObjectProperty(
        json,
        "annotationPart",
        verifyInt,
      );
      state.annotationSubsource = verifyOptionalObjectProperty(
        json,
        "annotationSubsource",
        verifyString,
      );
    }

    state.value = json.value;
  }

  // Derived classes should override.
  displaySelectionState(
    state: this["selectionState"],
    parent: HTMLElement,
    context: DependentViewContext,
  ) {
    state;
    parent;
    context;
    return false;
  }

  selectionStateToJson(state: this["selectionState"], forPython: boolean): any {
    forPython;
    const json: any = {};
    if (state.localPositionValid) {
      const { localPosition } = state;
      if (localPosition.length > 0) {
        json.localPosition = Array.from(localPosition);
      }
    }
    if (state.annotationId !== undefined) {
      json.annotationId = state.annotationId;
      json.annotationPart = state.annotationPartIndex;
      json.annotationSource = state.annotationSourceIndex;
      json.annotationSubsource = state.annotationSubsource;
    }
    if (state.value != null) {
      json.value = state.value;
    }
    return json;
  }

  captureSelectionState(
    state: this["selectionState"],
    mouseState: MouseSelectionState,
  ) {
    state.localCoordinateSpace = this.localCoordinateSpace.value;
    const curLocalPosition = this.localPosition.value;
    const { localPosition } = state;
    if (localPosition.length !== curLocalPosition.length) {
      state.localPosition = curLocalPosition.slice();
    } else {
      localPosition.set(curLocalPosition);
    }
    state.localPositionValid = true;
    state.value = this.getValueAt(mouseState.position, mouseState);
  }

  copySelectionState(
    dest: this["selectionState"],
    source: this["selectionState"],
  ) {
    dest.generation = source.generation;
    dest.localPositionValid = source.localPositionValid;
    dest.localCoordinateSpace = source.localCoordinateSpace;
    const curLocalPosition = source.localPosition;
    const { localPosition } = dest;
    if (localPosition.length !== curLocalPosition.length) {
      dest.localPosition = curLocalPosition.slice();
    } else {
      dest.localPosition.set(curLocalPosition);
    }
    dest.annotationId = source.annotationId;
    dest.annotationType = source.annotationType;
    dest.annotationBuffer = source.annotationBuffer;
    dest.annotationIndex = source.annotationIndex;
    dest.annotationCount = source.annotationCount;
    dest.annotationSourceIndex = source.annotationSourceIndex;
    dest.annotationSubsource = source.annotationSubsource;
    dest.annotationPartIndex = source.annotationPartIndex;
    dest.value = source.value;
  }

  layersChanged = new NullarySignal();
  readyStateChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  renderLayers = new Array<RenderLayer>();
  private loadingCounter = 1;
  get isReady() {
    return this.loadingCounter === 0;
  }

  tabs = this.registerDisposer(new TabSpecification());
  panels = new UserLayerSidePanelsState(this);
  tool = this.registerDisposer(new SelectedLegacyTool(this));
  toolBinder = this.registerDisposer(
    new LocalToolBinder(this, this.manager.root.toolBinder),
  );

  dataSourcesChanged = new NullarySignal();
  dataSources: LayerDataSource[] = [];

  get manager() {
    return this.managedLayer.manager;
  }

  constructor(public managedLayer: Borrowed<ManagedUserLayer>) {
    super();
    this.localCoordinateSpaceCombiner.includeDimensionPredicate =
      isLocalOrChannelDimension;
    this.tabs.changed.add(this.specificationChanged.dispatch);
    this.panels.specificationChanged.add(this.specificationChanged.dispatch);
    this.tool.changed.add(this.specificationChanged.dispatch);
    this.toolBinder.changed.add(this.specificationChanged.dispatch);
    this.localPosition.changed.add(this.specificationChanged.dispatch);
    this.pick.changed.add(this.specificationChanged.dispatch);
    this.pick.changed.add(this.layersChanged.dispatch);
    this.dataSourcesChanged.add(this.specificationChanged.dispatch);
    this.dataSourcesChanged.add(() => this.updateDataSubsourceActivations());
    this.messages.changed.add(this.layersChanged.dispatch);
    for (const tab of USER_LAYER_TABS) {
      this.tabs.add(tab.id, {
        label: tab.label,
        order: tab.order,
        getter: () => tab.getter(this),
      });
    }
  }

  canAddDataSource() {
    return true;
  }

  addDataSource(spec: DataSourceSpecification | undefined) {
    const layerDataSource = new LayerDataSource(this, spec);
    this.dataSources.push(layerDataSource);
    this.dataSourcesChanged.dispatch();
    return layerDataSource;
  }

  // Should be overridden by derived classes.
  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>): void {
    subsources;
  }

  updateDataSubsourceActivations() {
    function* getDataSubsources(
      this: UserLayer,
    ): Iterable<LoadedDataSubsource> {
      for (const dataSource of this.dataSources) {
        const { loadState } = dataSource;
        if (loadState === undefined || loadState.error !== undefined) continue;
        for (const subsource of loadState.subsources) {
          if (subsource.enabled) {
            yield subsource;
          } else {
            const { activated } = subsource;
            subsource.messages.clearMessages();
            if (activated !== undefined) {
              activated.dispose();
              subsource.activated = undefined;
              loadState.activatedSubsourcesChanged.dispatch();
            }
          }
        }
      }
    }
    this.activateDataSubsources(getDataSubsources.call(this));
  }

  private decrementLoadingCounter() {
    if (--this.loadingCounter === 0) {
      this.readyStateChanged.dispatch();
    }
  }

  markLoading() {
    const localRetainer = this.localCoordinateSpaceCombiner.retain();
    const globalRetainer = this.manager.root.coordinateSpaceCombiner.retain();
    if (++this.loadingCounter === 1) {
      this.readyStateChanged.dispatch();
    }
    const disposer = () => {
      localRetainer();
      globalRetainer();
      this.decrementLoadingCounter();
    };
    return disposer;
  }

  addCoordinateSpace(
    coordinateSpace: WatchableValueInterface<CoordinateSpace>,
  ) {
    const globalBinding =
      this.manager.root.coordinateSpaceCombiner.bind(coordinateSpace);
    const localBinding =
      this.localCoordinateSpaceCombiner.bind(coordinateSpace);
    return () => {
      globalBinding();
      localBinding();
    };
  }

  initializationDone() {
    const selectionState = (this.selectionState = {} as any);
    this.initializeSelectionState(selectionState);
    this.decrementLoadingCounter();
  }

  getLegacyDataSourceSpecifications(
    sourceSpec: string | undefined,
    layerSpec: any,
    legacyTransform: CoordinateTransformSpecification | undefined,
    explicitSpecs: DataSourceSpecification[],
  ): DataSourceSpecification[] {
    layerSpec;
    explicitSpecs;
    if (sourceSpec === undefined) return [];
    return [layerDataSourceSpecificationFromJson(sourceSpec, legacyTransform)];
  }

  getDataSourceSpecifications(layerSpec: any): DataSourceSpecification[] {
    let legacySpec: any = undefined;
    let specs = verifyObjectProperty(
      layerSpec,
      SOURCE_JSON_KEY,
      (sourcesObj) => {
        if (Array.isArray(sourcesObj)) {
          return sourcesObj.map((source) =>
            layerDataSourceSpecificationFromJson(source),
          );
        }
        if (typeof sourcesObj === "object") {
          return [layerDataSourceSpecificationFromJson(sourcesObj)];
        }
        legacySpec = sourcesObj;
        return [];
      },
    );
    const legacyTransform = verifyObjectProperty(
      layerSpec,
      TRANSFORM_JSON_KEY,
      coordinateTransformSpecificationFromLegacyJson,
    );
    specs.push(
      ...this.getLegacyDataSourceSpecifications(
        legacySpec,
        layerSpec,
        legacyTransform,
        specs,
      ),
    );
    specs = specs.filter((spec) => spec.url);
    if (specs.length === 0) {
      specs.push(makeEmptyDataSourceSpecification());
    }
    return specs;
  }

  restoreState(specification: any) {
    this.tool.restoreState(specification[TOOL_JSON_KEY]);
    this.panels.restoreState(specification);
    this.localCoordinateSpace.restoreState(
      specification[LOCAL_COORDINATE_SPACE_JSON_KEY],
    );
    this.localPosition.restoreState(specification[LOCAL_POSITION_JSON_KEY]);
    this.localVelocity.restoreState(specification[LOCAL_VELOCITY_JSON_KEY]);
    this.toolBinder.restoreState(specification[TOOL_BINDINGS_JSON_KEY]);
    if ((this.constructor as typeof UserLayer).supportsPickOption) {
      this.pick.restoreState(specification[PICK_JSON_KEY]);
    }
    for (const spec of this.getDataSourceSpecifications(specification)) {
      this.addDataSource(spec);
    }
  }

  addRenderLayer(layer: Owned<RenderLayer>) {
    this.renderLayers.push(layer);
    const { layersChanged } = this;
    layer.layerChanged.add(layersChanged.dispatch);
    layer.userLayer = this;
    layersChanged.dispatch();
    return () => this.removeRenderLayer(layer);
  }

  removeRenderLayer(layer: RenderLayer) {
    const { renderLayers, layersChanged } = this;
    const index = renderLayers.indexOf(layer);
    if (index === -1) {
      throw new Error("Attempted to remove invalid RenderLayer");
    }
    renderLayers.splice(index, 1);
    layer.layerChanged.remove(layersChanged.dispatch);
    layer.userLayer = undefined;
    layer.dispose();
    layersChanged.dispatch();
  }

  disposed() {
    const { layersChanged } = this;
    invokeDisposers(this.dataSources);
    for (const layer of this.renderLayers) {
      layer.layerChanged.remove(layersChanged.dispatch);
      layer.dispose();
    }
    this.renderLayers.length = 0;
    super.disposed();
  }

  getValueAt(position: Float32Array, pickState: PickState) {
    let result: any;
    const { renderLayers } = this;
    const { pickedRenderLayer } = pickState;
    if (
      pickedRenderLayer !== null &&
      renderLayers.indexOf(pickedRenderLayer) !== -1
    ) {
      result = pickedRenderLayer.transformPickedValue(pickState);
      result = this.transformPickedValue(result);
      if (result != null) return result;
    }
    for (const layer of renderLayers) {
      result = layer.getValueAt(position);
      if (result != null) {
        break;
      }
    }
    return this.transformPickedValue(result);
  }

  transformPickedValue(value: any) {
    return value;
  }

  toJSON(): any {
    return {
      type: this.type,
      [SOURCE_JSON_KEY]: dataSourcesToJson(this.dataSources),
      [TOOL_JSON_KEY]: this.tool.toJSON(),
      [TOOL_BINDINGS_JSON_KEY]: this.toolBinder.toJSON(),
      [LOCAL_COORDINATE_SPACE_JSON_KEY]: this.localCoordinateSpace.toJSON(),
      [LOCAL_POSITION_JSON_KEY]: this.localPosition.toJSON(),
      [LOCAL_VELOCITY_JSON_KEY]: this.localVelocity.toJSON(),
      [PICK_JSON_KEY]: this.pick.toJSON(),
      ...this.panels.toJSON(),
    };
  }

  // Derived classes should override.
  handleAction(_action: string, _context: LayerActionContext): void {}

  selectedValueToJson(value: any) {
    return value;
  }

  selectedValueFromJson(json: any) {
    return json;
  }

  setLayerPosition(
    modelTransform: RenderLayerTransform,
    layerPosition: Float32Array,
  ) {
    const { globalPosition } = this.manager.root;
    const { localPosition } = this;
    gatherUpdate(
      globalPosition.value,
      layerPosition,
      modelTransform.globalToRenderLayerDimensions,
    );
    gatherUpdate(
      localPosition.value,
      layerPosition,
      modelTransform.localToRenderLayerDimensions,
    );
    localPosition.changed.dispatch();
    globalPosition.changed.dispatch();
  }
}

function dataSourcesToJson(sources: readonly LayerDataSource[]) {
  if (sources.length === 0) return undefined;
  if (sources.length === 1) return sources[0].toJSON();
  return sources.map((x) => x.toJSON());
}

export class ManagedUserLayer extends RefCounted {
  localCoordinateSpace = new TrackableCoordinateSpace();
  localCoordinateSpaceCombiner = new CoordinateSpaceCombiner(
    this.localCoordinateSpace,
    isLocalDimension,
  );
  localPosition = this.registerDisposer(
    new Position(this.localCoordinateSpace),
  );
  localVelocity = this.registerDisposer(
    new CoordinateSpacePlaybackVelocity(this.localCoordinateSpace),
  );

  // Index of layer within root layer manager, counting only non-archived layers.  This is the layer
  // number shown in the layer bar and layer list panel.
  nonArchivedLayerIndex = -1;

  readyStateChanged = new NullarySignal();
  layerChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  containers = new Set<Borrowed<LayerManager>>();
  private layer_: UserLayer | null = null;
  get layer() {
    return this.layer_;
  }
  private unregisterUserLayer: (() => void) | undefined;

  /**
   * If layer is not null, tranfers ownership of a reference.
   */
  set layer(layer: UserLayer | null) {
    const oldLayer = this.layer_;
    if (oldLayer != null) {
      this.unregisterUserLayer!();
      oldLayer.dispose();
    }
    this.layer_ = layer;
    if (layer != null) {
      const removers = [
        layer.layersChanged.add(this.layerChanged.dispatch),
        layer.readyStateChanged.add(this.readyStateChanged.dispatch),
        layer.specificationChanged.add(this.specificationChanged.dispatch),
      ];
      this.unregisterUserLayer = () => {
        removers.forEach((x) => x());
      };
      this.readyStateChanged.dispatch();
      this.layerChanged.dispatch();
    }
  }

  isReady() {
    const { layer } = this;
    return layer?.isReady;
  }

  private name_: string;

  get name() {
    return this.name_;
  }

  set name(value: string) {
    if (value !== this.name_) {
      this.name_ = value;
      this.layerChanged.dispatch();
    }
  }

  visible = true;
  archived = false;

  get supportsPickOption() {
    const userLayer = this.layer;
    return (
      userLayer !== null &&
      (userLayer.constructor as typeof UserLayer).supportsPickOption
    );
  }

  get pickEnabled() {
    const userLayer = this.layer;
    return (
      userLayer !== null &&
      (userLayer.constructor as typeof UserLayer).supportsPickOption &&
      userLayer.pick.value
    );
  }

  set pickEnabled(value: boolean) {
    const userLayer = this.layer;
    if (
      userLayer !== null &&
      (userLayer.constructor as typeof UserLayer).supportsPickOption
    ) {
      userLayer.pick.value = value;
    }
  }

  /**
   * If layer is not null, tranfers ownership of a reference.
   */
  constructor(
    name: string,
    public manager: Borrowed<LayerListSpecification>,
  ) {
    super();
    this.name_ = name;
    this.registerDisposer(
      new PlaybackManager(
        this.manager.root.display,
        this.localPosition,
        this.localVelocity,
      ),
    );
  }

  toJSON() {
    const userLayer = this.layer;
    if (userLayer === null) {
      return undefined;
    }
    const layerSpec = userLayer.toJSON();
    layerSpec.name = this.name;
    if (!this.visible) {
      if (this.archived) {
        layerSpec.archived = true;
      } else {
        layerSpec.visible = false;
      }
    }
    return layerSpec;
  }

  setVisible(value: boolean) {
    if (value === this.visible) return;
    if (value && this.archived) {
      this.visible = true;
      this.setArchived(false);
      return;
    }
    this.visible = value;
    this.layerChanged.dispatch();
  }

  setArchived(value: boolean) {
    if (this.archived === value) return;
    if (value === true) {
      this.visible = false;
      this.archived = true;
      for (const { layerManager } of this.manager.root.subsets) {
        if (!layerManager.has(this)) continue;
        layerManager.removeManagedLayer(this);
      }
    } else {
      for (const { layerManager } of this.manager.root.subsets) {
        if (layerManager.has(this)) continue;
        layerManager.addManagedLayer(this.addRef());
      }
      this.archived = false;
    }
    this.layerChanged.dispatch();
  }

  disposed() {
    this.layer = null;
    super.disposed();
  }
}

export class LayerManager extends RefCounted {
  managedLayers = new Array<Owned<ManagedUserLayer>>();
  layerSet = new Set<Borrowed<ManagedUserLayer>>();
  layersChanged = new NullarySignal();
  readyStateChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  boundPositions = new WeakSet<Position>();
  numDirectUsers = 0;
  nonArchivedLayerIndexGeneration = -1;
  private renderLayerToManagedLayerMapGeneration = -1;
  private renderLayerToManagedLayerMap_ = new Map<
    RenderLayer,
    ManagedUserLayer
  >();

  constructor() {
    super();
    this.layersChanged.add(this.scheduleRemoveLayersWithSingleRef);
  }

  private scheduleRemoveLayersWithSingleRef = this.registerCancellable(
    debounce(() => this.removeLayersWithSingleRef(), 0),
  );

  updateNonArchivedLayerIndices() {
    const generation = this.layersChanged.count;
    if (generation === this.nonArchivedLayerIndexGeneration) return;
    this.nonArchivedLayerIndexGeneration = generation;
    let index = 0;
    for (const layer of this.managedLayers) {
      if (!layer.archived) {
        layer.nonArchivedLayerIndex = index++;
      }
    }
    for (const layer of this.managedLayers) {
      if (layer.archived) {
        layer.nonArchivedLayerIndex = index++;
      }
    }
  }

  getLayerByNonArchivedIndex(index: number): ManagedUserLayer | undefined {
    let i = 0;
    for (const layer of this.managedLayers) {
      if (!layer.archived) {
        if (i === index) return layer;
        ++i;
      }
    }
    return undefined;
  }

  get renderLayerToManagedLayerMap() {
    const generation = this.layersChanged.count;
    const map = this.renderLayerToManagedLayerMap_;
    if (this.renderLayerToManagedLayerMapGeneration !== generation) {
      this.renderLayerToManagedLayerMapGeneration = generation;
      map.clear();
      for (const managedLayer of this.managedLayers) {
        const userLayer = managedLayer.layer;
        if (userLayer !== null) {
          for (const renderLayer of userLayer.renderLayers) {
            map.set(renderLayer, managedLayer);
          }
        }
      }
    }
    return map;
  }

  filter(predicate: (layer: ManagedUserLayer) => boolean) {
    let changed = false;
    this.managedLayers = this.managedLayers.filter((layer) => {
      if (!predicate(layer)) {
        this.unbindManagedLayer(layer);
        this.layerSet.delete(layer);
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) {
      this.layersChanged.dispatch();
    }
  }

  private removeLayersWithSingleRef() {
    if (this.numDirectUsers > 0) {
      return;
    }
    this.filter((layer) => layer.refCount !== 1 || layer.archived);
  }

  private updateSignalBindings(
    layer: ManagedUserLayer,
    callback: SignalBindingUpdater<() => void>,
  ) {
    callback(layer.layerChanged, this.layersChanged.dispatch);
    callback(layer.readyStateChanged, this.readyStateChanged.dispatch);
    callback(layer.specificationChanged, this.specificationChanged.dispatch);
  }

  useDirectly() {
    if (++this.numDirectUsers === 1) {
      this.layersChanged.remove(this.scheduleRemoveLayersWithSingleRef);
    }
    return () => {
      if (--this.numDirectUsers === 0) {
        this.layersChanged.add(this.scheduleRemoveLayersWithSingleRef);
        this.scheduleRemoveLayersWithSingleRef();
      }
    };
  }

  /**
   * Assumes ownership of an existing reference to managedLayer.
   */
  addManagedLayer(managedLayer: ManagedUserLayer, index?: number | undefined) {
    this.updateSignalBindings(managedLayer, addSignalBinding);
    this.layerSet.add(managedLayer);
    managedLayer.containers.add(this);
    if (index === undefined) {
      index = this.managedLayers.length;
    }
    this.managedLayers.splice(index, 0, managedLayer);
    this.layersChanged.dispatch();
    this.readyStateChanged.dispatch();
    return managedLayer;
  }

  *readyRenderLayers() {
    for (const managedUserLayer of this.managedLayers) {
      if (!managedUserLayer.visible || !managedUserLayer.layer) {
        continue;
      }
      yield* managedUserLayer.layer.renderLayers;
    }
  }

  unbindManagedLayer(managedLayer: ManagedUserLayer) {
    this.updateSignalBindings(managedLayer, removeSignalBinding);
    managedLayer.containers.delete(this);
    // Also notify the root LayerManager, to ensures the layer is removed if this is the last direct
    // reference.
    managedLayer.manager.rootLayers.layersChanged.dispatch();
    managedLayer.dispose();
  }

  clear() {
    for (const managedLayer of this.managedLayers) {
      this.unbindManagedLayer(managedLayer);
    }
    this.managedLayers.length = 0;
    this.layerSet.clear();
    this.layersChanged.dispatch();
  }

  remove(index: number) {
    const layer = this.managedLayers[index];
    this.unbindManagedLayer(layer);
    this.managedLayers.splice(index, 1);
    this.layerSet.delete(layer);
    this.layersChanged.dispatch();
  }

  removeManagedLayer(managedLayer: ManagedUserLayer) {
    const index = this.managedLayers.indexOf(managedLayer);
    if (index === -1) {
      throw new Error("Internal error: invalid managed layer.");
    }
    this.remove(index);
  }

  reorderManagedLayer(oldIndex: number, newIndex: number) {
    const numLayers = this.managedLayers.length;
    if (
      oldIndex === newIndex ||
      oldIndex < 0 ||
      oldIndex >= numLayers ||
      newIndex < 0 ||
      newIndex >= numLayers
    ) {
      // Don't do anything.
      return;
    }
    const [oldLayer] = this.managedLayers.splice(oldIndex, 1);
    this.managedLayers.splice(newIndex, 0, oldLayer);
    this.layersChanged.dispatch();
  }

  disposed() {
    this.clear();
    super.disposed();
  }

  getLayerByName(name: string) {
    return this.managedLayers.find((x) => x.name === name);
  }

  getUniqueLayerName(name: string) {
    let suggestedName = name;
    let suffix = 0;
    while (this.getLayerByName(suggestedName) !== undefined) {
      suggestedName = name + ++suffix;
    }
    return suggestedName;
  }

  has(layer: Borrowed<ManagedUserLayer>) {
    return this.layerSet.has(layer);
  }

  get renderLayers() {
    const layerManager = this;
    return {
      *[Symbol.iterator]() {
        for (const managedLayer of layerManager.managedLayers) {
          if (managedLayer.layer === null) {
            continue;
          }
          for (const renderLayer of managedLayer.layer.renderLayers) {
            yield renderLayer;
          }
        }
      },
    };
  }

  get visibleRenderLayers() {
    const layerManager = this;
    return {
      *[Symbol.iterator]() {
        for (const managedLayer of layerManager.managedLayers) {
          if (managedLayer.layer === null || !managedLayer.visible) {
            continue;
          }
          for (const renderLayer of managedLayer.layer.renderLayers) {
            yield renderLayer;
          }
        }
      },
    };
  }

  invokeAction(action: string) {
    const context = new LayerActionContext();
    for (const managedLayer of this.managedLayers) {
      if (managedLayer.layer === null || !managedLayer.visible) {
        continue;
      }
      const userLayer = managedLayer.layer;
      userLayer.handleAction(action, context);
      for (const renderLayer of userLayer.renderLayers) {
        renderLayer.handleAction(action);
      }
    }
    for (const callback of context.callbacks) {
      callback();
    }
  }
}

export interface PickState {
  pickedRenderLayer: RenderLayer | null;
  pickedValue: Uint64;
  pickedOffset: number;
  pickedAnnotationLayer: AnnotationLayerState | undefined;
  pickedAnnotationId: string | undefined;
  pickedAnnotationBuffer: ArrayBuffer | undefined;
  pickedAnnotationBufferBaseOffset: number | undefined;
  pickedAnnotationIndex: number | undefined;
  pickedAnnotationCount: number | undefined;
  pickedAnnotationType: AnnotationType | undefined;
}

export class MouseSelectionState implements PickState {
  changed = new NullarySignal();
  coordinateSpace: CoordinateSpace = emptyInvalidCoordinateSpace;
  position: Float32Array = kEmptyFloat32Vec;
  unsnappedPosition: Float32Array = kEmptyFloat32Vec;
  active = false;
  displayDimensions: DisplayDimensions | undefined = undefined;
  pickedRenderLayer: RenderLayer | null = null;
  pickedValue = new Uint64(0, 0);
  pickedOffset = 0;
  pickedAnnotationLayer: AnnotationLayerState | undefined = undefined;
  pickedAnnotationId: string | undefined = undefined;
  pickedAnnotationBuffer: ArrayBuffer | undefined = undefined;
  // Base offset into `pickedAnnotationBuffer` of the `pickedAnnotationCount` serialized annotations
  // of `pickedAnnotationType`.
  pickedAnnotationBufferBaseOffset: number | undefined = undefined;
  // Index (out of a total of `pickedAnnotationCount`) of the picked annotation.
  pickedAnnotationIndex: number | undefined = undefined;
  pickedAnnotationCount: number | undefined = undefined;
  pickedAnnotationType: AnnotationType | undefined = undefined;
  pageX: number;
  pageY: number;

  private forcerFunction: (() => void) | undefined = undefined;

  removeForcer(forcer: () => void) {
    if (forcer === this.forcerFunction) {
      this.forcerFunction = undefined;
      this.setActive(false);
    }
  }

  setForcer(forcer: (() => void) | undefined) {
    this.forcerFunction = forcer;
    if (forcer === undefined) {
      this.setActive(false);
    }
  }

  updateUnconditionally(): boolean {
    const { forcerFunction } = this;
    if (forcerFunction === undefined) {
      return false;
    }
    forcerFunction();
    return this.active;
  }

  setActive(value: boolean) {
    if (this.active !== value || value === true) {
      this.active = value;
      this.changed.dispatch();
    }
  }
}

export class LayerSelectedValues extends RefCounted {
  changed = new NullarySignal();
  needsUpdate = true;
  constructor(
    public layerManager: LayerManager,
    public mouseState: MouseSelectionState,
  ) {
    super();
    this.registerDisposer(
      mouseState.changed.add(() => {
        this.handleChange();
      }),
    );
    this.registerDisposer(
      layerManager.layersChanged.add(() => {
        this.handleLayerChange();
      }),
    );
  }

  /**
   * This should be called when the layer data may have changed, due to the set of managed layers
   * changing or new data having been received.
   */
  handleLayerChange() {
    if (this.mouseState.active) {
      this.handleChange();
    }
  }

  handleChange() {
    this.needsUpdate = true;
    this.changed.dispatch();
  }

  update() {
    if (!this.needsUpdate) {
      return;
    }
    this.needsUpdate = false;
    const mouseState = this.mouseState;
    const generation = this.changed.count;
    if (mouseState.active) {
      for (const layer of this.layerManager.managedLayers) {
        const userLayer = layer.layer;
        if (layer.visible && userLayer !== null) {
          const { selectionState } = userLayer;
          userLayer.resetSelectionState(selectionState);
          selectionState.generation = generation;
          userLayer.captureSelectionState(selectionState, mouseState);
        }
      }
    }
  }

  get<T extends UserLayer>(userLayer: T): T["selectionState"] | undefined {
    this.update();
    const { selectionState } = userLayer;
    if (selectionState.generation !== this.changed.count) return undefined;
    return selectionState;
  }

  toJSON() {
    this.update();
    const result: { [key: string]: any } = {};
    for (const layer of this.layerManager.managedLayers) {
      const userLayer = layer.layer;
      if (userLayer) {
        const state = this.get(userLayer);
        if (state !== undefined) {
          result[layer.name] = userLayer.selectionStateToJson(state, true);
        }
      }
    }
    return result;
  }
}

export interface PersistentLayerSelectionState {
  layer: UserLayer;
  state: UserLayerSelectionState;
}

export interface PersistentViewerSelectionState {
  layers: PersistentLayerSelectionState[];
  coordinateSpace: CoordinateSpace;
  position: Float32Array | undefined;
}

const maxSelectionHistorySize = 10;

const DATA_SELECTION_STATE_DEFAULT_PANEL_LOCATION = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  minSize: 150,
  row: 1,
};

const DATA_SELECTION_STATE_DEFAULT_PANEL_LOCATION_VISIBLE = {
  ...DATA_SELECTION_STATE_DEFAULT_PANEL_LOCATION,
  visible: true,
};

export class TrackableDataSelectionState
  extends RefCounted
  implements
    TrackableValueInterface<PersistentViewerSelectionState | undefined>
{
  changed = new NullarySignal();
  history: PersistentViewerSelectionState[] = [];
  historyIndex = 0;
  location = new TrackableSidePanelLocation(
    DATA_SELECTION_STATE_DEFAULT_PANEL_LOCATION,
  );

  constructor(
    public coordinateSpace: WatchableValueInterface<CoordinateSpace>,
    public layerSelectedValues: Borrowed<LayerSelectedValues>,
  ) {
    super();
    this.registerDisposer(
      registerNested((context, pin) => {
        if (pin) return;
        this.capture(true);
        context.registerDisposer(
          layerSelectedValues.changed.add(
            context.registerCancellable(
              throttle(() => this.capture(true), 100, {
                leading: true,
                trailing: true,
              }),
            ),
          ),
        );
      }, this.pin),
    );
    this.pin.changed.add(this.changed.dispatch);
    this.location.changed.add(this.changed.dispatch);
  }
  private value_: PersistentViewerSelectionState | undefined;
  pin = new WatchableValue<boolean>(true);
  get value() {
    return this.value_;
  }

  goBack() {
    const curIndex = this.pin.value ? this.historyIndex : this.history.length;
    if (curIndex > 0) {
      this.historyIndex = curIndex - 1;
      this.value_ = this.history[curIndex - 1];
      this.pin.value = true;
      this.changed.dispatch();
    }
  }

  canGoBack() {
    const curIndex = this.pin.value ? this.historyIndex : this.history.length;
    return curIndex > 0;
  }

  canGoForward() {
    if (!this.pin.value) return false;
    const curIndex = this.historyIndex;
    return curIndex + 1 < this.history.length;
  }

  goForward() {
    if (!this.pin.value) return;
    const curIndex = this.historyIndex;
    if (curIndex + 1 < this.history.length) {
      this.historyIndex = curIndex + 1;
      this.value_ = this.history[curIndex + 1];
      this.changed.dispatch();
    }
  }

  set value(value: PersistentViewerSelectionState | undefined) {
    if (value !== this.value_) {
      this.value_ = value;
      if (value !== undefined && this.pin.value) {
        // Add to history
        const { history } = this;
        history.length = Math.min(history.length, this.historyIndex + 1);
        history.push(value);
        if (history.length > maxSelectionHistorySize) {
          history.splice(0, history.length - maxSelectionHistorySize);
        }
        this.historyIndex = history.length - 1;
      }
      this.changed.dispatch();
    }
  }

  captureSingleLayerState<T extends UserLayer>(
    userLayer: Borrowed<T>,
    capture: (state: T["selectionState"]) => boolean,
    pin: boolean | "toggle" = true,
  ) {
    if (pin === false && (!this.location.visible || this.pin.value)) return;
    const state = {} as UserLayerSelectionState;
    userLayer.initializeSelectionState(state);
    if (capture(state)) {
      this.location.visible = true;
      if (pin === true) {
        this.pin.value = true;
      } else if (pin === "toggle") {
        this.pin.value = !this.pin.value;
      }
      this.value = {
        layers: [{ layer: userLayer, state }],
        coordinateSpace: this.coordinateSpace.value,
        position: undefined,
      };
    }
  }
  reset() {
    this.location.reset();
    this.pin.value = false;
    this.value = undefined;
  }
  toJSON() {
    // Default panel configuration, not visible: -> undefined
    // Default panel configuration, visible: -> {}
    // Non-default panel configuration, not visible: -> {side: 'left', ..., visible: false}}
    // Non-default panel configuration, visible: -> {side: 'left', ...}
    const { value } = this;
    let obj: any;
    if (this.location.visible) {
      obj = this.location.toJSON(
        DATA_SELECTION_STATE_DEFAULT_PANEL_LOCATION_VISIBLE,
      );
      if (this.pin.value && value !== undefined) {
        const layersJson: any = {};
        for (const layerData of value.layers) {
          const { layer } = layerData;
          let data = layer.selectionStateToJson(layerData.state, false);
          if (Object.keys(data).length === 0) data = undefined;
          layersJson[layerData.layer.managedLayer.name] = data;
        }
        if (value.position !== undefined) {
          obj.position = Array.from(value.position);
        }
        obj.layers = layersJson;
      }
    } else {
      obj = this.location.toJSON(DATA_SELECTION_STATE_DEFAULT_PANEL_LOCATION);
      obj = emptyToUndefined(obj);
      if (obj !== undefined) {
        obj.visible = false;
      }
    }
    return obj;
  }
  select() {
    const { pin } = this;
    this.location.visible = true;
    pin.value = !pin.value;
    if (pin.value) {
      this.capture();
    }
  }
  capture(canRetain = false) {
    const newValue = capturePersistentViewerSelectionState(
      this.layerSelectedValues,
    );
    if (canRetain && newValue === undefined) return;
    this.value = newValue;
  }
  restoreState(obj: unknown) {
    if (obj === undefined) {
      this.pin.value = true;
      this.value = undefined;
      return;
    }
    if (obj === null) {
      // Support for old representation where `null` means visible but unpinned.
      this.pin.value = false;
      this.location.visible = true;
      this.value = undefined;
      return;
    }
    verifyObject(obj);
    // If the object is present, then visible by default.
    this.location.restoreState(
      obj,
      DATA_SELECTION_STATE_DEFAULT_PANEL_LOCATION_VISIBLE,
    );
    const coordinateSpace = this.coordinateSpace.value;
    const position = verifyOptionalObjectProperty(
      obj,
      "position",
      (positionObj) =>
        parseFixedLengthArray(
          new Float32Array(coordinateSpace.rank),
          positionObj,
          verifyFiniteFloat,
        ),
    );
    const layers: PersistentLayerSelectionState[] = [];
    verifyOptionalObjectProperty(obj, "layers", (layersObj) => {
      verifyObject(layersObj);
      const { layerManager } = this.layerSelectedValues;
      for (const [name, entry] of Object.entries(layersObj)) {
        const managedLayer = layerManager.getLayerByName(name);
        if (managedLayer === undefined) return;
        const layer = managedLayer.layer;
        if (layer === null) return;
        verifyObject(entry);
        const state: UserLayerSelectionState = {} as any;
        layer.initializeSelectionState(state);
        layer.selectionStateFromJson(state, entry);
        layers.push({ layer, state });
      }
    });
    this.pin.value = layers.length > 0 || position !== undefined;
    this.value = { position, coordinateSpace, layers };
  }
}

export function capturePersistentViewerSelectionState(
  layerSelectedValues: Borrowed<LayerSelectedValues>,
): PersistentViewerSelectionState | undefined {
  const { mouseState } = layerSelectedValues;
  if (!mouseState.active) return undefined;
  const layers: PersistentLayerSelectionState[] = [];
  for (const layer of layerSelectedValues.layerManager.managedLayers) {
    const userLayer = layer.layer;
    if (userLayer === null) continue;
    const state = layerSelectedValues.get(userLayer);
    if (state === undefined) continue;
    const stateCopy = {} as UserLayerSelectionState;
    userLayer.initializeSelectionState(stateCopy);
    userLayer.copySelectionState(stateCopy, state);
    layers.push({
      layer: userLayer,
      state: stateCopy,
    });
  }
  return {
    position: mouseState.position.slice(),
    coordinateSpace: mouseState.coordinateSpace,
    layers,
  };
}

export interface LayerView {
  displayDimensionRenderInfo: WatchableDisplayDimensionRenderInfo;
  flushBackendProjectionParameters(): void;
  rpc: RPC;
  rpcId: number;
}

export class VisibleLayerInfo<
  View extends LayerView = LayerView,
  AttachmentState = unknown,
> extends RefCounted {
  messages = new MessageList();
  seenGeneration = -1;
  state: AttachmentState | undefined = undefined;
  constructor(public view: View) {
    super();
  }
}

let visibleLayerInfoGeneration = 0;

export class VisibleRenderLayerTracker<
  View extends LayerView,
  RenderLayerType extends VisibilityTrackedRenderLayer<View>,
> extends RefCounted {
  /**
   * Maps a layer to the disposer to call when it is no longer visible.
   */
  private visibleLayers_ = new Map<RenderLayerType, VisibleLayerInfo<View>>();

  private debouncedUpdateVisibleLayers = this.registerCancellable(
    debounce(() => this.updateVisibleLayers(), 0),
  );

  constructor(
    public layerManager: LayerManager,
    public renderLayerType: { new (...args: any[]): RenderLayerType },
    public view: View,
    public roles: WatchableSet<RenderLayerRole>,
    private layerAdded: (
      layer: RenderLayerType,
      info: VisibleLayerInfo<View>,
    ) => void,
    public visibility: WatchableVisibilityPriority,
  ) {
    super();
    this.registerDisposer(
      layerManager.layersChanged.add(this.debouncedUpdateVisibleLayers),
    );
    this.registerDisposer(roles.changed.add(this.debouncedUpdateVisibleLayers));
    this.updateVisibleLayers();
  }

  disposed() {
    this.visibleLayers.forEach((attachment) => attachment.dispose());
    this.visibleLayers.clear();
    super.disposed();
  }

  private updateVisibleLayers() {
    const curGeneration = ++visibleLayerInfoGeneration;
    const {
      visibleLayers_: visibleLayers,
      renderLayerType,
      layerAdded,
      roles,
    } = this;
    for (const renderLayer of this.layerManager.readyRenderLayers()) {
      if (
        renderLayer instanceof renderLayerType &&
        roles.has(renderLayer.role)
      ) {
        const typedLayer = <RenderLayerType>renderLayer;
        let info = visibleLayers.get(typedLayer);
        if (info === undefined) {
          info = new VisibleLayerInfo(this.view);
          info.registerDisposer(typedLayer.messages.addChild(info.messages));
          info.registerDisposer(typedLayer.addRef());
          info.registerDisposer(typedLayer.visibility.add(this.visibility));
          visibleLayers.set(typedLayer, info);
          layerAdded(typedLayer, info);
          typedLayer.attach(info);
        }
        info.seenGeneration = curGeneration;
      }
    }
    for (const [renderLayer, info] of visibleLayers) {
      if (info.seenGeneration !== curGeneration) {
        visibleLayers.delete(renderLayer);
        info.dispose();
      }
    }
  }

  get visibleLayers() {
    this.debouncedUpdateVisibleLayers.flush();
    return this.visibleLayers_;
  }
}

export function makeRenderedPanelVisibleLayerTracker<
  View extends RenderedPanel & LayerView,
  RenderLayerType extends VisibilityTrackedRenderLayer<View>,
>(
  layerManager: LayerManager,
  renderLayerType: { new (...args: any[]): RenderLayerType },
  roles: WatchableSet<RenderLayerRole>,
  panel: View,
  layerAdded?: (layer: RenderLayerType, info: VisibleLayerInfo<View>) => void,
) {
  return panel.registerDisposer(
    new VisibleRenderLayerTracker(
      layerManager,
      renderLayerType,
      panel,
      roles,
      (layer, info) => {
        info.registerDisposer(
          layer.redrawNeeded.add(() => panel.scheduleRedraw()),
        );
        const { backend } = layer;
        if (backend) {
          backend.rpc!.invoke(RENDERED_VIEW_ADD_LAYER_RPC_ID, {
            layer: backend.rpcId,
            view: panel.rpcId,
          });
          info.registerDisposer(() =>
            backend.rpc!.invoke(RENDERED_VIEW_REMOVE_LAYER_RPC_ID, {
              layer: backend.rpcId,
              view: panel.rpcId,
            }),
          );
        }
        if (layerAdded !== undefined) {
          layerAdded(layer, info);
        }
        panel.scheduleRedraw();
        info.registerDisposer(() => panel.scheduleRedraw());
      },
      panel.visibility,
    ),
  );
}

export class SelectedLayerState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  location = new TrackableSidePanelLocation(
    SELECTED_LAYER_SIDE_PANEL_DEFAULT_LOCATION,
  );
  layer_: ManagedUserLayer | undefined;

  get layer() {
    return this.layer_;
  }

  get visible() {
    return this.location.visible;
  }

  toggle(layer: ManagedUserLayer) {
    if (this.layer === layer && this.visible) {
      this.visible = false;
    } else {
      this.layer = layer;
      this.visible = true;
    }
  }

  set visible(value: boolean) {
    let existingLayer = this.layer_;
    if (value === true && existingLayer === undefined) {
      // Check if there is a layer
      const { managedLayers } = this.layerManager;
      if (managedLayers.length > 0) {
        existingLayer = this.layer = managedLayers[0];
      } else {
        value = false;
      }
    }
    if (value === true && existingLayer !== undefined) {
      const userLayer = existingLayer.layer;
      if (userLayer === null || userLayer.panels.panels[0].tabs.length === 0) {
        value = false;
      }
    }
    if (this.visible !== value) {
      this.location.visible = value;
      if (!value && existingLayer !== undefined) {
        this.maybeDeleteNewLayer(existingLayer);
      }
      this.changed.dispatch();
    }
  }

  private maybeDeleteNewLayer(existingLayer: ManagedUserLayer) {
    if (existingLayer.wasDisposed) return;
    const userLayer = existingLayer.layer;
    if (userLayer !== null && userLayer instanceof NewUserLayer) {
      if (!userLayer.dataSources.some((x) => x.spec.url.length !== 0)) {
        deleteLayer(existingLayer);
      }
    }
  }

  private existingLayerDisposer?: () => void;

  constructor(public layerManager: Owned<LayerManager>) {
    super();
    this.registerDisposer(layerManager);
    this.location.changed.add(() => {
      this.changed.dispatch();
      const userLayer = this.layer?.layer ?? undefined;
      if (userLayer !== undefined) {
        const curLocation = this.location.value;
        if (curLocation.visible) {
          const panel = userLayer.panels.panels[0];
          if (panel.location.value !== curLocation) {
            panel.location.value = curLocation;
            panel.location.locationChanged.dispatch();
          }
        }
      }
    });
  }

  set layer(layer: ManagedUserLayer | undefined) {
    if (layer === this.layer_) {
      return;
    }
    const existingLayer = this.layer_;
    if (existingLayer !== undefined) {
      this.existingLayerDisposer!();
      this.existingLayerDisposer = undefined;
      this.maybeDeleteNewLayer(existingLayer);
    }
    this.layer_ = layer;
    if (layer !== undefined) {
      const layerDisposed = () => {
        this.layer_ = undefined;
        this.visible = false;
        this.existingLayerDisposer = undefined;
        this.changed.dispatch();
      };
      layer.registerDisposer(layerDisposed);
      const layerChangedDisposer = layer.specificationChanged.add(() => {
        this.changed.dispatch();
      });
      this.existingLayerDisposer = () => {
        const userLayer = layer.layer;
        if (userLayer !== null) {
          const tool = userLayer.tool.value;
          if (tool !== undefined) {
            tool.deactivate();
          }
        }
        layer.unregisterDisposer(layerDisposed);
        layerChangedDisposer();
      };
    } else {
      this.location.visible = false;
    }
    this.changed.dispatch();
  }

  toJSON() {
    const obj: any = this.location.toJSON();
    if (this.layer !== undefined) {
      obj.layer = this.layer.name;
    }
    return emptyToUndefined(obj);
  }

  restoreState(obj: any) {
    if (obj === undefined) {
      this.reset();
      return;
    }
    verifyObject(obj);
    this.location.restoreState(obj);
    const layerName = verifyObjectProperty(obj, "layer", verifyOptionalString);
    const layer =
      layerName !== undefined
        ? this.layerManager.getLayerByName(layerName)
        : undefined;
    if (layer === undefined) {
      this.visible = false;
    }
    this.layer = layer;
  }

  reset() {
    this.location.reset();
    this.layer = undefined;
  }
}

export class LayerReference extends RefCounted implements Trackable {
  private layerName_: string | undefined;
  private layer_: ManagedUserLayer | undefined;
  changed = new NullarySignal();
  constructor(
    public layerManager: Owned<LayerManager>,
    public filter: (layer: ManagedUserLayer) => boolean,
  ) {
    super();
    this.registerDisposer(layerManager);
    this.registerDisposer(
      layerManager.specificationChanged.add(() => {
        const { layer_ } = this;
        if (layer_ !== undefined) {
          if (!this.layerManager.layerSet.has(layer_) || !this.filter(layer_)) {
            this.layer_ = undefined;
            this.layerName_ = undefined;
            this.changed.dispatch();
          } else {
            const { name } = layer_;
            if (name !== this.layerName_) {
              this.layerName_ = name;
              this.changed.dispatch();
            }
          }
        }
      }),
    );
  }

  get layer() {
    return this.layer_;
  }

  get layerName() {
    return this.layerName_;
  }

  set layer(value: ManagedUserLayer | undefined) {
    if (this.layer_ === value) {
      return;
    }
    if (
      value !== undefined &&
      this.layerManager.layerSet.has(value) &&
      this.filter(value)
    ) {
      this.layer_ = value;
      this.layerName_ = value.name;
    } else {
      this.layer_ = undefined;
      this.layerName_ = undefined;
    }
    this.changed.dispatch();
  }

  set layerName(value: string | undefined) {
    if (value === this.layerName_) {
      return;
    }
    this.layer_ = undefined;
    this.layerName_ = value;
    this.changed.dispatch();
    this.validate();
  }

  private validate = debounce(() => {
    const { layerName_ } = this;
    if (layerName_ !== undefined) {
      const layer = this.layerManager.getLayerByName(layerName_);
      if (layer !== undefined && this.filter(layer)) {
        this.layer_ = layer;
        this.changed.dispatch();
      } else {
        this.layer_ = undefined;
        this.layerName_ = undefined;
        this.changed.dispatch();
      }
    }
  }, 0);

  restoreState(obj: any) {
    const layerName = verifyOptionalString(obj);
    this.layerName = layerName;
  }

  toJSON() {
    const { layer_ } = this;
    if (layer_ !== undefined) {
      return layer_.name;
    }
    return this.layerName_;
  }

  reset() {
    this.layerName_ = undefined;
    this.layer_ = undefined;
    this.changed.dispatch();
  }
}

// Group of layers that share a set of properties, e.g. visible segment set.
export class LinkedLayerGroup extends RefCounted implements Trackable {
  // Only valid if `root_ == this.layer`.
  private linkedLayers_ = new Set<UserLayer>();
  private root_: UserLayer;
  changed = new NullarySignal();
  linkedLayersChanged = new NullarySignal();
  readonly root: WatchableValueInterface<UserLayer>;

  get linkedLayers(): ReadonlySet<UserLayer> {
    return this.linkedLayers_;
  }

  get rootGroup(): LinkedLayerGroup {
    return this.getGroup(this.root.value);
  }

  constructor(
    public layerManager: LayerManager,
    public layer: UserLayer,
    public predicate: (layer: UserLayer) => boolean,
    public getGroup: (layer: UserLayer) => LinkedLayerGroup,
  ) {
    super();
    this.root_ = layer;
    const self = this;
    this.root = {
      get value() {
        return self.root_;
      },
      changed: self.changed,
    };
  }

  reset() {
    this.isolate();
  }

  restoreState(obj: unknown) {
    if (obj === undefined) return;
    const name = verifyString(obj);
    this.linkByName(name);
  }

  toJSON() {
    const {
      root: { value: root },
    } = this;
    if (root === this.layer) return undefined;
    return root.managedLayer.name;
  }

  isolate(notifyChanged = true) {
    const { getGroup, layer, root_: root } = this;
    if (root === layer) {
      const { linkedLayers_ } = this;
      if (linkedLayers_.size !== 0) {
        for (const otherLayer of linkedLayers_) {
          const otherGroup = getGroup(otherLayer);
          otherGroup.root_ = otherLayer;
          otherGroup.changed.dispatch();
        }
        linkedLayers_.clear();
        this.linkedLayersChanged.dispatch();
      }
      return;
    }
    const rootGroup = getGroup(root);
    rootGroup.linkedLayers_.delete(layer);
    rootGroup.linkedLayersChanged.dispatch();
    this.root_ = layer;
    if (notifyChanged) {
      this.changed.dispatch();
    }
  }

  linkByName(otherLayerName: string) {
    const { layer } = this;
    const { managedLayer } = layer;
    const { layerManager } = this;
    const otherLayer = layerManager.getLayerByName(otherLayerName);
    if (otherLayer === undefined) return;
    if (otherLayer === managedLayer) return;
    const otherUserLayer = otherLayer.layer;
    if (otherUserLayer === null) return;
    if (!this.predicate(otherUserLayer)) return;
    this.linkToLayer(otherUserLayer);
  }

  linkToLayer(otherUserLayer: UserLayer) {
    if (otherUserLayer === this.layer) return;
    if (this.root_ === otherUserLayer) return;
    if (this.root_ !== this.layer) {
      this.isolate(/*notifyChanged=*/ false);
    }
    const { getGroup } = this;
    const newRoot = getGroup(otherUserLayer).root_;
    if (newRoot === this.layer) return;
    const rootGroup = getGroup(newRoot);
    rootGroup.linkedLayers_.add(this.layer);
    rootGroup.linkedLayersChanged.dispatch();
    this.root_ = newRoot;
    this.changed.dispatch();
  }

  disposed() {
    this.isolate(/*notifyChanged=*/ false);
  }
}

function initializeLayerFromSpecNoRestoreState(
  managedLayer: ManagedUserLayer,
  spec: any,
) {
  const layerType = verifyOptionalObjectProperty(
    spec,
    "type",
    verifyString,
    "auto",
  );
  managedLayer.archived = verifyOptionalObjectProperty(
    spec,
    "archived",
    verifyBoolean,
    false,
  );
  if (!managedLayer.archived) {
    managedLayer.visible = verifyOptionalObjectProperty(
      spec,
      "visible",
      verifyBoolean,
      true,
    );
  } else {
    managedLayer.visible = false;
  }
  const layerConstructor = layerTypes.get(layerType) || NewUserLayer;
  managedLayer.layer = new layerConstructor(managedLayer);
  return spec;
}

function completeUserLayerInitialization(
  managedLayer: Borrowed<ManagedUserLayer>,
  spec: any,
) {
  try {
    const userLayer = managedLayer.layer;
    if (userLayer === null) return;
    userLayer.restoreState(spec);
    userLayer.initializationDone();
  } catch (e) {
    deleteLayer(managedLayer);
    throw e;
  }
}

export function initializeLayerFromSpec(
  managedLayer: Borrowed<ManagedUserLayer>,
  spec: any,
) {
  try {
    verifyObject(spec);
    initializeLayerFromSpecNoRestoreState(managedLayer, spec);
    completeUserLayerInitialization(managedLayer, spec);
  } catch (e) {
    deleteLayer(managedLayer);
    throw e;
  }
}

export function initializeLayerFromSpecShowErrorStatus(
  managedLayer: Borrowed<ManagedUserLayer>,
  spec: any,
) {
  try {
    initializeLayerFromSpec(managedLayer, spec);
  } catch (e) {
    const msg = new StatusMessage();
    msg.setErrorMessage(e instanceof Error ? e.message : "" + e);
  }
}

export function makeLayer(
  manager: LayerListSpecification,
  name: string,
  spec: any,
): ManagedUserLayer {
  const managedLayer = new ManagedUserLayer(name, manager);
  initializeLayerFromSpec(managedLayer, spec);
  return managedLayer;
}

export abstract class LayerListSpecification extends RefCounted {
  changed = new NullarySignal();

  abstract rpc: RPC;

  abstract dataSourceProviderRegistry: Borrowed<DataSourceProviderRegistry>;
  abstract layerManager: Borrowed<LayerManager>;
  abstract chunkManager: Borrowed<ChunkManager>;
  abstract layerSelectedValues: Borrowed<LayerSelectedValues>;

  abstract readonly root: TopLevelLayerListSpecification;

  abstract add(
    layer: Owned<ManagedUserLayer>,
    index?: number | undefined,
  ): void;

  abstract rootLayers: Borrowed<LayerManager>;
}

export class TopLevelLayerListSpecification extends LayerListSpecification {
  get rpc() {
    return this.chunkManager.rpc!;
  }

  get root() {
    return this;
  }

  coordinateSpaceCombiner = new CoordinateSpaceCombiner(
    this.coordinateSpace,
    isGlobalDimension,
  );
  subsets = new Set<LayerSubsetSpecification>();

  layerSelectedValues = this.selectionState.layerSelectedValues;

  constructor(
    public display: DisplayContext,
    public dataSourceProviderRegistry: DataSourceProviderRegistry,
    public layerManager: LayerManager,
    public chunkManager: ChunkManager,
    public selectionState: Borrowed<TrackableDataSelectionState>,
    public selectedLayer: Borrowed<SelectedLayerState>,
    public coordinateSpace: WatchableValueInterface<CoordinateSpace>,
    public globalPosition: Borrowed<Position>,
    public toolBinder: Borrowed<GlobalToolBinder>,
  ) {
    super();
    this.registerDisposer(
      layerManager.layersChanged.add(this.changed.dispatch),
    );
    this.registerDisposer(
      layerManager.specificationChanged.add(this.changed.dispatch),
    );
  }

  reset() {
    this.layerManager.clear();
  }

  restoreState(x: any) {
    this.layerManager.clear();
    let layerSpecs: any[];
    if (!Array.isArray(x)) {
      verifyObject(x);
      layerSpecs = Object.entries(x).map(([name, layerSpec]) => {
        if (typeof layerSpec === "string") {
          return { name, source: layerSpec };
        }
        verifyObject(layerSpec);
        return { ...(layerSpec as any), name };
      });
    } else {
      layerSpecs = x;
    }
    const layersToRestore: { managedLayer: ManagedUserLayer; spec: any }[] = [];
    for (const layerSpec of layerSpecs) {
      verifyObject(layerSpec);
      const name = this.layerManager.getUniqueLayerName(
        verifyObjectProperty(layerSpec, "name", verifyString),
      );
      const managedLayer = new ManagedUserLayer(name, this);
      try {
        initializeLayerFromSpecNoRestoreState(managedLayer, layerSpec);
        this.layerManager.addManagedLayer(managedLayer);
        layersToRestore.push({ managedLayer, spec: layerSpec });
      } catch (e) {
        managedLayer.dispose();
        const msg = new StatusMessage();
        msg.setErrorMessage(
          `Error creating layer ${JSON.stringify(name)}: ` +
            (e instanceof Error)
            ? e.message
            : "" + e,
        );
      }
    }
    for (const { managedLayer, spec } of layersToRestore) {
      try {
        completeUserLayerInitialization(managedLayer, spec);
      } catch (e) {
        const msg = new StatusMessage();
        msg.setErrorMessage(
          `Error creating layer ${JSON.stringify(name)}: ` +
            (e instanceof Error)
            ? e.message
            : "" + e,
        );
      }
    }
  }

  add(layer: ManagedUserLayer, index?: number | undefined) {
    if (this.layerManager.managedLayers.indexOf(layer) === -1) {
      layer.name = this.layerManager.getUniqueLayerName(layer.name);
    }
    this.layerManager.addManagedLayer(layer, index);
  }

  toJSON() {
    const result = [];
    let numResults = 0;
    for (const managedLayer of this.layerManager.managedLayers) {
      const layerJson = managedLayer.toJSON();
      // A `null` layer specification is used to indicate a transient drag target, and should not be
      // serialized.
      if (layerJson != null) {
        result.push(layerJson);
        ++numResults;
      }
    }
    if (numResults === 0) {
      return undefined;
    }
    return result;
  }

  get rootLayers() {
    return this.layerManager;
  }
}

/**
 * Class for specifying a subset of a TopLevelLayerListsSpecification.
 */
export class LayerSubsetSpecification extends LayerListSpecification {
  changed = new NullarySignal();
  get rpc() {
    return this.master.rpc;
  }
  get dataSourceProviderRegistry() {
    return this.master.dataSourceProviderRegistry;
  }
  get chunkManager() {
    return this.master.chunkManager;
  }
  get layerSelectedValues() {
    return this.master.layerSelectedValues;
  }

  get root() {
    return this.master;
  }

  layerManager = this.registerDisposer(new LayerManager());

  constructor(public master: Owned<TopLevelLayerListSpecification>) {
    super();
    this.registerDisposer(master);
    const { layerManager } = this;
    this.registerDisposer(
      layerManager.layersChanged.add(this.changed.dispatch),
    );
    this.registerDisposer(
      layerManager.specificationChanged.add(this.changed.dispatch),
    );
    master.subsets.add(this);
  }

  disposed() {
    super.disposed();
    this.master.subsets.delete(this);
  }

  reset() {
    this.layerManager.clear();
  }

  restoreState(x: any) {
    const masterLayerManager = this.master.layerManager;
    const layers: ManagedUserLayer[] = [];
    for (const name of new Set(parseArray(x, verifyString))) {
      const layer = masterLayerManager.getLayerByName(name);
      if (layer === undefined) {
        throw new Error(
          `Undefined layer referenced in subset specification: ${JSON.stringify(
            name,
          )}`,
        );
      }
      if (layer.archived) continue;
      layers.push(layer);
    }
    this.layerManager.clear();
    for (const layer of layers) {
      this.layerManager.addManagedLayer(layer.addRef());
    }
  }

  toJSON() {
    return this.layerManager.managedLayers.map((x) => x.name);
  }

  add(layer: ManagedUserLayer, index?: number | undefined) {
    if (this.master.layerManager.managedLayers.indexOf(layer) === -1) {
      layer.name = this.master.layerManager.getUniqueLayerName(layer.name);
      this.master.layerManager.addManagedLayer(layer.addRef());
    }
    this.layerManager.addManagedLayer(layer, index);
  }

  get rootLayers() {
    return this.master.rootLayers;
  }
}

export type UserLayerConstructor<LayerType extends UserLayer = UserLayer> =
  typeof UserLayer & AnyConstructor<LayerType>;

export const layerTypes = new Map<string, UserLayerConstructor>();
const volumeLayerTypes = new Map<VolumeType, UserLayerConstructor>();
export interface LayerTypeGuess {
  // Layer constructor
  layerConstructor: UserLayerConstructor;
  // Priority of the guess.  Higher values take precedence.
  priority: number;
}
export type LayerTypeDetector = (
  subsource: DataSubsource,
) => LayerTypeGuess | undefined;
const layerTypeDetectors: LayerTypeDetector[] = [
  (subsource) => {
    const { volume } = subsource;
    if (volume === undefined) return undefined;
    const layerConstructor = volumeLayerTypes.get(volume.volumeType);
    if (layerConstructor === undefined) return undefined;
    return { layerConstructor, priority: 0 };
  },
];

export function registerLayerType(
  layerConstructor: UserLayerConstructor,
  name: string = layerConstructor.type,
) {
  layerTypes.set(name, layerConstructor);
}

export function registerLayerTypeDetector(detector: LayerTypeDetector) {
  layerTypeDetectors.push(detector);
}

export function registerVolumeLayerType(
  volumeType: VolumeType,
  layerConstructor: UserLayerConstructor,
) {
  volumeLayerTypes.set(volumeType, layerConstructor);
}

export function changeLayerType(
  managedLayer: Borrowed<ManagedUserLayer>,
  layerConstructor: typeof UserLayer,
) {
  const userLayer = managedLayer.layer;
  if (userLayer === null) return;
  const spec = userLayer.toJSON();
  const newUserLayer = new layerConstructor(managedLayer);
  newUserLayer.restoreState(spec);
  newUserLayer.initializationDone();
  managedLayer.layer = newUserLayer;
}

export function changeLayerName(
  managedLayer: Borrowed<ManagedUserLayer>,
  newName: string,
): boolean {
  if (newName !== managedLayer.name) {
    newName =
      managedLayer.manager.root.layerManager.getUniqueLayerName(newName);
    managedLayer.name = newName;
    managedLayer.layerChanged.dispatch();
    return true;
  }
  return false;
}

export function deleteLayer(managedLayer: Borrowed<ManagedUserLayer>) {
  if (managedLayer.wasDisposed) return;
  for (const layerManager of managedLayer.containers) {
    layerManager.removeManagedLayer(managedLayer);
  }
}

function getMaxPriorityGuess(
  a: LayerTypeGuess | undefined,
  b: LayerTypeGuess | undefined,
) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.priority < b.priority ? b : a;
}

export function detectLayerTypeFromDataSubsource(
  subsource: DataSubsource,
): LayerTypeGuess | undefined {
  let bestGuess: LayerTypeGuess | undefined;
  for (const detector of layerTypeDetectors) {
    bestGuess = getMaxPriorityGuess(bestGuess, detector(subsource));
  }
  const { volume } = subsource;
  if (volume !== undefined) {
    const layerConstructor = volumeLayerTypes.get(volume.volumeType);
    if (layerConstructor !== undefined) {
      bestGuess = getMaxPriorityGuess(bestGuess, {
        layerConstructor,
        priority: 0,
      });
    }
  }
  return bestGuess;
}

export function detectLayerType(
  userLayer: UserLayer,
): UserLayerConstructor | undefined {
  let guess: LayerTypeGuess | undefined;
  for (const dataSource of userLayer.dataSources) {
    const { loadState } = dataSource;
    if (loadState === undefined || loadState.error !== undefined) continue;
    for (const loadedSubsource of loadState.subsources) {
      const { subsourceEntry } = loadedSubsource;
      const { subsource } = subsourceEntry;
      if (!loadedSubsource.enabled) continue;
      guess = getMaxPriorityGuess(
        guess,
        detectLayerTypeFromDataSubsource(subsource),
      );
    }
  }
  return guess?.layerConstructor;
}

function detectLayerTypeFromSubsources(
  subsources: Iterable<LoadedDataSubsource>,
): LayerTypeGuess | undefined {
  let guess: LayerTypeGuess | undefined;
  for (const loadedSubsource of subsources) {
    const { subsourceEntry } = loadedSubsource;
    const { subsource } = subsourceEntry;
    guess = getMaxPriorityGuess(
      guess,
      detectLayerTypeFromDataSubsource(subsource),
    );
  }
  return guess;
}

/**
 * Special UserLayer type used when creating a new layer in the UI.
 */
export class NewUserLayer extends UserLayer {
  static type = "new";
  static typeAbbreviation = "new";
  detectedLayerConstructor: UserLayerConstructor | undefined;

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    this.detectedLayerConstructor =
      detectLayerTypeFromSubsources(subsources)?.layerConstructor;
  }
}

/**
 * Special UserLayer type that automatically changes to the appropriate layer type.
 */
export class AutoUserLayer extends UserLayer {
  static type = "auto";
  static typeAbbreviation = "auto";

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    const layerConstructor =
      detectLayerTypeFromSubsources(subsources)?.layerConstructor;
    if (layerConstructor !== undefined) {
      changeLayerType(this.managedLayer, layerConstructor);
    }
  }
}

export function addNewLayer(
  manager: Borrowed<LayerListSpecification>,
  selectedLayer: Borrowed<SelectedLayerState>,
) {
  const layer = makeLayer(manager, "new layer", { type: "new" });
  manager.add(layer);
  selectedLayer.layer = layer;
  selectedLayer.visible = true;
}

registerLayerType(NewUserLayer);
registerLayerType(AutoUserLayer);
