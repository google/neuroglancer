/**
 * @license
 * Copyright 2026 Google Inc.
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
 * @file Raycast (raycast) sphere drawn on a camera-facing quad; see
 * `raycast_primitive.ts` for the shared conventions.
 */

import { defineRaycastPrimitiveCommon } from "#src/webgl/raycast_primitive.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";

/**
 * Adds `emitRaycastSphere(center, radius)` (vertex) and
 * `intersectRaycastSphere()` (fragment); `center`/`radius` are in model space.
 */
export function defineRaycastSphereShader(builder: ShaderBuilder) {
  defineRaycastPrimitiveCommon(builder);
  builder.addVarying("highp vec3", "vSphereCenter", "flat");
  builder.addVarying("highp float", "vSphereRadius", "flat");
  builder.addVertexCode(`
void emitRaycastSphere(highp vec3 center, highp float radius) {
  vSphereCenter = center;
  vSphereRadius = radius;
  RaycastBounds bounds = beginRaycastBounds();
  for (int corner = 0; corner < 8; ++corner) {
    highp float signX = (corner & 1) == 0 ? -1.0 : 1.0;
    highp float signY = (corner & 2) == 0 ? -1.0 : 1.0;
    highp float signZ = (corner & 4) == 0 ? -1.0 : 1.0;
    accumulateRaycastCorner(bounds, center + radius * vec3(signX, signY, signZ));
  }
  gl_Position = getRaycastQuadPosition(bounds);
}
`);
  builder.addFragmentCode(`
RaycastHit intersectRaycastSphere() {
  RaycastHit result;
  result.hit = false;
  RaycastRay ray = getRaycastEyeRay();
  highp vec3 originToCenter = ray.origin - vSphereCenter;
  highp float projectedDistance = dot(originToCenter, ray.direction);
  highp float centerDistanceSq =
      dot(originToCenter, originToCenter) - vSphereRadius * vSphereRadius;
  highp float discriminant = projectedDistance * projectedDistance - centerDistanceSq;
  // Positive-form guards so a NaN ray (degenerate projection) is treated as a
  // miss rather than slipping through (NaN < 0.0 is false).
  if (!(discriminant >= 0.0)) return result;
  highp float sqrtDiscriminant = sqrt(discriminant);
  highp float hitDistance = -projectedDistance - sqrtDiscriminant;
  if (hitDistance < 0.0) hitDistance = -projectedDistance + sqrtDiscriminant;
  if (!(hitDistance >= 0.0)) return result;
  highp vec3 surfacePoint = ray.origin + hitDistance * ray.direction;
  result.hit = true;
  result.surfacePoint = surfacePoint;
  result.windowDepth = getRaycastWindowDepth(surfacePoint);
  result.lightingFactor =
      getRaycastSurfaceLighting((surfacePoint - vSphereCenter) / vSphereRadius);
  return result;
}
`);
}
