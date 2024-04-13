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

import { PERSPECTIVE_VIEW_RPC_ID } from "#src/perspective_view/base.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type { RenderedViewBackend } from "#src/render_layer_backend.js";
import { RenderLayerBackend } from "#src/render_layer_backend.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

@registerSharedObject(PERSPECTIVE_VIEW_RPC_ID)
export class PerspectiveViewBackend
  extends SharedObjectCounterpart
  implements RenderedViewBackend
{
  visibility: SharedWatchableValue<number>;
  projectionParameters: SharedWatchableValue<ProjectionParameters>;
  constructor(...args: any[]) {
    super(...args);
    const rpc: RPC = args[0];
    const options: any = args[1];
    this.visibility = rpc.get(options.visibility);
    this.projectionParameters = rpc.get(options.projectionParameters);
  }
}
export class PerspectiveViewRenderLayerBackend<
  AttachmentState = unknown,
> extends RenderLayerBackend<PerspectiveViewBackend, AttachmentState> {}
