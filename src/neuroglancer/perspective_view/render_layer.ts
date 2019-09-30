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

import {VisibilityTrackedRenderLayer} from 'neuroglancer/layer';
import {PickIDManager} from 'neuroglancer/object_picking';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {ShaderModule} from 'neuroglancer/webgl/shader';
import {SharedObject} from 'neuroglancer/worker_rpc';

export interface PerspectiveViewReadyRenderContext {
  dataToDevice: mat4;

  /**
   * Width of GL viewport in pixels.
   */
  viewportWidth: number;

  /**
   * Height of GL viewport in pixels.
   */
  viewportHeight: number;
}

export interface PerspectiveViewRenderContext extends PerspectiveViewReadyRenderContext {
  lightDirection: vec3;
  ambientLighting: number;
  directionalLighting: number;
  pickIDs: PickIDManager;
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
}

export class PerspectiveViewRenderLayer extends VisibilityTrackedRenderLayer {
  draw(_renderContext: PerspectiveViewRenderContext) {
    // Must be overridden by subclasses.
  }

  isReady(_renderContext: PerspectiveViewReadyRenderContext) {
    return true;
  }

  isTransparent: boolean|undefined;
  isAnnotation: boolean|undefined;
  backend: SharedObject|undefined;
}
