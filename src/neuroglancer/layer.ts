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
import {RenderedPanel} from 'neuroglancer/display_context';
import {SpatialPosition} from 'neuroglancer/navigation_state';
import {RefCounted} from 'neuroglancer/util/disposable';
import {BoundingBox, vec3} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {addSignalBinding, removeSignalBinding, SignalBindingUpdater} from 'neuroglancer/util/signal_binding_updater';
import {Uint64} from 'neuroglancer/util/uint64';
import {VisibilityPriorityAggregator, WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';

export class RenderLayer extends RefCounted {
  ready = false;
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
  updateMouseState(_mouseState: MouseSelectionState, _pickedValue: Uint64, _pickedOffset: number) {}
}

/**
 * Extends RenderLayer with functionality for tracking the number of panels in which the layer is
 * visible.
 */
export class VisibilityTrackedRenderLayer extends RenderLayer {
  visibility = new VisibilityPriorityAggregator();
}

export class UserLayerDropdown extends RefCounted {
  onShow() {}
  onHide() {}
}

export class UserLayer extends RefCounted {
  layersChanged = new NullarySignal();
  readyStateChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  renderLayers = new Array<RenderLayer>();
  constructor(renderLayers: RenderLayer[] = []) {
    super();
    renderLayers.forEach(this.addRenderLayer.bind(this));
  }

  addRenderLayer(layer: RenderLayer) {
    this.renderLayers.push(layer);
    let {layersChanged, readyStateChanged} = this;
    this.registerDisposer(layer);
    this.registerDisposer(layer.layerChanged.add(layersChanged.dispatch));
    this.registerDisposer(layer.readyStateChanged.add(readyStateChanged.dispatch));
    readyStateChanged.dispatch();
    layersChanged.dispatch();
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
      if (!layer.ready) {
        continue;
      }
      result = layer.getValueAt(position);
      if (result !== undefined) {
        break;
      }
    }
    return this.transformPickedValue(result);
  }

  transformPickedValue(value: any) {
    return value;
  }

  toJSON(): any {
    return null;
  }

  makeDropdown(_element: HTMLDivElement): UserLayerDropdown|undefined {
    return undefined;
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

  /**
   * If layer is not null, tranfers ownership of a reference.
   */
  constructor(public name: string, layer: UserLayer|null = null, public visible: boolean = true) {
    super();
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
  managedLayers = new Array<ManagedUserLayer>();
  layersChanged = new NullarySignal();
  readyStateChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  boundPositions = new WeakSet<SpatialPosition>();

  private updateSignalBindings(
      layer: ManagedUserLayer, callback: SignalBindingUpdater<() => void>) {
    callback(layer.layerChanged, this.layersChanged.dispatch);
    callback(layer.readyStateChanged, this.readyStateChanged.dispatch);
    callback(layer.specificationChanged, this.specificationChanged.dispatch);
  }

  /**
   * Assumes ownership of an existing reference to managedLayer.
   */
  addManagedLayer(managedLayer: ManagedUserLayer) {
    this.updateSignalBindings(managedLayer, addSignalBinding);
    this.managedLayers.push(managedLayer);
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
    this.layersChanged.dispatch();
  }

  removeManagedLayer(managedLayer: ManagedUserLayer) {
    let index = this.managedLayers.indexOf(managedLayer);
    if (index === -1) {
      throw new Error(`Internal error: invalid managed layer.`);
    }
    this.unbindManagedLayer(managedLayer);
    this.managedLayers.splice(index, 1);
    this.layersChanged.dispatch();
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

export interface PickState {
  pickedRenderLayer: RenderLayer|null;
  pickedValue: Uint64;
  pickedOffset: number;
}

export class MouseSelectionState implements PickState {
  changed = new NullarySignal();
  position = vec3.create();
  active = false;
  pickedRenderLayer: RenderLayer|null = null;
  pickedValue = new Uint64(0, 0);
  pickedOffset = 0;

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
}

export class VisibleRenderLayerTracker<RenderLayerType extends VisibilityTrackedRenderLayer> extends
    RefCounted {
  /**
   * Maps a layer to the disposer to call when it is no longer visible.
   */
  private visibleLayers = new Map<RenderLayerType, () => void>();
  private newVisibleLayers = new Set<RenderLayerType>();
  private throttledUpdateVisibleLayers = throttle(() => {
    this.updateVisibleLayers();
  }, 0);

  constructor(
      public layerManager: LayerManager,
      public renderLayerType: {new(...args: any[]): RenderLayerType},
      private layerAdded: (layer: RenderLayerType) => (() => void),
      public visibility: WatchableVisibilityPriority) {
    super();
    this.registerDisposer(layerManager.layersChanged.add(() => {
      this.handleLayersChanged();
    }));
    this.updateVisibleLayers();
  }

  private handleLayersChanged() {
    this.throttledUpdateVisibleLayers();
  }

  disposed() {
    this.throttledUpdateVisibleLayers.cancel();
    this.visibleLayers.forEach(disposer => disposer());
    this.visibleLayers.clear();
    super.disposed();
  }

  private updateVisibleLayers() {
    let {visibleLayers, newVisibleLayers, renderLayerType, layerAdded} = this;
    for (let renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof renderLayerType) {
        let typedLayer = <RenderLayerType>renderLayer;
        newVisibleLayers.add(typedLayer);
        if (!visibleLayers.has(typedLayer)) {
          typedLayer.visibility.add(this.visibility);
          const disposer = layerAdded(typedLayer);
          visibleLayers.set(typedLayer.addRef(), () => {
            disposer();
            typedLayer.visibility.remove(this.visibility);
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
    (<any>this.throttledUpdateVisibleLayers).flush();
    return this.visibleLayers.keys();
  }
}

export function
makeRenderedPanelVisibleLayerTracker<RenderLayerType extends VisibilityTrackedRenderLayer>(
    layerManager: LayerManager, renderLayerType: {new (...args: any[]): RenderLayerType},
    panel: RenderedPanel) {
  return panel.registerDisposer(
      new VisibleRenderLayerTracker(layerManager, renderLayerType, layer => {
        const disposer = layer.redrawNeeded.add(() => panel.scheduleRedraw());
        panel.scheduleRedraw();
        return () => {
          disposer();
          panel.scheduleRedraw();
        };
      }, panel.visibility));
}
