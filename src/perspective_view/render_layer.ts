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

import { VisibleLayerInfo } from "#/layer";
import { PerspectivePanel } from "#/perspective_view/panel";
import {
  ThreeDimensionalReadyRenderContext,
  ThreeDimensionalRenderContext,
  VisibilityTrackedRenderLayer,
} from "#/renderlayer";
import { vec3 } from "#/util/geom";
import { ShaderModule } from "#/webgl/shader";
import { SharedObject } from "#/worker_rpc";

export type PerspectiveViewReadyRenderContext =
  ThreeDimensionalReadyRenderContext;

export interface PerspectiveViewRenderContext
  extends PerspectiveViewReadyRenderContext,
    ThreeDimensionalRenderContext {
  lightDirection: vec3;
  ambientLighting: number;
  directionalLighting: number;
  emitter: ShaderModule;

  /**
   * Specifies whether the emitted color value will be used.
   */
  emitColor: boolean;

  /**
   * Specifies whether the emitted pick ID will be used.
   */
  emitPickID: boolean;

  /**
   * Specifies whether there was a previous pick ID pass.
   */
  alreadyEmittedPickID: boolean;

  /**
   * Specifies the ID of the depth frame buffer texture to query during rendering.
   */
  depthBufferTexture?: WebGLTexture | null;
  bindMaxProjectionBuffer?: () => void;
}

export class PerspectiveViewRenderLayer<
  AttachmentState = unknown,
> extends VisibilityTrackedRenderLayer {
  draw(
    renderContext: PerspectiveViewRenderContext,
    attachment: VisibleLayerInfo<PerspectivePanel, AttachmentState>,
  ): void {
    renderContext;
    attachment;
    // Must be overridden by subclasses.
  }

  isReady(
    renderContext: PerspectiveViewReadyRenderContext,
    attachment: VisibleLayerInfo<PerspectivePanel, AttachmentState>,
  ) {
    renderContext;
    attachment;
    return true;
  }

  get transparentPickEnabled() {
    return true;
  }
}

export interface PerspectiveViewRenderLayer<AttachmentState = unknown> {
  isTransparent: boolean | undefined;
  isAnnotation: boolean | undefined;
  backend: SharedObject | undefined;
}
