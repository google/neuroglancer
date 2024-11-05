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

import type { VisibleLayerInfo } from "#src/layer/index.js";
import type { PerspectivePanel } from "#src/perspective_view/panel.js";
import type {
  ThreeDimensionalReadyRenderContext,
  ThreeDimensionalRenderContext,
} from "#src/renderlayer.js";
import { VisibilityTrackedRenderLayer } from "#src/renderlayer.js";
import type { vec3 } from "#src/util/geom.js";
import type { ShaderBuilder, ShaderModule } from "#src/webgl/shader.js";
import type { SharedObject } from "#src/worker_rpc.js";

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

  /**
   * Specifies if there are any slice views
   */
  sliceViewsPresent: boolean;

  /**
   * Specifies if the camera is moving
   */
  isContinuousCameraMotionInProgress: boolean;

  /**
   * Usually, the histogram in 3D is disabled during camera movement
   * This flag is used to force 3D histogram rendering during camera movement
   */
  force3DHistogramForAutoRange: boolean;

  /**
   * Specifices how to bind the max projection buffer
   */
  bindMaxProjectionBuffer?: () => void | undefined;

  /**
   * Specifies how to bind the volume rendering buffer
   */
  bindVolumeRenderingBuffer?: () => void | undefined;

  /**
   * Specifies how to assign the max projection emitter
   */
  maxProjectionEmit?: (builder: ShaderBuilder) => void | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface PerspectiveViewRenderLayer<AttachmentState = unknown> {
  isTransparent: boolean | undefined;
  isAnnotation: boolean | undefined;
  backend: SharedObject | undefined;
  isVolumeRendering: boolean | undefined;
}
