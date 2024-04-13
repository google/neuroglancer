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

import { ChunkRenderLayerBackend } from "#src/chunk_manager/backend.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import {
  PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID,
  PROJECTION_PARAMETERS_RPC_ID,
  RENDERED_VIEW_ADD_LAYER_RPC_ID,
  RENDERED_VIEW_REMOVE_LAYER_RPC_ID,
} from "#src/render_layer_common.js";
import type {
  WatchableValueChangeInterface,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { Signal } from "#src/util/signal.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

export interface RenderedViewBackend {
  visibility: WatchableValueInterface<number>;
  projectionParameters: WatchableValueInterface<ProjectionParameters>;
}

export class RenderLayerBackendAttachment<
  ViewBackend extends RenderedViewBackend = RenderedViewBackend,
  AttachmentState = unknown,
> extends RefCounted {
  state: AttachmentState | undefined = undefined;
  constructor(public view: ViewBackend) {
    super();
  }
}

export class RenderLayerBackend<
  ViewBackend extends RenderedViewBackend = RenderedViewBackend,
  AttachmentState = unknown,
> extends ChunkRenderLayerBackend {
  attachments = new Map<ViewBackend, RenderLayerBackendAttachment>();
  attach(
    attachment: RenderLayerBackendAttachment<ViewBackend, AttachmentState>,
  ) {
    attachment;
  }
}

registerRPC(RENDERED_VIEW_ADD_LAYER_RPC_ID, function (x) {
  const view: RenderedViewBackend = this.get(x.view);
  const layer: RenderLayerBackend = this.get(x.layer);
  const attachment = new RenderLayerBackendAttachment(view);
  layer.attachments.set(view, attachment);
  layer.attach(attachment);
});

registerRPC(RENDERED_VIEW_REMOVE_LAYER_RPC_ID, function (x) {
  const view: RenderedViewBackend = this.get(x.view);
  const layer: RenderLayerBackend = this.get(x.layer);
  const attachment = layer.attachments.get(view)!;
  layer.attachments.delete(view);
  attachment.dispose();
});

@registerSharedObject(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParametersBackend<
    T extends ProjectionParameters = ProjectionParameters,
  >
  extends SharedObjectCounterpart
  implements WatchableValueChangeInterface<T>
{
  value: T;
  oldValue: T;
  changed = new Signal<(oldValue: T, newValue: T) => void>();
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.value = options.value;
    this.oldValue = Object.assign({}, this.value);
  }
}

registerRPC(PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, function (x) {
  const obj: SharedProjectionParametersBackend = this.get(x.id);
  const { value, oldValue } = obj;
  Object.assign(oldValue, value);
  Object.assign(value, x.value);
  obj.changed.dispatch(oldValue, value);
});
