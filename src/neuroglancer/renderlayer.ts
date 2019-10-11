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

import {MouseSelectionState, VisibleLayerInfo} from 'neuroglancer/layer';
import {DisplayDimensions} from 'neuroglancer/navigation_state';
import {PickIDManager} from 'neuroglancer/object_picking';
import {get3dModelToDisplaySpaceMatrix, RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform';
import {WatchableSet} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {MessageList, MessageSeverity} from 'neuroglancer/util/message_list';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {VisibilityPriorityAggregator} from 'neuroglancer/visibility_priority/frontend';

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
  role: RenderLayerRole = RenderLayerRole.DATA;
  messages = new MessageList();
  layerChanged = new NullarySignal();
  redrawNeeded = new NullarySignal();

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

export interface ThreeDimensionalReadyRenderContext {
  viewProjectionMat: mat4;
  displayDimensions: DisplayDimensions;
  globalPosition: Float32Array;

  /**
   * Width of GL viewport in pixels.
   */
  viewportWidth: number;

  /**
   * Height of GL viewport in pixels.
   */
  viewportHeight: number;
}

export interface ThreeDimensionalRenderContext extends ThreeDimensionalReadyRenderContext {
  pickIDs: PickIDManager;
}


export interface ThreeDimensionalRenderLayerAttachmentState {
  transform: RenderLayerTransformOrError;
  displayDimensions: DisplayDimensions;
  modelTransform: mat4|undefined;
}

export function update3dRenderLayerAttachment(
    transform: RenderLayerTransformOrError, displayDimensions: DisplayDimensions,
    attachment: VisibleLayerInfo<ThreeDimensionalRenderLayerAttachmentState>): mat4|undefined {
  let {state} = attachment;
  if (state === undefined || state.transform !== transform ||
      state.displayDimensions !== displayDimensions) {
    attachment.messages.clearMessages();
    state = attachment.state = {transform, displayDimensions, modelTransform: undefined};
    if (transform.error !== undefined) {
      attachment.messages.addMessage({severity: MessageSeverity.error, message: transform.error});
      return undefined;
    }
    try {
      const modelTransform = mat4.create();
      get3dModelToDisplaySpaceMatrix(modelTransform, displayDimensions, transform);
      state.modelTransform = modelTransform;
    } catch (e) {
      attachment.messages.addMessage(
          {severity: MessageSeverity.error, message: (e as Error).message});
    }
  }
  return state.modelTransform;
}
