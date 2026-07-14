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
 * @file Raycast (raycast) finite cylinder drawn on a camera-facing quad; see
 * `raycast_primitive.ts` for the shared conventions.
 *
 * The ray/cylinder intersection is adapted from Inigo Quilez's capped-cylinder
 * intersector (https://iquilezles.org/articles/intersectors/), MIT licensed:
 *
 *   The MIT License. Copyright (c) 2016 Inigo Quilez.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to
 *   deal in the Software without restriction, including without limitation the
 *   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 *   sell copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: the above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS".
 */

import { defineRaycastPrimitiveCommon } from "#src/webgl/raycast_primitive.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";

export interface RaycastCylinderOptions {
  capped: boolean;
}

/**
 * Adds `emitRaycastCylinder(endpointA, endpointB, radius, clipRadiusA,
 * clipRadiusB)` (vertex) and `intersectRaycastCylinder()` (fragment).  All
 * arguments are in model space.  Surface points within `clipRadiusA/B` of an
 * endpoint are discarded so an abutting sphere covers the joint without
 * overlapping (which would double-blend under order-independent transparency);
 * pass 0 to disable clipping at that end.
 * TODO: support per-endpoint radii for tapered/conical segments.
 */
export function defineRaycastCylinderShader(
  builder: ShaderBuilder,
  options: RaycastCylinderOptions,
) {
  defineRaycastPrimitiveCommon(builder);
  builder.addVarying("highp vec3", "vCylinderEndpointA", "flat");
  builder.addVarying("highp vec3", "vCylinderEndpointB", "flat");
  builder.addVarying("highp float", "vCylinderRadius", "flat");
  builder.addVarying("highp float", "vCylinderClipRadiusA", "flat");
  builder.addVarying("highp float", "vCylinderClipRadiusB", "flat");
  builder.addVertexCode(`
void emitRaycastCylinder(highp vec3 endpointA, highp vec3 endpointB,
                          highp float radius,
                          highp float clipRadiusA, highp float clipRadiusB) {
  vCylinderEndpointA = endpointA;
  vCylinderEndpointB = endpointB;
  vCylinderRadius = radius;
  vCylinderClipRadiusA = clipRadiusA;
  vCylinderClipRadiusB = clipRadiusB;
  highp vec3 axisVector = endpointB - endpointA;
  highp float axisLength = length(axisVector);
  highp vec3 axisDirection = axisLength > 1e-6 ? axisVector / axisLength : vec3(0.0, 1.0, 0.0);
  highp vec3 referenceVector =
      abs(axisDirection.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  highp vec3 radialU = normalize(cross(referenceVector, axisDirection)) * radius;
  highp vec3 radialV = normalize(cross(axisDirection, radialU)) * radius;
  RaycastBounds bounds = beginRaycastBounds();
  for (int corner = 0; corner < 8; ++corner) {
    highp vec3 ringCenter = (corner & 4) == 0 ? endpointA : endpointB;
    highp float signU = (corner & 1) == 0 ? -1.0 : 1.0;
    highp float signV = (corner & 2) == 0 ? -1.0 : 1.0;
    accumulateRaycastCorner(bounds, ringCenter + signU * radialU + signV * radialV);
  }
  gl_Position = getRaycastQuadPosition(bounds);
}
`);
  if (options.capped) {
    builder.addFragmentCode("#define RAYCAST_CYLINDER_CAPPED\n");
  }
  builder.addFragmentCode(`
bool cylinderPointClipped(highp vec3 surfacePoint) {
  return distance(surfacePoint, vCylinderEndpointA) < vCylinderClipRadiusA ||
         distance(surfacePoint, vCylinderEndpointB) < vCylinderClipRadiusB;
}
RaycastHit intersectRaycastCylinder() {
  RaycastHit result;
  result.hit = false;
  RaycastRay ray = getRaycastEyeRay();
  highp vec3 axis = vCylinderEndpointB - vCylinderEndpointA;
  highp vec3 originToBase = ray.origin - vCylinderEndpointA;
  highp float axisLengthSq = dot(axis, axis);
  highp float axisDotDirection = dot(axis, ray.direction);
  highp float axisDotOrigin = dot(axis, originToBase);
  highp float quadA = axisLengthSq - axisDotDirection * axisDotDirection;
  highp float quadB = axisLengthSq * dot(originToBase, ray.direction) - axisDotOrigin * axisDotDirection;
  highp float quadC = axisLengthSq * dot(originToBase, originToBase) -
      axisDotOrigin * axisDotOrigin - vCylinderRadius * vCylinderRadius * axisLengthSq;
  highp float discriminant = quadB * quadB - quadA * quadC;
  // Positive-form guard so a NaN ray (degenerate projection) misses rather than
  // slipping through (NaN < 0.0 is false).
  if (!(discriminant >= 0.0)) return result;
  highp float sqrtDiscriminant = sqrt(discriminant);
  // Lateral surface (near root).
  highp float hitDistance = (-quadB - sqrtDiscriminant) / quadA;
  highp float axialCoord = axisDotOrigin + hitDistance * axisDotDirection;
  if (hitDistance >= 0.0 && axialCoord >= 0.0 && axialCoord <= axisLengthSq) {
    highp vec3 surfacePoint = ray.origin + hitDistance * ray.direction;
    if (!cylinderPointClipped(surfacePoint)) {
      highp vec3 surfaceNormal =
          (originToBase + hitDistance * ray.direction - axis * (axialCoord / axisLengthSq)) /
          vCylinderRadius;
      result.hit = true;
      result.surfacePoint = surfacePoint;
      result.windowDepth = getRaycastWindowDepth(surfacePoint);
      result.lightingFactor = getRaycastSurfaceLighting(normalize(surfaceNormal));
      return result;
    }
  }
#ifdef RAYCAST_CYLINDER_CAPPED
  // End caps at axialCoord == 0 (endpoint A) and axialCoord == axisLengthSq (B).
  highp float capDistance =
      ((axialCoord < 0.0 ? 0.0 : axisLengthSq) - axisDotOrigin) / axisDotDirection;
  if (capDistance >= 0.0 && abs(quadB + quadA * capDistance) < sqrtDiscriminant) {
    highp vec3 surfacePoint = ray.origin + capDistance * ray.direction;
    if (!cylinderPointClipped(surfacePoint)) {
      highp vec3 surfaceNormal = axis * sign(axialCoord) / sqrt(axisLengthSq);
      result.hit = true;
      result.surfacePoint = surfacePoint;
      result.windowDepth = getRaycastWindowDepth(surfacePoint);
      result.lightingFactor = getRaycastSurfaceLighting(normalize(surfaceNormal));
      return result;
    }
  }
#endif
  return result;
}
`);
}
