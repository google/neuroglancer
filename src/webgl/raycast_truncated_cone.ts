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
 * @file Raycast truncated cone with open ends, drawn on a camera-facing quad.
 * Symbols say cone for short.
 *
 * The radius changes linearly between the ends, because a constant on-screen
 * width needs a larger radius at the far end of a receding cone.
 *
 * Each end also takes a clip radius, within which the surface is not drawn.
 */

import { defineRaycastAxialObbQuad } from "#src/webgl/raycast_primitive.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";

// The radius vectors are scaled last, because GLSL ES leaves normalising a zero
// vector undefined.
//
// The second cross product is unit length, because its inputs are perpendicular
// unit vectors.
const glsl_emitRaycastCone = `
void emitRaycastCone(highp vec3 endpointA, highp vec3 endpointB,
                     highp float radiusA, highp float radiusB,
                     highp float clipRadiusA, highp float clipRadiusB) {
  highp float widestRadius = max(radiusA, radiusB);
  // A segment wholly behind the eye gets zero radii.
  // Positive form, so a non-finite radius culls too.
  if (!(widestRadius > 0.0)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vConeEndpointA = endpointA;
  vConeEndRadii = vec4(radiusA, radiusB, clipRadiusA, clipRadiusB);
  highp vec3 axisVector = endpointB - endpointA;
  highp float axisLength = length(axisVector);
  highp vec3 axisDir =
      axisLength > 1e-6 ? axisVector / axisLength : vec3(0.0, 1.0, 0.0);
  vConeAxis = vec4(axisDir, axisLength);

  highp vec3 offAxisVector =
      abs(axisDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  highp vec3 unitRadiusA = normalize(cross(offAxisVector, axisDir));
  highp vec3 unitRadiusB = cross(axisDir, unitRadiusA);
  emitRaycastAxialObbQuad(endpointA, endpointB,
                          unitRadiusA * widestRadius,
                          unitRadiusB * widestRadius);
}
`;

// A surface point is radiusAtHit from the axis, so its distance to an endpoint
// follows from axialDist alone.
const glsl_coneEndClipped = `
bool coneEndClipped(highp float axialDist, highp float radiusAtHit) {
  highp float axialDistFromB = axialDist - vConeAxis.w;
  highp float radiusSq = radiusAtHit * radiusAtHit;
  return axialDist * axialDist + radiusSq
             < vConeEndRadii.z * vConeEndRadii.z ||
         axialDistFromB * axialDistFromB + radiusSq
             < vConeEndRadii.w * vConeEndRadii.w;
}
`;

