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
import throttle from 'lodash/throttle';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {RenderedPanel} from 'neuroglancer/display_context';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import {SpatialPosition} from 'neuroglancer/navigation_state';
import {TrackableRefCounted, WatchableSet} from 'neuroglancer/trackable_value';
import {restoreTool, Tool} from 'neuroglancer/ui/tool';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {BoundingBox, vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyObjectProperty, verifyOptionalBoolean, verifyOptionalString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {addSignalBinding, removeSignalBinding, SignalBindingUpdater} from 'neuroglancer/util/signal_binding_updater';
import {Trackable} from 'neuroglancer/util/trackable';
import {Uint64} from 'neuroglancer/util/uint64';
import {VisibilityPriorityAggregator, WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {TabSpecification} from 'neuroglancer/widget/tab_view';

export enum RenderLayerRole {
  DATA,
  ANNOTATION,
  DEFAULT_ANNOTATION,
}

export function allRenderLayerRoles() {
  return new WatchableSet(
      [RenderLayerRole.DATA, RenderLayerRole.ANNOTATION, RenderLayerRole.DEFAULT_ANNOTATION]);
}

export class RenderLayer extends RefCounted {
  ready = false;
  role: RenderLayerRole = RenderLayerRole.DATA;
  layerChanged = new NullarySignal();
  redrawNeeded = new NullarySignal();
  readyStateChanged = new NullarySignal();
  setReady(value: boolean) {
    this.ready = value;
    this.readyStateChanged.dispatch();
    this.layerChanged.dispatch();
  }

  handleAction(_action: string) {
    // Do nothing by default.
  }

  getValueAt(_x: Float32Array): any {
    return undefined;
  }

  /**
   * Base voxel size for this layer, in nanometers per voxel.
   */
  voxelSize: vec3|null = null;

  /**
   * Bounding box for this layer, in nanometers.
   */
  boundingBox: BoundingBox|null = null;

  /**
   * Transform the stored pickedValue and offset associated with the retrieved pick ID into the
   * actual value.
   */
  transformPickedValue(pickedValue: Uint64, _pickedOffset: number): any {
    return pickedValue;
  }

  /**
   * Optionally updates the mouse state based on the retrived pick information.  This might snap the
   * 3-d position to the center of the picked point.
   */
  updateMouseState(
      _mouseState: MouseSelectionState, _pickedValue: Uint64, _pickedOffset: number, _data: any) {}
}

/**
 * Extends RenderLayer with functionality for tracking the number of panels in which the layer is
 * visible.
 */
export class VisibilityTrackedRenderLayer extends RenderLayer {
  visibility = new VisibilityPriorityAggregator();
}

const TAB_JSON_KEY = 'tab';
const TOOL_JSON_KEY = 'tool';

export class UserLayer extends RefCounted {
  layersChanged = new NullarySignal();
  readyStateChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  renderLayers = new Array<RenderLayer>();
  isReady = false;
  tabs = this.registerDisposer(new TabSpecification());
  tool = this.registerDisposer(
      new TrackableRefCounted<Tool>(value => restoreTool(this, value), value => value.toJSON()));
  constructor(public manager: Borrowed<LayerListSpecification>, specification: any) {
    super();
    specification;
    this.tabs.changed.add(this.specificationChanged.dispatch);
    this.tool.changed.add(this.specificationChanged.dispatch);
  }

  restoreState(specification: any) {
    this.tool.restoreState(specification[TOOL_JSON_KEY]);
    this.tabs.restoreState(specification[TAB_JSON_KEY]);
  }

  addRenderLayer(layer: RenderLayer) {
    this.renderLayers.push(layer);
    const {layersChanged, readyStateChanged} = this;
    layer.layerChanged.add(layersChanged.dispatch);
    layer.readyStateChanged.add(readyStateChanged.dispatch);
    readyStateChanged.dispatch();
    layersChanged.dispatch();
  }

  removeRenderLayer(layer: RenderLayer) {
    const {renderLayers, layersChanged, readyStateChanged} = this;
    const index = renderLayers.indexOf(layer);
    if (index === -1) {
      throw new Error('Attempted to remove invalid RenderLayer');
    }
    renderLayers.splice(index, 1);
    layer.layerChanged.remove(layersChanged.dispatch);
    layer.readyStateChanged.remove(readyStateChanged.dispatch);
    layer.dispose();
    readyStateChanged.dispatch();
    layersChanged.dispatch();
  }

  disposed() {
    const {layersChanged, readyStateChanged} = this;
    for (const layer of this.renderLayers) {
      layer.layerChanged.remove(layersChanged.dispatch);
      layer.readyStateChanged.remove(readyStateChanged.dispatch);
      layer.dispose();
    }
    super.disposed();
  }

  getValueAt(position: Float32Array, pickState: PickState) {
    let result: any;
    let {renderLayers} = this;
    let {pickedRenderLayer} = pickState;
    if (pickedRenderLayer !== null && renderLayers.indexOf(pickedRenderLayer) !== -1) {
      return pickedRenderLayer.transformPickedValue(pickState.pickedValue, pickState.pickedOffset);
    }
    for (let layer of renderLayers) {
      if (!layer.ready) {
        continue;
      }
      result = layer.getValueAt(position);
      if (result !== undefined) {
        break;
      }
    }
    return result;
  }

  transformPickedValue(value: any) {
    return value;
  }

  toJSON(): any {
    return {
      [TAB_JSON_KEY]: this.tabs.toJSON(),
      [TOOL_JSON_KEY]: this.tool.toJSON(),
    };
  }

  handleAction(_action: string): void {}
}

export class ManagedUserLayer extends RefCounted {
  readyStateChanged = new NullarySignal();
  layerChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  wasDisposed = false;
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

  /**
   * If layer is not null, tranfers ownership of a reference.
   */
  constructor(name: string, layer: UserLayer|null = null, public visible: boolean = true) {
    super();
    this.name_ = name;
    this.layer = layer;
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
    this.wasDisposed = true;
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
  boundPositions = new WeakSet<SpatialPosition>();
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
    if (index === undefined) {
      index = this.managedLayers.length;
    }
    this.managedLayers.splice(index, 0, managedLayer);
    this.layersChanged.dispatch();
    this.readyStateChanged.dispatch();
    return managedLayer;
  }

  /**
   * Assumes ownership of an existing reference to userLayer.
   */
  addUserLayer(name: string, userLayer: UserLayer, visible: boolean) {
    let managedLayer = new ManagedUserLayer(name, userLayer, visible);
    return this.addManagedLayer(managedLayer);
  }

  * readyRenderLayers() {
    for (let managedUserLayer of this.managedLayers) {
      if (!managedUserLayer.visible || !managedUserLayer.layer) {
        continue;
      }
      for (let renderLayer of managedUserLayer.layer.renderLayers) {
        if (!renderLayer.ready) {
          continue;
        }
        yield renderLayer;
      }
    }
  }

  unbindManagedLayer(managedLayer: ManagedUserLayer) {
    this.updateSignalBindings(managedLayer, removeSignalBinding);
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

  /**
   * Asynchronously initialize the voxelSize and position based on the managed layers.
   *
   * The first ready layer with an associated bounding box will set the position to the center of
   * the bounding box.
   *
   * If the position later becomes invalid, it will be initialized again.
   */
  initializePosition(position: SpatialPosition) {
    let {boundPositions} = this;
    if (boundPositions.has(position)) {
      return;
    }
    boundPositions.add(position);

    // Deboucne to ensure that if the position is reset and the layers are reset immediately after,
    // the position will not be reinitialized based on the soon to be reset layers.
    const handler = debounce(() => {
      this.updatePositionFromLayers(position);
    });
    this.readyStateChanged.add(handler);
    position.changed.add(handler);
    this.updatePositionFromLayers(position);
  }

  updatePositionFromLayers(position: SpatialPosition) {
    if (position.valid) {
      return;
    }
    for (let managedLayer of this.managedLayers) {
      let userLayer = managedLayer.layer;
      if (userLayer == null) {
        continue;
      }
      for (let renderLayer of userLayer.renderLayers) {
        if (!renderLayer.ready) {
          continue;
        }
        if (!position.voxelSize.valid && renderLayer.voxelSize != null) {
          vec3.copy(position.voxelSize.size, renderLayer.voxelSize);
          position.voxelSize.setValid();
        }

        if (!position.spatialCoordinatesValid && !position.voxelCoordinatesValid &&
            renderLayer.boundingBox != null) {
          let boundingBox = renderLayer.boundingBox;
          let centerPosition = position.spatialCoordinates;
          vec3.add(centerPosition, boundingBox.lower, boundingBox.upper);
          vec3.scale(centerPosition, centerPosition, 0.5);
          position.spatialCoordinatesValid = true;
          position.changed.dispatch();
        }
      }
    }
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
        if (!renderLayer.ready) {
          continue;
        }
        renderLayer.handleAction(action);
      }
    }
  }
}

const MOUSE_STATE_UPDATE_INTERVAL = 50;

export enum ActionState {
  INACTIVE,
  FIRST,  // Selecting elements for the first group.
  SECOND, // Selecting elements for the second group.
}

export enum ActionMode {
  NONE,
  MERGE,
  SPLIT,
}

export interface PickState {
  pickedRenderLayer: RenderLayer|null;
  pickedValue: Uint64;
  pickedOffset: number;
  actionMode: ActionMode;
  actionState: ActionState;
}

export class MouseSelectionState implements PickState {
  changed = new NullarySignal();
  position = vec3.create();
  active = false;
  actionMode = ActionMode.NONE;
  actionState = ActionState.INACTIVE;
  pickedRenderLayer: RenderLayer|null = null;
  pickedValue = new Uint64(0, 0);
  pickedOffset = 0;
  pickedAnnotationLayer: AnnotationLayerState|undefined = undefined;
  pickedAnnotationId: string|undefined = undefined;
  pickedAnnotationBuffer: ArrayBuffer|undefined = undefined;
  pickedAnnotationBufferOffset: number|undefined = undefined;
  pageX: number;
  pageY: number;

  updater: ((mouseState: MouseSelectionState) => boolean)|undefined = undefined;

  stale = false;

  triggerUpdate = throttle(() => {
    this.update();
  }, MOUSE_STATE_UPDATE_INTERVAL, {leading: true, trailing: true});

  updateUnconditionally() {
    this.triggerUpdate.cancel();
    this.update();
    return this.active;
  }

  updateIfStale() {
    if (this.stale) {
      this.update();
    }
  }

  private update() {
    let {updater} = this;
    this.stale = false;
    if (!updater) {
      this.setActive(false);
    } else {
      this.setActive(updater(this));
    }
  }

  setActive(value: boolean) {
    this.stale = false;
    if (this.active !== value || value === true) {
      this.active = value;
      this.changed.dispatch();
    }
  }

  setMode(mode: ActionMode) {
    this.actionMode = mode;
  }

  toggleAction() {
    if (this.actionState === ActionState.INACTIVE) {
      this.actionState = ActionState.FIRST;
    } else {
      this.actionState = ActionState.INACTIVE;
    }
  }

  updateAction() {
    switch (this.actionMode) {
      case ActionMode.MERGE: {
        if (this.actionState === ActionState.FIRST) {
          this.actionState = ActionState.SECOND;
          return ['merge', 'first'];
        } else {
          this.actionState = ActionState.INACTIVE;
          return ['merge', 'second'];
        }
      }
      case ActionMode.SPLIT: {
        if (this.actionState === ActionState.FIRST) {
          this.actionState = ActionState.SECOND;
          return ['split', 'first'];
        } else {
          this.actionState = ActionState.INACTIVE;
          return ['split', 'second'];
        }
      }
      default: {
        // Should never happen
        return [];
      }
    }
  }
}

export class LayerSelectedValues extends RefCounted {
  values = new Map<UserLayer, any>();
  rawValues = new Map<UserLayer, any>();
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
    let rawValues = this.rawValues;
    let mouseState = this.mouseState;
    values.clear();
    rawValues.clear();
    if (mouseState.active) {
      let position = mouseState.position;
      for (let layer of this.layerManager.managedLayers) {
        let userLayer = layer.layer;
        if (layer.visible && userLayer) {
          let result = userLayer.getValueAt(position, mouseState);
          rawValues.set(userLayer, result);
          values.set(userLayer, userLayer.transformPickedValue(result));
        }
      }
    }
  }

  get(userLayer: UserLayer) {
    this.update();
    return this.values.get(userLayer);
  }

  getRaw(userLayer: UserLayer) {
    this.update();
    return this.rawValues.get(userLayer);
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

export class VisibleRenderLayerTracker<RenderLayerType extends VisibilityTrackedRenderLayer> extends
    RefCounted {
  /**
   * Maps a layer to the disposer to call when it is no longer visible.
   */
  private visibleLayers = new Map<RenderLayerType, () => void>();
  private newVisibleLayers = new Set<RenderLayerType>();

  private debouncedUpdateVisibleLayers =
      this.registerCancellable(debounce(() => this.updateVisibleLayers(), 0));

  constructor(
      public layerManager: LayerManager,
      public renderLayerType: {new(...args: any[]): RenderLayerType},
      public roles: WatchableSet<RenderLayerRole>,
      private layerAdded: (layer: RenderLayerType) => (() => void),
      public visibility: WatchableVisibilityPriority) {
    super();
    this.registerDisposer(layerManager.layersChanged.add(this.debouncedUpdateVisibleLayers));
    this.registerDisposer(roles.changed.add(this.debouncedUpdateVisibleLayers));
    this.updateVisibleLayers();
  }

  disposed() {
    this.visibleLayers.forEach(disposer => disposer());
    this.visibleLayers.clear();
    super.disposed();
  }

  private updateVisibleLayers() {
    let {visibleLayers, newVisibleLayers, renderLayerType, layerAdded, roles} = this;
    for (let renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof renderLayerType && roles.has(renderLayer.role)) {
        let typedLayer = <RenderLayerType>renderLayer;
        newVisibleLayers.add(typedLayer);
        if (!visibleLayers.has(typedLayer)) {
          const visibilityDisposer = typedLayer.visibility.add(this.visibility);
          const disposer = layerAdded(typedLayer);
          visibleLayers.set(typedLayer.addRef(), () => {
            disposer();
            visibilityDisposer();
            typedLayer.dispose();
          });
        }
      }
    }
    for (let [renderLayer, disposer] of visibleLayers) {
      if (!newVisibleLayers.has(renderLayer)) {
        visibleLayers.delete(renderLayer);
        disposer();
      }
    }
    newVisibleLayers.clear();
  }

  getVisibleLayers() {
    (<any>this.debouncedUpdateVisibleLayers).flush();
    return [...this.visibleLayers.keys()];
  }
}

export function
makeRenderedPanelVisibleLayerTracker<RenderLayerType extends VisibilityTrackedRenderLayer>(
    layerManager: LayerManager, renderLayerType: {new (...args: any[]): RenderLayerType},
    roles: WatchableSet<RenderLayerRole>, panel: RenderedPanel,
    layerAdded?: (layer: RenderLayerType) => ((() => void) | void)) {
  return panel.registerDisposer(
      new VisibleRenderLayerTracker(layerManager, renderLayerType, roles, layer => {
        const disposer = layer.redrawNeeded.add(() => panel.scheduleRedraw());
        const disposer2 = layerAdded && layerAdded(layer);
        panel.scheduleRedraw();
        return () => {
          if (disposer2 !== undefined) {
            disposer2();
          }
          disposer();
          panel.scheduleRedraw();
        };
      }, panel.visibility));
}

export class SelectedLayerState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  visible_ = false;
  layer_: ManagedUserLayer|undefined;

  get layer() {
    return this.layer_;
  }

  get visible() {
    return this.visible_;
  }

  set visible(value: boolean) {
    if (this.layer_ === undefined) {
      value = false;
    }
    if (this.visible_ !== value) {
      this.visible_ = value;
      this.changed.dispatch();
    }
  }

  private existingLayerDisposer?: () => void;

  constructor(public layerManager: Owned<LayerManager>) {
    super();
    this.registerDisposer(layerManager);
  }

  set layer(layer: ManagedUserLayer|undefined) {
    if (layer === this.layer_) {
      return;
    }
    if (this.layer_ !== undefined) {
      this.existingLayerDisposer!();
      this.existingLayerDisposer = undefined;
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
    return {'layer': this.layer.name, 'visible': this.visible === true ? true : undefined};
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
