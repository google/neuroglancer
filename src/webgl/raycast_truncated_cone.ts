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
 * @file Raycast truncated cone drawn on a camera-facing quad. Symbols below say
 * cone for brevity. The surface is always the truncated one, and its ends are open.
 *
 * The radius is given at each end and runs linearly between them, and equal radii
 * give an exact cylinder. A cone sized for a constant on-screen width needs the
 * taper, because the far end of a receding cone sits at a larger radius than the
 * near end.
 *
 * Each end also takes a clip radius, which removes the part of the surface that a
 * primitive drawn at that end covers.
 */

import { defineRaycastAxialObbQuad } from "#src/webgl/raycast_primitive.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";

// Scaling the two radius vectors comes last. Scaling before the second cross
// product would normalise the zero vector when a radius is zero, which GLSL ES
// leaves undefined. The second product is already unit length, being the cross of
// two perpendicular unit vectors.
//
// The bound uses the wider of the two radii, which covers the whole surface.
const glsl_emitRaycastCone = `
void emitRaycastCone(highp vec3 endpointA, highp vec3 endpointB,
                     highp float radiusA, highp float radiusB,
                     highp float clipRadiusA, highp float clipRadiusB) {
  highp float widestRadius = max(radiusA, radiusB);
  // A segment with both endpoints behind the eye is given zero radii, so this runs
  // every frame. Positive form, so a non-finite radius culls too.
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

// A surface point sits one local radius from the axis, so its distance to an
// endpoint follows from the axial distance alone.
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

// Across the axis the cone is a circle whose radius grows along the axis, so the
// in-plane test is a quadratic rather than a fixed-radius circle.
//
// quadraticA is negative for a ray inside the taper angle and zero on its
// asymptote. Both can still meet a finite cone, particularly when it widens away
// from a camera looking through an open end.
//
// The quadratic is measured from the ray's closest approach to the axis, so that
// its constant term is a difference of two small numbers. The far root is needed
// when looking through an open end: the near hit on the infinite cone can be past
// that end while the far hit lies on the finite surface. A near hit behind the ray
// origin is rejected only when the origin is within the cone's axial interval;
// there the camera is inside the finite cone and using the far root would fill the
// view from inside.
//
// The interval test also holds the radius between the two end radii, so a surface
// past a cone apex never draws. The normal is the gradient of the surface equation,
// whose axial term is what the taper adds.
const glsl_intersectRaycastCone = `
highp float raycastConeAxialFraction = 0.0;

RaycastHit intersectRaycastPrimitive() {
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
    highp float radiusAtOrigin =
        radiusA + taperRate * originSplit.parallelDist;
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
  bool rayOriginWithinConeAxis =
      originSplit.parallelDist >= 0.0 &&
      originSplit.parallelDist <= axisLength;
  if (!(hitDist >= 0.0) && rayOriginWithinConeAxis) return raycastMiss();

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
  return makeRaycastHit(
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
