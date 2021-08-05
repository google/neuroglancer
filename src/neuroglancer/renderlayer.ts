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
import {LayerChunkProgressInfo} from 'neuroglancer/chunk_manager/base';
import {RenderViewport, renderViewportsEqual} from 'neuroglancer/display_context';
import {LayerView, MouseSelectionState, PickState, UserLayer, VisibleLayerInfo} from 'neuroglancer/layer';
import {DisplayDimensionRenderInfo, NavigationState} from 'neuroglancer/navigation_state';
import {PickIDManager} from 'neuroglancer/object_picking';
import {ProjectionParameters, projectionParametersEqual} from 'neuroglancer/projection_parameters';
import {get3dModelToDisplaySpaceMatrix, RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform';
import {PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, PROJECTION_PARAMETERS_RPC_ID} from 'neuroglancer/render_layer_common';
import {WatchableSet, WatchableValueChangeInterface} from 'neuroglancer/trackable_value';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {MessageList, MessageSeverity} from 'neuroglancer/util/message_list';
import {NullarySignal, Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {VisibilityPriorityAggregator} from 'neuroglancer/visibility_priority/frontend';
import {registerSharedObjectOwner, RPC, SharedObject} from 'neuroglancer/worker_rpc';

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
  userLayer: UserLayer|undefined;
  role: RenderLayerRole = RenderLayerRole.DATA;
  messages = new MessageList();
  layerChanged = new NullarySignal();
  redrawNeeded = new NullarySignal();
  layerChunkProgressInfo = new LayerChunkProgressInfo();

  handleAction(_action: string) {
    // Do nothing by default.
  }

  getValueAt(_x: Float32Array): any {
    return undefined;
  }

  /**
   * Transform the stored pickedValue and offset associated with the retrieved pick ID into the
   * actual value.
   */
  transformPickedValue(pickState: PickState): any {
    return pickState.pickedValue;
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
export class VisibilityTrackedRenderLayer<
    View extends LayerView = LayerView, AttachmentState = unknown> extends RenderLayer {
  backend: SharedObject|undefined;
  visibility = new VisibilityPriorityAggregator();
  attach(attachment: VisibleLayerInfo<View, AttachmentState>) {
    attachment;
  }
}

export interface ThreeDimensionalReadyRenderContext {
  projectionParameters: ProjectionParameters;
}

export interface ThreeDimensionalRenderContext extends ThreeDimensionalReadyRenderContext {
  pickIDs: PickIDManager;
  wireFrame: boolean;
}


export interface ThreeDimensionalRenderLayerAttachmentState {
  transform: RenderLayerTransformOrError;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  modelTransform: mat4|undefined;
}

export function update3dRenderLayerAttachment(
    transform: RenderLayerTransformOrError, displayDimensionRenderInfo: DisplayDimensionRenderInfo,
    attachment: VisibleLayerInfo<LayerView, ThreeDimensionalRenderLayerAttachmentState>): mat4|
    undefined {
  let {state} = attachment;
  if (state === undefined || state.transform !== transform ||
      state.displayDimensionRenderInfo !== displayDimensionRenderInfo) {
    attachment.messages.clearMessages();
    state = attachment.state = {transform, displayDimensionRenderInfo, modelTransform: undefined};
    if (transform.error !== undefined) {
      attachment.messages.addMessage({severity: MessageSeverity.error, message: transform.error});
      return undefined;
    }
    try {
      const modelTransform = mat4.create();
      get3dModelToDisplaySpaceMatrix(modelTransform, displayDimensionRenderInfo, transform);
      state.modelTransform = modelTransform;
    } catch (e) {
      attachment.messages.addMessage(
          {severity: MessageSeverity.error, message: (e as Error).message});
    }
  }
  return state.modelTransform;
}

export class DerivedProjectionParameters<Parameters extends ProjectionParameters =
                                                                ProjectionParameters> extends
    RefCounted implements WatchableValueChangeInterface<Parameters> {
  private oldValue_: Parameters;
  private value_: Parameters;
  private renderViewport = new RenderViewport();

  changed = new Signal<(oldValue: Parameters, newValue: Parameters) => void>();
  constructor(options: {
    navigationState: Borrowed<NavigationState>,
    update: (out: Parameters, navigationState: NavigationState) => void,
    isEqual?: (a: Parameters, b: Parameters) => boolean,
    parametersConstructor?: {new(): Parameters},
  }) {
    super();
    const {
      parametersConstructor = ProjectionParameters as {new (): Parameters},
      navigationState,
      update,
      isEqual = projectionParametersEqual
    } = options;
    this.oldValue_ = new parametersConstructor();
    this.value_ = new parametersConstructor();
    const performUpdate = () => {
      const {oldValue_, value_} = this;
      oldValue_.displayDimensionRenderInfo = navigationState.displayDimensionRenderInfo.value;
      Object.assign(oldValue_, this.renderViewport);
      let {globalPosition} = oldValue_;
      const newGlobalPosition = navigationState.position.value;
      const rank = newGlobalPosition.length;
      if (globalPosition.length !== rank) {
        oldValue_.globalPosition = globalPosition = new Float32Array(rank);
      }
      globalPosition.set(newGlobalPosition);
      update(oldValue_, navigationState);
      if (isEqual(oldValue_, value_)) return;
      this.value_ = oldValue_;
      this.oldValue_ = value_;
      this.changed.dispatch(value_, oldValue_);
    };
    const debouncedUpdate = this.update = this.registerCancellable(debounce(performUpdate, 0));
    this.registerDisposer(navigationState.changed.add(debouncedUpdate));
    performUpdate();
  }

  setViewport(viewport: RenderViewport) {
    if (renderViewportsEqual(viewport, this.renderViewport)) return;
    Object.assign(this.renderViewport, viewport);
    this.update();
  }

  get value() {
    this.update.flush();
    return this.value_;
  }

  readonly update: (() => void)&{flush(): void};
}

@registerSharedObjectOwner(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParameters<T extends ProjectionParameters =
                                                      ProjectionParameters> extends SharedObject {
  private prevDisplayDimensionRenderInfo: undefined|DisplayDimensionRenderInfo = undefined;
  constructor(
      rpc: RPC, public base: WatchableValueChangeInterface<T>, public updateInterval: number = 10) {
    super();
    this.initializeCounterpart(rpc, {value: base.value});
    this.registerDisposer(base.changed.add(this.update));
  }

  flush() {
    this.update.flush();
  }

  private update = this.registerCancellable(debounce((_oldValue: T, newValue: T) => {
    // Note: Because we are using debouce, we cannot rely on `_oldValue`, since
    // `DerivedProjectionParameters` reuses the objects.
    let valueUpdate: any;
    if (newValue.displayDimensionRenderInfo !== this.prevDisplayDimensionRenderInfo) {
      valueUpdate = newValue;
      this.prevDisplayDimensionRenderInfo = newValue.displayDimensionRenderInfo;
    } else {
      const {displayDimensionRenderInfo, ...remainder} = newValue;
      valueUpdate = remainder;
    }
    this.rpc!.invoke(
        PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, {id: this.rpcId, value: valueUpdate});
  }, this.updateInterval));
}
