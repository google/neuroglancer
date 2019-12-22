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

import {DisplayDimensionRenderInfo} from 'neuroglancer/navigation_state';
import {arraysEqual} from 'neuroglancer/util/array';
import {mat4} from 'neuroglancer/util/geom';
import {kEmptyFloat32Vec} from 'neuroglancer/util/vector';

export class ProjectionParameters {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;

  /**
   * Global position.
   */
  globalPosition: Float32Array = kEmptyFloat32Vec;

  /**
   * Width of the viewport in pixels, or 0 if there is no viewport yet.
   */
  width: number = 0;

  /**
   * Height of the viewport in pixels, or 0 if there is no viewport yet.
   */
  height: number = 0;

  /**
   * Transform from camera coordinates to OpenGL clip coordinates.
   */
  projectionMat: mat4 = mat4.create();

  /**
   * Transform from world coordinates to camera coordinates.
   */
  viewMatrix: mat4 = mat4.create();

  /**
   * Inverse of `viewMat`.
   */
  invViewMatrix: mat4 = mat4.create();

  /**
   * Transform from world coordinates to OpenGL clip coordinates.  Equal to:
   * `projectionMat * viewMat`.
   */
  viewProjectionMat: mat4 = mat4.create();

  /**
   * Inverse of `viewProjectionMat`.
   */
  invViewProjectionMat: mat4 = mat4.create();
}

export function projectionParametersEqual(a: ProjectionParameters, b: ProjectionParameters) {
  return (
      a.displayDimensionRenderInfo === b.displayDimensionRenderInfo && a.width === b.width &&
      a.height === b.height && arraysEqual(a.globalPosition, b.globalPosition) &&
      arraysEqual(a.projectionMat, b.projectionMat) && arraysEqual(a.viewMatrix, b.viewMatrix));
}

export function updateProjectionParametersFromInverseViewAndProjection(p: ProjectionParameters) {
  const {viewMatrix, viewProjectionMat} = p;
  mat4.invert(viewMatrix, p.invViewMatrix);
  mat4.multiply(viewProjectionMat, p.projectionMat, viewMatrix);
  mat4.invert(p.invViewProjectionMat, viewProjectionMat);
}
