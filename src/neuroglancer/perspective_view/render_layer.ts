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

import {VisibilityTrackedRenderLayer} from '../layer';
import {PickIDManager} from '../object_picking';
import {mat4, vec3} from '../util/geom';
import {ShaderModule} from '../webgl/shader';

export interface PerspectiveViewRenderContext {
  dataToDevice: mat4;
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

  /**
   * Width of GL viewport in pixels.
   */
  viewportWidth: number;

  /**
   * Height of GL viewport in pixels.
   */
  viewportHeight: number;
}

export class PerspectiveViewRenderLayer extends VisibilityTrackedRenderLayer {
  draw(_renderContext: PerspectiveViewRenderContext) {
    // Must be overridden by subclasses.
  }

  /**
   * Should be rendered as transparent.
   */
  get isTransparent() {
    return false;
  }
}