// quadraticA is negative for a ray inside the taper angle, and zero along it.
// Such a ray can still meet the finite cone through an open end.
//
// Measured from the ray's closest approach to the axis, the constant term is a
// difference of two small numbers.
//
// Through an open end, the near hit can lie past that end while the far hit is
// on the surface.
//
// With the ray origin within the axial interval, a near hit behind it is a miss,
// so that the far root cannot fill the view from inside.
//
// The axial interval test keeps the radius between the end radii, so no surface
// past the apex draws.
//
// The normal is the gradient of the surface equation, with an axial term from the
// taper.
const glsl_intersectRaycastCone = `
highp float raycastConeAxialFraction = 0.0;

RaycastResult intersectRaycastPrimitive() {
  RaycastRay ray = getRaycastRayThroughFragment();
  highp vec3 axisDir = vConeAxis.xyz;
  highp float axisLength = vConeAxis.w;
  highp float radiusA = vConeEndRadii.x;
  highp float inverseAxisLength = axisLength > 0.0 ? 1.0 / axisLength : 0.0;
  highp float taperRate = (vConeEndRadii.y - radiusA) * inverseAxisLength;

  VectorSplit originSplit = splitAlongDir(ray.origin - vConeEndpointA, axisDir);
  VectorSplit dirSplit = splitAlongDir(ray.direction, axisDir);
  highp float perpSpeedSq = dot(dirSplit.perp, dirSplit.perp);
  highp float radiusRate = taperRate * dirSplit.parallelDist;
  highp float radiusAtOrigin = radiusA + taperRate * originSplit.parallelDist;

  highp float quadraticA = perpSpeedSq - radiusRate * radiusRate;
  highp float nearHitDist;
  highp float farHitDist;
  if (quadraticA > 0.0) {
    highp float closestDist =
        -dot(originSplit.perp, dirSplit.perp) / perpSpeedSq;
    highp vec3 perpAtClosest =
        originSplit.perp + closestDist * dirSplit.perp;
    highp float radiusAtClosest = radiusA + taperRate *
        (originSplit.parallelDist + closestDist * dirSplit.parallelDist);
    QuadraticRoots roots = solveQuadratic(
        quadraticA,
        -radiusAtClosest * radiusRate,
        dot(perpAtClosest, perpAtClosest) -
            radiusAtClosest * radiusAtClosest);
    if (!roots.exist) return raycastMiss();
    nearHitDist = closestDist + roots.nearRoot;
    farHitDist = closestDist + roots.farRoot;
  } else {
    highp float quadraticB =
        dot(originSplit.perp, dirSplit.perp) - radiusAtOrigin * radiusRate;
    highp float quadraticC =
        dot(originSplit.perp, originSplit.perp) -
        radiusAtOrigin * radiusAtOrigin;
    if (quadraticA < 0.0) {
      QuadraticRoots roots =
          solveQuadratic(-quadraticA, -quadraticB, -quadraticC);
      if (!roots.exist) return raycastMiss();
      nearHitDist = roots.nearRoot;
      farHitDist = roots.farRoot;
    } else {
      highp float linearCoefficient = 2.0 * quadraticB;
      if (linearCoefficient == 0.0) return raycastMiss();
      nearHitDist = farHitDist = -quadraticC / linearCoefficient;
    }
  }

  highp float hitDist = nearHitDist;
  bool rayOriginInsideCone =
      originSplit.parallelDist >= 0.0 &&
      originSplit.parallelDist <= axisLength &&
      dot(originSplit.perp, originSplit.perp) <
          radiusAtOrigin * radiusAtOrigin;
  if (!(hitDist >= 0.0) && rayOriginInsideCone) return raycastMiss();

  highp float axialDist =
      originSplit.parallelDist + hitDist * dirSplit.parallelDist;
  highp float radiusAtHit = radiusA + taperRate * axialDist;
  if (!(hitDist >= 0.0 && axialDist >= 0.0 && axialDist <= axisLength) ||
      coneEndClipped(axialDist, radiusAtHit)) {
    hitDist = farHitDist;
    axialDist = originSplit.parallelDist + hitDist * dirSplit.parallelDist;
    radiusAtHit = radiusA + taperRate * axialDist;
    if (!(hitDist >= 0.0 && axialDist >= 0.0 && axialDist <= axisLength) ||
        coneEndClipped(axialDist, radiusAtHit)) return raycastMiss();
  }
  raycastConeAxialFraction = axialDist * inverseAxisLength;

  highp vec3 perpAtHit = originSplit.perp + hitDist * dirSplit.perp;
  return raycastHit(
      ray.origin + hitDist * ray.direction,
      perpAtHit - radiusAtHit * taperRate * axisDir);
}
`;

export function defineRaycastConeShader(builder: ShaderBuilder) {
  defineRaycastAxialObbQuad(builder);
  builder.addVarying("highp vec3", "vConeEndpointA", "flat");
  // xyz: unit axis direction, w: axis length.
  builder.addVarying("highp vec4", "vConeAxis", "flat");
  // xy: surface radius at endpoint A and at endpoint B.
  // zw: clip radius at endpoint A and at endpoint B.
  builder.addVarying("highp vec4", "vConeEndRadii", "flat");
  builder.addVertexCode(glsl_emitRaycastCone);
  builder.addFragmentCode(glsl_coneEndClipped);
  builder.addFragmentCode(glsl_intersectRaycastCone);
}
