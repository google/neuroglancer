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

import debounce from 'lodash/debounce';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateSpace, CoordinateSpaceCombiner, CoordinateTransformSpecification, coordinateTransformSpecificationFromLegacyJson, isGlobalDimension, isLocalDimension, isLocalOrChannelDimension, TrackableCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {DataSourceSpecification, makeEmptyDataSourceSpecification} from 'neuroglancer/datasource';
import {DataSourceProviderRegistry, DataSubsource} from 'neuroglancer/datasource';
import {RenderedPanel} from 'neuroglancer/display_context';
import {LayerDataSource, layerDataSourceSpecificationFromJson, LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {DisplayDimensions, Position} from 'neuroglancer/navigation_state';
import {RenderLayer, RenderLayerRole, VisibilityTrackedRenderLayer} from 'neuroglancer/renderlayer';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {TrackableRefCounted, TrackableValue, WatchableSet, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {LayerDataSourcesTab} from 'neuroglancer/ui/layer_data_sources_tab';
import {restoreTool, Tool} from 'neuroglancer/ui/tool';
import {Borrowed, invokeDisposers, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {parseArray, verifyBoolean, verifyObject, verifyObjectProperty, verifyOptionalBoolean, verifyOptionalObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {MessageList} from 'neuroglancer/util/message_list';
import {NullarySignal} from 'neuroglancer/util/signal';
import {addSignalBinding, removeSignalBinding, SignalBindingUpdater} from 'neuroglancer/util/signal_binding_updater';
import {Trackable} from 'neuroglancer/util/trackable';
import {Uint64} from 'neuroglancer/util/uint64';
import {kEmptyFloat32Vec} from 'neuroglancer/util/vector';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {TabSpecification} from 'neuroglancer/widget/tab_view';
import {RPC} from 'neuroglancer/worker_rpc';

const TAB_JSON_KEY = 'tab';
const TOOL_JSON_KEY = 'tool';
const LOCAL_POSITION_JSON_KEY = 'localPosition';
const LOCAL_COORDINATE_SPACE_JSON_KEY = 'localDimensions';
const SOURCE_JSON_KEY = 'source';
const TRANSFORM_JSON_KEY = 'transform';

export class UserLayer extends RefCounted {
  get localPosition() {
    return this.managedLayer.localPosition;
  }

  get localCoordinateSpaceCombiner() {
    return this.managedLayer.localCoordinateSpaceCombiner;
  }

  get localCoordinateSpace() {
    return this.managedLayer.localCoordinateSpace;
  }

  static type: string;

  get type() {
    return (this.constructor as typeof UserLayer).type;
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
  tool: TrackableRefCounted<Tool> = this.registerDisposer(
      new TrackableRefCounted<Tool>(value => restoreTool(this, value), value => value.toJSON()));

  dataSourcesChanged = new NullarySignal();
  dataSources: LayerDataSource[] = [];

  get manager() {
    return this.managedLayer.manager;
  }

  constructor(public managedLayer: Borrowed<ManagedUserLayer>, specification: any) {
    super();
    this.localCoordinateSpaceCombiner.includeDimensionPredicate = isLocalOrChannelDimension;
    specification;
    this.tabs.changed.add(this.specificationChanged.dispatch);
    this.tool.changed.add(this.specificationChanged.dispatch);
    this.localPosition.changed.add(this.specificationChanged.dispatch);
    this.dataSourcesChanged.add(this.specificationChanged.dispatch);
    this.dataSourcesChanged.add(() => this.updateDataSubsourceActivations());
    this.tabs.add('source', {
      label: 'Source',
      order: -100,
      getter: () => new LayerDataSourcesTab(this),
    });
  }

  canAddDataSource() {
    return true;
  }

  addDataSource(spec: DataSourceSpecification|undefined) {
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
    function* getDataSubsources(this: UserLayer): Iterable<LoadedDataSubsource> {
      for (const dataSource of this.dataSources) {
        const {loadState} = dataSource;
        if (loadState === undefined || loadState.error !== undefined) continue;
        for (const subsource of loadState.subsources) {
          if (subsource.enabled) {
            yield subsource;
          } else {
            const {activated} = subsource;
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

  addCoordinateSpace(coordinateSpace: WatchableValueInterface<CoordinateSpace>) {
    const globalBinding = this.manager.root.coordinateSpaceCombiner.bind(coordinateSpace);
    const localBinding = this.localCoordinateSpaceCombiner.bind(coordinateSpace);
    return () => {
      globalBinding();
      localBinding();
    };
  }

  initializationDone() {
    this.decrementLoadingCounter();
  }

  getLegacyDataSourceSpecifications(
      sourceSpec: string|undefined, layerSpec: any,
      legacyTransform: CoordinateTransformSpecification|undefined): DataSourceSpecification[] {
    layerSpec;
    if (sourceSpec === undefined) return [];
    return [layerDataSourceSpecificationFromJson(sourceSpec, legacyTransform)];
  }

  getDataSourceSpecifications(layerSpec: any): DataSourceSpecification[] {
    let legacySpec: any = undefined;
    let specs = verifyObjectProperty(layerSpec, SOURCE_JSON_KEY, sourcesObj => {
      if (Array.isArray(sourcesObj)) {
        return sourcesObj.map(source => layerDataSourceSpecificationFromJson(source));
      } else if (typeof sourcesObj === 'object') {
        return [layerDataSourceSpecificationFromJson(sourcesObj)];
      } else {
        legacySpec = sourcesObj;
        return [];
      }
    });
    const legacyTransform = verifyObjectProperty(
        layerSpec, TRANSFORM_JSON_KEY, coordinateTransformSpecificationFromLegacyJson);
    specs.push(...this.getLegacyDataSourceSpecifications(legacySpec, layerSpec, legacyTransform));
    specs = specs.filter(spec => spec.url);
    if (specs.length === 0) {
      specs.push(makeEmptyDataSourceSpecification());
    }
    return specs;
  }

  restoreState(specification: any) {
    this.tool.restoreState(specification[TOOL_JSON_KEY]);
    this.tabs.restoreState(specification[TAB_JSON_KEY]);
    this.localCoordinateSpace.restoreState(specification[LOCAL_COORDINATE_SPACE_JSON_KEY]);
    this.localPosition.restoreState(specification[LOCAL_POSITION_JSON_KEY]);
    for (const spec of this.getDataSourceSpecifications(specification)) {
      this.addDataSource(spec);
    }
  }

  addRenderLayer(layer: Owned<RenderLayer>) {
    this.renderLayers.push(layer);
    const {layersChanged} = this;
    layer.layerChanged.add(layersChanged.dispatch);
    layersChanged.dispatch();
    return () => this.removeRenderLayer(layer);
  }

  removeRenderLayer(layer: RenderLayer) {
    const {renderLayers, layersChanged} = this;
    const index = renderLayers.indexOf(layer);
    if (index === -1) {
      throw new Error('Attempted to remove invalid RenderLayer');
    }
    renderLayers.splice(index, 1);
    layer.layerChanged.remove(layersChanged.dispatch);
    layer.dispose();
    layersChanged.dispatch();
  }

  disposed() {
    const {layersChanged} = this;
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
    let {renderLayers} = this;
    let {pickedRenderLayer} = pickState;
    if (pickedRenderLayer !== null && renderLayers.indexOf(pickedRenderLayer) !== -1) {
      result =
          pickedRenderLayer.transformPickedValue(pickState.pickedValue, pickState.pickedOffset);
      return this.transformPickedValue(result);
    }
    for (let layer of renderLayers) {
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
      [TAB_JSON_KEY]: this.tabs.toJSON(),
      [TOOL_JSON_KEY]: this.tool.toJSON(),
      [LOCAL_COORDINATE_SPACE_JSON_KEY]: this.localCoordinateSpace.toJSON(),
      [LOCAL_POSITION_JSON_KEY]: this.localPosition.toJSON(),
    };
  }

  handleAction(_action: string): void {}
}

function dataSourcesToJson(sources: readonly LayerDataSource[]) {
  if (sources.length === 0) return undefined;
  if (sources.length === 1) return sources[0].toJSON();
  return sources.map(x => x.toJSON());
}

export class ManagedUserLayer extends RefCounted {
  localCoordinateSpace = new TrackableCoordinateSpace();
  localCoordinateSpaceCombiner =
      new CoordinateSpaceCombiner(this.localCoordinateSpace, isLocalDimension);
  localPosition = this.registerDisposer(new Position(this.localCoordinateSpace));

  readyStateChanged = new NullarySignal();
  layerChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  containers = new Set<Borrowed<LayerManager>>();
  private layer_: UserLayer|null = null;
  get layer() {
    return this.layer_;
  }
  private unregisterUserLayer: (() => void)|undefined;

  /**
   * If layer is not null, tranfers ownership of a reference.
   */
  set layer(layer: UserLayer|null) {
    let oldLayer = this.layer_;
    if (oldLayer != null) {
      this.unregisterUserLayer!();
      oldLayer.dispose();
    }
    this.layer_ = layer;
    if (layer != null) {
      const removers = [
        layer.layersChanged.add(() => this.handleLayerChanged()),
        layer.readyStateChanged.add(this.readyStateChanged.dispatch),
        layer.specificationChanged.add(this.specificationChanged.dispatch)
      ];
      this.unregisterUserLayer = () => {
        removers.forEach(x => x());
      };
      this.readyStateChanged.dispatch();
      this.handleLayerChanged();
    }
  }

  isReady() {
    const {layer} = this;
    return layer !== null && layer.isReady;
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

  /**
   * If layer is not null, tranfers ownership of a reference.
   */
  constructor(
      name: string, public initialSpecification: any,
      public manager: Borrowed<LayerListSpecification>) {
    super();
    this.name_ = name;
  }

  toJSON() {
    let userLayer = this.layer;
    if (!userLayer) {
      return this.initialSpecification;
    }
    let layerSpec = userLayer.toJSON();
    layerSpec.name = this.name;
    if (!this.visible) {
      layerSpec['visible'] = false;
    }
    return layerSpec;
  }

  private handleLayerChanged() {
    if (this.visible) {
      this.layerChanged.dispatch();
    }
  }
  setVisible(value: boolean) {
    if (value !== this.visible) {
      this.visible = value;
      this.layerChanged.dispatch();
    }
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
  private renderLayerToManagedLayerMapGeneration = -1;
  private renderLayerToManagedLayerMap_ = new Map<RenderLayer, ManagedUserLayer>();

  constructor() {
    super();
    this.layersChanged.add(this.scheduleRemoveLayersWithSingleRef);
  }

  private scheduleRemoveLayersWithSingleRef =
      this.registerCancellable(debounce(() => this.removeLayersWithSingleRef(), 0));

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
    this.managedLayers = this.managedLayers.filter(layer => {
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
    this.filter(layer => layer.refCount !== 1);
  }

  private updateSignalBindings(
      layer: ManagedUserLayer, callback: SignalBindingUpdater<() => void>) {
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
  addManagedLayer(managedLayer: ManagedUserLayer, index?: number|undefined) {
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

  * readyRenderLayers() {
    for (let managedUserLayer of this.managedLayers) {
      if (!managedUserLayer.visible || !managedUserLayer.layer) {
        continue;
      }
      yield* managedUserLayer.layer.renderLayers;
    }
  }

  unbindManagedLayer(managedLayer: ManagedUserLayer) {
    this.updateSignalBindings(managedLayer, removeSignalBinding);
    managedLayer.containers.delete(this);
    managedLayer.dispose();
  }

  clear() {
    for (let managedLayer of this.managedLayers) {
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
    let index = this.managedLayers.indexOf(managedLayer);
    if (index === -1) {
      throw new Error(`Internal error: invalid managed layer.`);
    }
    this.remove(index);
  }

  reorderManagedLayer(oldIndex: number, newIndex: number) {
    const numLayers = this.managedLayers.length;
    if (oldIndex === newIndex || oldIndex < 0 || oldIndex >= numLayers || newIndex < 0 ||
        newIndex >= numLayers) {
      // Don't do anything.
      return;
    }
    let [oldLayer] = this.managedLayers.splice(oldIndex, 1);
    this.managedLayers.splice(newIndex, 0, oldLayer);
    this.layersChanged.dispatch();
  }

  disposed() {
    this.clear();
    super.disposed();
  }

  getLayerByName(name: string) {
    return this.managedLayers.find(x => x.name === name);
  }

  getUniqueLayerName(name: string) {
    let suggestedName = name;
    let suffix = 0;
    while (this.getLayerByName(suggestedName) !== undefined) {
      suggestedName = name + (++suffix);
    }
    return suggestedName;
  }

  has(layer: Borrowed<ManagedUserLayer>) {
    return this.layerSet.has(layer);
  }

  get renderLayers() {
    let layerManager = this;
    return {
      * [Symbol.iterator]() {
          for (let managedLayer of layerManager.managedLayers) {
            if (managedLayer.layer === null) {
              continue;
            }
            for (let renderLayer of managedLayer.layer.renderLayers) {
              yield renderLayer;
            }
          }
        }
    };
  }

  get visibleRenderLayers() {
    let layerManager = this;
    return {
      * [Symbol.iterator]() {
          for (let managedLayer of layerManager.managedLayers) {
            if (managedLayer.layer === null || !managedLayer.visible) {
              continue;
            }
            for (let renderLayer of managedLayer.layer.renderLayers) {
              yield renderLayer;
            }
          }
        }
    };
  }

  invokeAction(action: string) {
    for (let managedLayer of this.managedLayers) {
      if (managedLayer.layer === null || !managedLayer.visible) {
        continue;
      }
      let userLayer = managedLayer.layer;
      userLayer.handleAction(action);
      for (let renderLayer of userLayer.renderLayers) {
        renderLayer.handleAction(action);
      }
    }
  }
}

export interface PickState {
  pickedRenderLayer: RenderLayer|null;
  pickedValue: Uint64;
  pickedOffset: number;
}

export class MouseSelectionState implements PickState {
  changed = new NullarySignal();
  position: Float32Array = kEmptyFloat32Vec;
  active = false;
  displayDimensions: DisplayDimensions|undefined = undefined;
  pickedRenderLayer: RenderLayer|null = null;
  pickedValue = new Uint64(0, 0);
  pickedOffset = 0;
  pickedAnnotationLayer: AnnotationLayerState|undefined = undefined;
  pickedAnnotationId: string|undefined = undefined;
  pickedAnnotationBuffer: ArrayBuffer|undefined = undefined;
  pickedAnnotationBufferOffset: number|undefined = undefined;
  pageX: number;
  pageY: number;

  private forcerFunction: (() => void)|undefined = undefined;

  removeForcer(forcer: (() => void)) {
    if (forcer === this.forcerFunction) {
      this.forcerFunction = undefined;
      this.setActive(false);
    }
  }

  setForcer(forcer: (() => void)|undefined) {
    this.forcerFunction = forcer;
    if (forcer === undefined) {
      this.setActive(false);
    }
  }

  updateUnconditionally(): boolean {
    const {forcerFunction} = this;
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
  values = new Map<UserLayer, any>();
  changed = new NullarySignal();
  needsUpdate = true;
  constructor(public layerManager: LayerManager, public mouseState: MouseSelectionState) {
    super();
    this.registerDisposer(mouseState.changed.add(() => {
      this.handleChange();
    }));
    this.registerDisposer(layerManager.layersChanged.add(() => {
      this.handleLayerChange();
    }));
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
    let values = this.values;
    let mouseState = this.mouseState;
    values.clear();
    if (mouseState.active) {
      let position = mouseState.position;
      for (let layer of this.layerManager.managedLayers) {
        let userLayer = layer.layer;
        if (layer.visible && userLayer) {
          values.set(userLayer, userLayer.getValueAt(position, mouseState));
        }
      }
    }
  }

  get(userLayer: UserLayer) {
    this.update();
    return this.values.get(userLayer);
  }

  toJSON() {
    this.update();
    const result: {[key: string]: any} = {};
    const {values} = this;
    for (const layer of this.layerManager.managedLayers) {
      const userLayer = layer.layer;
      if (userLayer) {
        let v = values.get(userLayer);
        if (v !== undefined) {
          if (v instanceof Uint64) {
            v = {'t': 'u64', 'v': v};
          }
          result[layer.name] = v;
        }
      }
    }
    return result;
  }
}

export class VisibleLayerInfo<AttachmentState = unknown> extends RefCounted {
  messages = new MessageList();
  seenGeneration = -1;
  state: AttachmentState|undefined = undefined;
}

let visibleLayerInfoGeneration = 0;

export class VisibleRenderLayerTracker<RenderLayerType extends VisibilityTrackedRenderLayer> extends
    RefCounted {
  /**
   * Maps a layer to the disposer to call when it is no longer visible.
   */
  private visibleLayers_ = new Map<RenderLayerType, VisibleLayerInfo>();

  private debouncedUpdateVisibleLayers =
      this.registerCancellable(debounce(() => this.updateVisibleLayers(), 0));

  constructor(
      public layerManager: LayerManager,
      public renderLayerType: {new(...args: any[]): RenderLayerType},
      public roles: WatchableSet<RenderLayerRole>,
      private layerAdded: (layer: RenderLayerType, info: VisibleLayerInfo) => void,
      public visibility: WatchableVisibilityPriority) {
    super();
    this.registerDisposer(layerManager.layersChanged.add(this.debouncedUpdateVisibleLayers));
    this.registerDisposer(roles.changed.add(this.debouncedUpdateVisibleLayers));
    this.updateVisibleLayers();
  }

  disposed() {
    this.visibleLayers.forEach(x => x.dispose());
    this.visibleLayers.clear();
    super.disposed();
  }

  private updateVisibleLayers() {
    const curGeneration = ++visibleLayerInfoGeneration;
    const {visibleLayers_: visibleLayers, renderLayerType, layerAdded, roles} = this;
    for (let renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof renderLayerType && roles.has(renderLayer.role)) {
        let typedLayer = <RenderLayerType>renderLayer;
        let info = visibleLayers.get(typedLayer);
        if (info === undefined) {
          info = new VisibleLayerInfo();
          info.registerDisposer(typedLayer.messages.addChild(info.messages));
          info.registerDisposer(typedLayer.addRef());
          info.registerDisposer(typedLayer.visibility.add(this.visibility));
          visibleLayers.set(typedLayer, info);
          layerAdded(typedLayer, info);
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

export function
makeRenderedPanelVisibleLayerTracker<RenderLayerType extends VisibilityTrackedRenderLayer>(
    layerManager: LayerManager, renderLayerType: {new (...args: any[]): RenderLayerType},
    roles: WatchableSet<RenderLayerRole>, panel: RenderedPanel,
    layerAdded?: (layer: RenderLayerType, info: VisibleLayerInfo) => void) {
  return panel.registerDisposer(
      new VisibleRenderLayerTracker(layerManager, renderLayerType, roles, (layer, info) => {
        info.registerDisposer(layer.redrawNeeded.add(() => panel.scheduleRedraw()));
        if (layerAdded !== undefined) {
          layerAdded(layer, info);
        }
        panel.scheduleRedraw();
        info.registerDisposer(() => panel.scheduleRedraw());
      }, panel.visibility));
}

export class SelectedLayerState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  visible_ = false;
  layer_: ManagedUserLayer|undefined;
  size = new TrackableValue<number>(300, verifyPositiveInt)

  get layer() {
    return this.layer_;
  }

  get visible() {
    return this.visible_;
  }

  set visible(value: boolean) {
    const existingLayer = this.layer_;
    if (existingLayer === undefined) {
      value = false;
    }
    if (this.visible_ !== value) {
      this.visible_ = value;
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
      if (!userLayer.dataSources.some(x => x.spec.url.length !== 0)) {
        deleteLayer(existingLayer);
      }
    }
  }

  private existingLayerDisposer?: () => void;

  constructor(public layerManager: Owned<LayerManager>) {
    super();
    this.registerDisposer(layerManager);
    this.size.changed.add(this.changed.dispatch);
  }

  set layer(layer: ManagedUserLayer|undefined) {
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
      this.visible_ = false;
    }
    this.changed.dispatch();
  }

  toJSON() {
    if (this.layer === undefined) {
      return undefined;
    }
    return {
      'layer': this.layer.name,
      'visible': this.visible === true ? true : undefined,
      'size': this.size.toJSON(),
    };
  }

  restoreState(obj: any) {
    if (obj === undefined) {
      this.reset();
      return;
    }
    verifyObject(obj);
    const layerName = verifyObjectProperty(obj, 'layer', verifyOptionalString);
    const layer = layerName !== undefined ? this.layerManager.getLayerByName(layerName) : undefined;
    this.layer = layer;
    this.visible = verifyObjectProperty(obj, 'visible', verifyOptionalBoolean) ? true : false;
    verifyObjectProperty(obj, 'size', x => this.size.restoreState(x));
  }

  reset() {
    this.layer = undefined;
  }
}

export class LayerReference extends RefCounted implements Trackable {
  private layerName_: string|undefined;
  private layer_: ManagedUserLayer|undefined;
  changed = new NullarySignal();
  constructor(
      public layerManager: Owned<LayerManager>,
      public filter: (layer: ManagedUserLayer) => boolean) {
    super();
    this.registerDisposer(layerManager);
    this.registerDisposer(layerManager.specificationChanged.add(() => {
      const {layer_} = this;
      if (layer_ !== undefined) {
        if (!this.layerManager.layerSet.has(layer_) || !this.filter(layer_)) {
          this.layer_ = undefined;
          this.layerName_ = undefined;
          this.changed.dispatch();
        } else {
          const {name} = layer_;
          if (name !== this.layerName_) {
            this.layerName_ = name;
            this.changed.dispatch();
          }
        }
      }
    }));
  }

  get layer() {
    return this.layer_;
  }

  get layerName() {
    return this.layerName_;
  }

  set layer(value: ManagedUserLayer|undefined) {
    if (this.layer_ === value) {
      return;
    }
    if (value !== undefined && this.layerManager.layerSet.has(value) && this.filter(value)) {
      this.layer_ = value;
      this.layerName_ = value.name;
    } else {
      this.layer_ = undefined;
      this.layerName_ = undefined;
    }
    this.changed.dispatch();
  }

  set layerName(value: string|undefined) {
    if (value === this.layerName_) {
      return;
    }
    this.layer_ = undefined;
    this.layerName_ = value;
    this.changed.dispatch();
    this.validate();
  }

  private validate = debounce(() => {
    const {layerName_} = this;
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
    const {layer_} = this;
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

export abstract class LayerListSpecification extends RefCounted {
  changed = new NullarySignal();

  /**
   * @deprecated
   */
  get worker() {
    return this.rpc;
  }

  rpc: RPC;

  dataSourceProviderRegistry: Borrowed<DataSourceProviderRegistry>;
  layerManager: Borrowed<LayerManager>;
  chunkManager: Borrowed<ChunkManager>;
  layerSelectedValues: Borrowed<LayerSelectedValues>;
  coordinateSpace: WatchableValueInterface<CoordinateSpace|undefined>;

  readonly root: TopLevelLayerListSpecification;

  abstract initializeLayerFromSpec(managedLayer: ManagedUserLayer, spec: any): void;

  abstract getLayer(name: string, spec: any): ManagedUserLayer;

  abstract add(layer: Owned<ManagedUserLayer>, index?: number|undefined): void;

  rootLayers: Borrowed<LayerManager>;
}

export class TopLevelLayerListSpecification extends LayerListSpecification {
  get rpc() {
    return this.chunkManager.rpc!;
  }

  get root() {
    return this;
  }

  coordinateSpaceCombiner = new CoordinateSpaceCombiner(this.coordinateSpace, isGlobalDimension);

  constructor(
      public dataSourceProviderRegistry: DataSourceProviderRegistry,
      public layerManager: LayerManager, public chunkManager: ChunkManager,
      public layerSelectedValues: LayerSelectedValues,
      public coordinateSpace: WatchableValueInterface<CoordinateSpace>,
      public globalPosition: Borrowed<Position>) {
    super();
    this.registerDisposer(layerManager.layersChanged.add(this.changed.dispatch));
    this.registerDisposer(layerManager.specificationChanged.add(this.changed.dispatch));
  }

  reset() {
    this.layerManager.clear();
  }

  restoreState(x: any) {
    this.layerManager.clear();
    if (Array.isArray(x)) {
      // If array, layers have an order
      for (const layerObj of x) {
        verifyObject(layerObj);
        const name = this.layerManager.getUniqueLayerName(
            verifyObjectProperty(layerObj, 'name', verifyString));
        this.layerManager.addManagedLayer(this.getLayer(name, layerObj));
      }
    } else {
      // Keep for backwards compatibility
      verifyObject(x);
      for (let key of Object.keys(x)) {
        this.layerManager.addManagedLayer(this.getLayer(key, x[key]));
      }
    }
  }

  initializeLayerFromSpec(managedLayer: ManagedUserLayer, spec: any) {
    managedLayer.initialSpecification = spec;
    if (typeof spec === 'string') {
      spec = {'source': spec};
    }
    verifyObject(spec);
    const layerType = verifyOptionalObjectProperty(spec, 'type', verifyString, 'auto');
    managedLayer.visible = verifyOptionalObjectProperty(spec, 'visible', verifyBoolean, true);
    const layerConstructor = layerTypes.get(layerType) || NewUserLayer;
    const userLayer = new layerConstructor(managedLayer, spec);
    userLayer.restoreState(spec);
    userLayer.initializationDone();
    managedLayer.layer = userLayer;
  }

  getLayer(name: string, spec: any): ManagedUserLayer {
    let managedLayer = new ManagedUserLayer(name, spec, this);
    this.initializeLayerFromSpec(managedLayer, spec);
    return managedLayer;
  }

  add(layer: ManagedUserLayer, index?: number|undefined) {
    if (this.layerManager.managedLayers.indexOf(layer) === -1) {
      layer.name = this.layerManager.getUniqueLayerName(layer.name);
    }
    this.layerManager.addManagedLayer(layer, index);
  }

  toJSON() {
    const result = [];
    let numResults = 0;
    for (let managedLayer of this.layerManager.managedLayers) {
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
    const {layerManager} = this;
    this.registerDisposer(layerManager.layersChanged.add(this.changed.dispatch));
    this.registerDisposer(layerManager.specificationChanged.add(this.changed.dispatch));
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
            `Undefined layer referenced in subset specification: ${JSON.stringify(name)}`);
      }
      layers.push(layer);
    }
    this.layerManager.clear();
    for (const layer of layers) {
      this.layerManager.addManagedLayer(layer.addRef());
    }
  }

  toJSON() {
    return this.layerManager.managedLayers.map(x => x.name);
  }

  initializeLayerFromSpec(managedLayer: ManagedUserLayer, spec: any) {
    this.master.initializeLayerFromSpec(managedLayer, spec);
  }

  getLayer(name: string, spec: any): ManagedUserLayer {
    return this.master.getLayer(name, spec);
  }

  add(layer: ManagedUserLayer, index?: number|undefined) {
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

export type UserLayerConstructor = typeof UserLayer;

export const layerTypes = new Map<string, UserLayerConstructor>();
const volumeLayerTypes = new Map<VolumeType, UserLayerConstructor>();
export type LayerTypeDetector = (subsource: DataSubsource) => (UserLayerConstructor|undefined);
const layerTypeDetectors: LayerTypeDetector[] = [];

export function registerLayerType(name: string, layerConstructor: UserLayerConstructor) {
  layerTypes.set(name, layerConstructor);
}

export function registerLayerTypeDetector(detector: LayerTypeDetector) {
  layerTypeDetectors.push(detector);
}

export function registerVolumeLayerType(
    volumeType: VolumeType, layerConstructor: UserLayerConstructor) {
  volumeLayerTypes.set(volumeType, layerConstructor);
}

export function changeLayerType(
    managedLayer: Borrowed<ManagedUserLayer>, layerConstructor: typeof UserLayer) {
  const userLayer = managedLayer.layer;
  if (userLayer === null) return;
  const spec = userLayer.toJSON();
  spec['tab'] = userLayer.tabs.value;
  const newUserLayer = new layerConstructor(managedLayer, spec);
  newUserLayer.restoreState(spec);
  newUserLayer.initializationDone();
  managedLayer.layer = newUserLayer;
}

export function changeLayerName(
    managedLayer: Borrowed<ManagedUserLayer>, newName: string): boolean {
  if (newName !== managedLayer.name) {
    newName = managedLayer.manager.root.layerManager.getUniqueLayerName(newName);
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

export function detectLayerTypeFromDataSubsource(subsource: DataSubsource): UserLayerConstructor|
    undefined {
  for (const detector of layerTypeDetectors) {
    const layerConstructor = detector(subsource);
    if (layerConstructor !== undefined) {
      return layerConstructor;
    }
  }
  const {volume} = subsource;
  if (volume !== undefined) {
    const layerConstructor = volumeLayerTypes.get(volume.volumeType);
    if (layerConstructor !== undefined) {
      return layerConstructor;
    }
  }
  return undefined;
}

export function detectLayerType(userLayer: UserLayer): UserLayerConstructor|undefined {
  for (const dataSource of userLayer.dataSources) {
    const {loadState} = dataSource;
    if (loadState === undefined || loadState.error !== undefined) continue;
    for (const loadedSubsource of loadState.subsources) {
      const {subsourceEntry} = loadedSubsource;
      const {subsource} = subsourceEntry;
      if (!loadedSubsource.enabled) continue;
      const layerConstructor = detectLayerTypeFromDataSubsource(subsource);
      if (layerConstructor !== undefined) return layerConstructor;
    }
  }
  return undefined;
}

function detectLayerTypeFromSubsources(subsources: Iterable<LoadedDataSubsource>):
    UserLayerConstructor|undefined {
  for (const loadedSubsource of subsources) {
    const {subsourceEntry} = loadedSubsource;
    const {subsource} = subsourceEntry;
    const layerConstructor = detectLayerTypeFromDataSubsource(subsource);
    if (layerConstructor !== undefined) {
      return layerConstructor;
    }
  }
  return undefined;
}

/**
 * Special UserLayer type used when creating a new layer in the UI.
 */
export class NewUserLayer extends UserLayer {
  static type = 'new';
  detectedLayerConstructor: UserLayerConstructor|undefined;

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    this.detectedLayerConstructor = detectLayerTypeFromSubsources(subsources);
  }
}

/**
 * Special UserLayer type that automatically changes to the appropriate layer type.
 */
export class AutoUserLayer extends UserLayer {
  static type = 'auto';

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    const layerConstructor = detectLayerTypeFromSubsources(subsources);
    if (layerConstructor !== undefined) {
      changeLayerType(this.managedLayer, layerConstructor);
    }
  }
}

export function addNewLayer(
    manager: Borrowed<LayerListSpecification>, selectedLayer: Borrowed<SelectedLayerState>) {
  const layer = new ManagedUserLayer('new layer', {}, manager);
  manager.initializeLayerFromSpec(layer, {type: 'new'});
  manager.add(layer);
  selectedLayer.layer = layer;
  selectedLayer.visible = true;
}

registerLayerType('new', NewUserLayer);
registerLayerType('auto', AutoUserLayer);
