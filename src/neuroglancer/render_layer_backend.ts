/**
 * @license
 * Copyright 2019 Google Inc.
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

import {ChunkRenderLayerBackend} from 'neuroglancer/chunk_manager/backend';
import {ProjectionParameters} from 'neuroglancer/projection_parameters';
import {PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, PROJECTION_PARAMETERS_RPC_ID, RENDERED_VIEW_ADD_LAYER_RPC_ID, RENDERED_VIEW_REMOVE_LAYER_RPC_ID} from 'neuroglancer/render_layer_common';
import {WatchableValueChangeInterface, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Signal} from 'neuroglancer/util/signal';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

export interface RenderedViewBackend {
  visibility: WatchableValueInterface<number>;
  projectionParameters: WatchableValueInterface<ProjectionParameters>;
}

export class RenderLayerBackendAttachment<
    ViewBackend extends RenderedViewBackend = RenderedViewBackend,
                        AttachmentState = unknown> extends RefCounted {
  state: AttachmentState|undefined = undefined;
  constructor(public view: ViewBackend) {
    super();
  }
}

export class RenderLayerBackend<ViewBackend extends RenderedViewBackend = RenderedViewBackend,
                                                    AttachmentState = unknown> extends
    ChunkRenderLayerBackend {
  attachments = new Map<ViewBackend, RenderLayerBackendAttachment>();
  attach(attachment: RenderLayerBackendAttachment<ViewBackend, AttachmentState>) {
    attachment;
  }
}

registerRPC(RENDERED_VIEW_ADD_LAYER_RPC_ID, function(x) {
  const view: RenderedViewBackend = this.get(x.view);
  const layer: RenderLayerBackend = this.get(x.layer);
  const attachment = new RenderLayerBackendAttachment(view);
  layer.attachments.set(view, attachment);
  layer.attach(attachment);
});

registerRPC(RENDERED_VIEW_REMOVE_LAYER_RPC_ID, function(x) {
  const view: RenderedViewBackend = this.get(x.view);
  const layer: RenderLayerBackend = this.get(x.layer);
  const attachment = layer.attachments.get(view)!;
  layer.attachments.delete(view);
  attachment.dispose();
});

@registerSharedObject(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParametersBackend<T extends ProjectionParameters =
                                                             ProjectionParameters> extends
    SharedObjectCounterpart implements WatchableValueChangeInterface<T> {
  value: T;
  oldValue: T;
  changed = new Signal<(oldValue: T, newValue: T) => void>();
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.value = options.value;
    this.oldValue = Object.assign({}, this.value);
  }
}

registerRPC(PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, function(x) {
  const obj: SharedProjectionParametersBackend = this.get(x.id);
  const {value, oldValue} = obj;
  Object.assign(oldValue, value);
  Object.assign(value, x.value);
  obj.changed.dispatch(oldValue, value);
});
