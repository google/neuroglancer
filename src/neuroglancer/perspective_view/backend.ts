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

import {PERSPECTIVE_VIEW_ADD_LAYER_RPC_ID, PERSPECTIVE_VIEW_REMOVE_LAYER_RPC_ID, PERSPECTIVE_VIEW_RPC_ID} from 'neuroglancer/perspective_view/base';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {WatchableSet} from 'neuroglancer/trackable_value';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

@registerSharedObject(PERSPECTIVE_VIEW_RPC_ID)
export class PerspectiveViewState extends SharedObjectCounterpart {
  visibility: SharedWatchableValue<number>;
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
