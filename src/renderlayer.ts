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

import { debounce } from "lodash-es";
import { LayerChunkProgressInfo } from "#src/chunk_manager/base.js";
import { RenderViewport, renderViewportsEqual } from "#src/display_context.js";
import type {
  LayerView,
  MouseSelectionState,
  PickState,
  UserLayer,
  VisibleLayerInfo,
} from "#src/layer/index.js";
import type {
  DisplayDimensionRenderInfo,
  NavigationState,
} from "#src/navigation_state.js";
import type { PickIDManager } from "#src/object_picking.js";
import {
  ProjectionParameters,
  projectionParametersEqual,
} from "#src/projection_parameters.js";
import type { RenderLayerTransformOrError } from "#src/render_coordinate_transform.js";
import { get3dModelToDisplaySpaceMatrix } from "#src/render_coordinate_transform.js";
import {
  PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID,
  PROJECTION_PARAMETERS_RPC_ID,
} from "#src/render_layer_common.js";
import type { WatchableValueChangeInterface } from "#src/trackable_value.js";
import { WatchableSet } from "#src/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { MessageList, MessageSeverity } from "#src/util/message_list.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import type { Uint64 } from "#src/util/uint64.js";
import { VisibilityPriorityAggregator } from "#src/visibility_priority/frontend.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObjectOwner, SharedObject } from "#src/worker_rpc.js";

export enum RenderLayerRole {
  DATA = 0,
  ANNOTATION = 1,
  DEFAULT_ANNOTATION = 2,
}

export function allRenderLayerRoles() {
  return new WatchableSet([
    RenderLayerRole.DATA,
    RenderLayerRole.ANNOTATION,
    RenderLayerRole.DEFAULT_ANNOTATION,
  ]);
}

export class RenderLayer extends RefCounted {
  userLayer: UserLayer | undefined;
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
    _mouseState: MouseSelectionState,
    _pickedValue: Uint64,
    _pickedOffset: number,
    _data: any,
  ) {}
}

/**
 * Extends RenderLayer with functionality for tracking the number of panels in which the layer is
 * visible.
 */
export class VisibilityTrackedRenderLayer<
  View extends LayerView = LayerView,
  AttachmentState = unknown,
> extends RenderLayer {
  backend: SharedObject | undefined;
  visibility = new VisibilityPriorityAggregator();
  attach(attachment: VisibleLayerInfo<View, AttachmentState>) {
    attachment;
  }
}

export interface ThreeDimensionalReadyRenderContext {
  projectionParameters: ProjectionParameters;
}

export interface ThreeDimensionalRenderContext
  extends ThreeDimensionalReadyRenderContext {
  pickIDs: PickIDManager;
  wireFrame: boolean;
  bindFramebuffer: () => void;
  frameNumber: number;
}

export interface ThreeDimensionalRenderLayerAttachmentState {
  transform: RenderLayerTransformOrError;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  modelTransform: mat4 | undefined;
}

export function update3dRenderLayerAttachment(
  transform: RenderLayerTransformOrError,
  displayDimensionRenderInfo: DisplayDimensionRenderInfo,
  attachment: VisibleLayerInfo<
    LayerView,
    ThreeDimensionalRenderLayerAttachmentState
  >,
): mat4 | undefined {
  let { state } = attachment;
  if (
    state === undefined ||
    state.transform !== transform ||
    state.displayDimensionRenderInfo !== displayDimensionRenderInfo
  ) {
    attachment.messages.clearMessages();
    state = attachment.state = {
      transform,
      displayDimensionRenderInfo,
      modelTransform: undefined,
    };
    if (transform.error !== undefined) {
      attachment.messages.addMessage({
        severity: MessageSeverity.error,
        message: transform.error,
      });
      return undefined;
    }
    try {
      const modelTransform = mat4.create();
      get3dModelToDisplaySpaceMatrix(
        modelTransform,
        displayDimensionRenderInfo,
        transform,
      );
      state.modelTransform = modelTransform;
    } catch (e) {
      attachment.messages.addMessage({
        severity: MessageSeverity.error,
        message: (e as Error).message,
      });
    }
  }
  return state.modelTransform;
}

export class DerivedProjectionParameters<
    Parameters extends ProjectionParameters = ProjectionParameters,
  >
  extends RefCounted
  implements WatchableValueChangeInterface<Parameters>
{
  private oldValue_: Parameters;
  private value_: Parameters;
  private renderViewport = new RenderViewport();

  changed = new Signal<(oldValue: Parameters, newValue: Parameters) => void>();
  constructor(options: {
    navigationState: Borrowed<NavigationState>;
    update: (out: Parameters, navigationState: NavigationState) => void;
    isEqual?: (a: Parameters, b: Parameters) => boolean;
    parametersConstructor?: { new (): Parameters };
  }) {
    super();
    const {
      parametersConstructor = ProjectionParameters as { new (): Parameters },
      navigationState,
      update,
      isEqual = projectionParametersEqual,
    } = options;
    this.oldValue_ = new parametersConstructor();
    this.value_ = new parametersConstructor();
    const performUpdate = () => {
      const { oldValue_, value_ } = this;
      oldValue_.displayDimensionRenderInfo =
        navigationState.displayDimensionRenderInfo.value;
      Object.assign(oldValue_, this.renderViewport);
      let { globalPosition } = oldValue_;
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
    const debouncedUpdate = (this.update = this.registerCancellable(
      debounce(performUpdate, 0),
    ));
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

  readonly update: (() => void) & { flush(): void };
}

@registerSharedObjectOwner(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParameters<
  T extends ProjectionParameters = ProjectionParameters,
> extends SharedObject {
  private prevDisplayDimensionRenderInfo:
    | undefined
    | DisplayDimensionRenderInfo = undefined;
  constructor(
    rpc: RPC,
    public base: WatchableValueChangeInterface<T>,
    public updateInterval = 10,
  ) {
    super();
    this.update = this.registerCancellable(
      debounce((_oldValue: T, newValue: T) => {
        // Note: Because we are using debouce, we cannot rely on `_oldValue`, since
        // `DerivedProjectionParameters` reuses the objects.
        let valueUpdate: any;
        if (
          newValue.displayDimensionRenderInfo !==
          this.prevDisplayDimensionRenderInfo
        ) {
          valueUpdate = newValue;
          this.prevDisplayDimensionRenderInfo =
            newValue.displayDimensionRenderInfo;
        } else {
          const { displayDimensionRenderInfo, ...remainder } = newValue;
          valueUpdate = remainder;
        }
        this.rpc!.invoke(PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, {
          id: this.rpcId,
          value: valueUpdate,
        });
      }, this.updateInterval),
    );
    this.initializeCounterpart(rpc, { value: base.value });
    this.registerDisposer(base.changed.add(this.update));
  }

  flush() {
    this.update.flush();
  }

  private update;
}
