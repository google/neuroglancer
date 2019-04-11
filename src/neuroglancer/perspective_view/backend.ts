/**
 * @license
 * Copyright 2018 Google Inc.
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

/**
 * @file Backend component of PerspectivePanel.  This allows the optional backend component of a
 * PerspectiveViewRenderLayer to set chunk priorities based on the state of the perspective panel.
 */

import {PERSPECTIVE_VIEW_ADD_LAYER_RPC_ID, PERSPECTIVE_VIEW_REMOVE_LAYER_RPC_ID, PERSPECTIVE_VIEW_RPC_ID, PERSPECTIVE_VIEW_UPDATE_VIEWPORT_RPC_ID} from 'neuroglancer/perspective_view/base';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {WatchableSet, WatchableValue} from 'neuroglancer/trackable_value';
import {mat4} from 'neuroglancer/util/geom';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

export interface PerspectiveViewportInfo {
  /**
   * Width of the viewport in pixels, or 0 if there is no viewport yet.
   */
  width: number;

  /**
   * Height of the viewport in pixels, or 0 if there is no viewport yet.
   */
  height: number;

  /**
   * Transform from camera coordinates to OpenGL clip coordinates.
   */
  projectionMat: mat4;

  /**
   * Transform from world coordinates to camera coordinates.
   */
  viewMat: mat4;

  /**
   * Transform from world coordinates to OpenGL clip coordinates.  Equal to:
   * `projectionMat * viewMat`.
   */
  viewProjectionMat: mat4;
}

@registerSharedObject(PERSPECTIVE_VIEW_RPC_ID)
export class PerspectiveViewState extends SharedObjectCounterpart {
  visibility: SharedWatchableValue<number>;
  viewport = new WatchableValue<PerspectiveViewportInfo>({
    width: 0,
    height: 0,
    projectionMat: mat4.create(),
    viewMat: mat4.create(),
    viewProjectionMat: mat4.create()
  });
  constructor(...args: any[]) {
    super(...args);
    const rpc: RPC = args[0];
    const options: any = args[1];
    this.visibility = rpc.get(options['visibility']);
  }
}

export class PerspectiveViewRenderLayer extends SharedObjectCounterpart {
  viewStates = new WatchableSet<PerspectiveViewState>();
}

registerRPC(PERSPECTIVE_VIEW_UPDATE_VIEWPORT_RPC_ID, function(x) {
  const viewState: PerspectiveViewState = this.get(x.view);
  viewState.viewport.value = x.viewport;
});

registerRPC(PERSPECTIVE_VIEW_ADD_LAYER_RPC_ID, function(x) {
  const viewState: PerspectiveViewState = this.get(x.view);
  const layer: PerspectiveViewRenderLayer = this.get(x.layer);
  layer.viewStates.add(viewState);
});

registerRPC(PERSPECTIVE_VIEW_REMOVE_LAYER_RPC_ID, function(x) {
  const viewState: PerspectiveViewState = this.get(x.view);
  const layer: PerspectiveViewRenderLayer = this.get(x.layer);
  layer.viewStates.delete(viewState);
});
