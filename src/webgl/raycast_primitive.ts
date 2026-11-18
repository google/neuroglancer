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
 * @file GLSL for raycast primitives. A primitive draws a camera-facing quad, and
 * its fragment shader casts a ray to find the depth and lighting of the surface.
 *
 * Positions, radii, normals and `uLightDirection` are in the space that
 * `uProjection` maps to clip space.
 *
 * That space must reach clip space through a rotation, a uniform scale and the
 * projection only, because an anisotropic scale draws a sphere as an ellipsoid.
 *
 * That space must also be centred near the camera, because float32 cannot resolve
 * a radius of a few units against coordinates of 1e4. `mat4` is float32 too, so
 * the projection cannot absorb that offset.
 */

import { mat4 } from "#src/util/geom.js";
import { glsl_getQuadVertexPosition } from "#src/webgl/quad.js";
import {
  glsl_solveQuadratic,
  glsl_splitAlongDir,
} from "#src/webgl/raycast_shader_lib.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

export function projectionMatrixShaderModule(builder: ShaderBuilder) {
  builder.addUniform("highp mat4", "uProjection");
}

// A primitive defines `intersectRaycastPrimitive`, and this supplies its ray,
// depth and lighting.
// `raycastSurfaceDepth` and `raycastLightingFactor` are globals, so that a
// function outside main can read them.
// A `RaycastResult` has a depth and a lighting factor only when `hit` is true.
// The ray aims at mid-depth, because float32 rounds the far plane out of reach of
// `uInvProjection` at a large far-to-near ratio.
const glsl_raycastPrimitiveFragmentUtil = `
struct RaycastRay {
  highp vec3 origin;
  highp vec3 direction;
};
struct RaycastResult {
  bool hit;
  highp float windowDepth;
  highp float lightingFactor;
};

highp float raycastSurfaceDepth = 0.0;
highp float raycastLightingFactor = 1.0;

RaycastRay getRaycastRayThroughFragment() {
  highp vec2 ndc = (gl_FragCoord.xy / uViewportSize) * 2.0 - 1.0;
  highp vec4 nearClip = uInvProjection * vec4(ndc, -1.0, 1.0);
  highp vec4 midClip = uInvProjection * vec4(ndc, 0.0, 1.0);
  RaycastRay ray;
  ray.origin = nearClip.xyz / nearClip.w;
  ray.direction = normalize(midClip.xyz / midClip.w - ray.origin);
  return ray;
}
highp float getRaycastWindowDepth(highp vec3 point) {
  highp vec4 clip = uProjection * vec4(point, 1.0);
  return 0.5 * (clip.z / clip.w) + 0.5;
}
highp float getRaycastSurfaceLightingFactor(highp vec3 normal) {
  return abs(dot(normalize(normal), uLightDirection.xyz)) + uLightDirection.w;
}
RaycastResult raycastMiss() {
  RaycastResult result;
  result.hit = false;
  return result;
}
RaycastResult raycastHit(highp vec3 surfacePoint, highp vec3 normal) {
  RaycastResult result;
  result.hit = true;
  result.windowDepth = getRaycastWindowDepth(surfacePoint);
  result.lightingFactor = getRaycastSurfaceLightingFactor(normal);
  return result;
}
`;

// Both distances are linear in position, so a shape's bound is the value at its
// centre plus its reach along each gradient.
// Negative form, so a non-finite value leaves a shape drawn rather than lose one
// across the near plane.
const glsl_raycastDepthRangeCull = `
highp vec2 raycastDepthPlaneDistances(highp vec4 clip) {
  return vec2(clip.z + clip.w, clip.w - clip.z);
}
bool raycastOutsideDepthRange(highp vec2 maxDepthDistances) {
  return maxDepthDistances.x < 0.0 || maxDepthDistances.y < 0.0;
}
`;

// RAYCAST_OFFSCREEN_NDC is above 1.0, so that the margin an emitter adds cannot
// pull a fully off-screen primitive back on screen as a sliver.
//
// RAYCAST_MIN_RELATIVE_W is a fraction of the local w scale, so it suits any
// units.
//
// RAYCAST_MIN_AXIS_W_MARGIN is the smallest axis clip w, as a multiple of the w
// that the radial half-extents span.
// Above 1.0, it keeps each corner in front of the eye and bounds how far off
// screen that corner projects.
const glsl_raycastQuadConstants = `
const highp float RAYCAST_OFFSCREEN_NDC = 2.0;
const highp float RAYCAST_MIN_RELATIVE_W = 1e-4;
const highp float RAYCAST_MIN_AXIS_W_MARGIN = 1.25;
`;

// A screen space quad along the projected axis, around the box with radial
// half-extents radiusVectorA and radiusVectorB.
// Clip the axis against depth planes expanded by the box's radial reach. An
// axis point outside the original planes can still have visible surface.
// Then trim by the radial w extent to keep every projected corner in front of
// the eye.
// The trimmed part surrounds the eye, where no bounded quad could cover it.
// With equal w at both ends nothing is trimmed, and the corner test rejects a
// segment that is too near.
const glsl_raycastAxialObbQuad = `
highp vec2 raycastClipToPixels(highp vec4 clip) {
  return clip.xy / clip.w * uViewportSize * 0.5;
}
void emitRaycastAxialObbQuad(highp vec3 endpointA, highp vec3 endpointB,
                             highp vec3 radiusVectorA, highp vec3 radiusVectorB) {
  highp vec4 clipA = uProjection * vec4(endpointA, 1.0);
  highp vec4 clipB = uProjection * vec4(endpointB, 1.0);
  highp vec4 clipVectorA = uProjection * vec4(radiusVectorA, 0.0);
  highp vec4 clipVectorB = uProjection * vec4(radiusVectorB, 0.0);
  highp vec2 quadCoefficient = getQuadVertexPosition(vec2(-1.0), vec2(1.0));

  highp vec2 radialDepth = abs(raycastDepthPlaneDistances(clipVectorA))
                         + abs(raycastDepthPlaneDistances(clipVectorB));
  highp vec2 depthA = raycastDepthPlaneDistances(clipA) + radialDepth;
  highp vec2 depthB = raycastDepthPlaneDistances(clipB) + radialDepth;
  if (raycastOutsideDepthRange(max(depthA, depthB))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  highp float depthStartT = 0.0;
  highp float depthEndT = 1.0;
  for (int plane = 0; plane < 2; ++plane) {
    highp float planeDistA = depthA[plane];
    highp float planeDistB = depthB[plane];
    if (planeDistA < 0.0) {
      depthStartT = max(depthStartT, planeDistA / (planeDistA - planeDistB));
    } else if (planeDistB < 0.0) {
      depthEndT = min(depthEndT, planeDistA / (planeDistA - planeDistB));
    }
  }
  if (depthStartT > 0.0 || depthEndT < 1.0) {
    highp vec4 originalA = clipA;
    clipA = mix(originalA, clipB, depthStartT);
    clipB = mix(originalA, clipB, depthEndT);
  }

  // w runs linearly along the axis, so one crossing bounds the near end.
  highp float radialW = abs(clipVectorA.w) + abs(clipVectorB.w);
  highp float minAxisW = max(radialW * RAYCAST_MIN_AXIS_W_MARGIN,
                             RAYCAST_MIN_RELATIVE_W * max(clipA.w, clipB.w));
  highp float axisDeltaW = clipB.w - clipA.w;
  highp float startT = 0.0;
  highp float endT = 1.0;
  if (axisDeltaW > 0.0) {
    startT = max(startT, (minAxisW - clipA.w) / axisDeltaW);
  } else if (axisDeltaW < 0.0) {
    endT = min(endT, (minAxisW - clipA.w) / axisDeltaW);
  }
  highp vec4 axisA = mix(clipA, clipB, startT);
  highp vec4 axisB = mix(clipA, clipB, endT);

  if (!(depthStartT <= depthEndT && startT < endT && min(axisA.w, axisB.w) >= radialW)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  highp vec2 pixelsA = raycastClipToPixels(axisA);
  highp vec2 pixelsB = raycastClipToPixels(axisB);
  highp vec2 axisPixels = pixelsB - pixelsA;
  highp float axisLengthPixels = length(axisPixels);
  highp vec2 alongDir =
      axisLengthPixels > 1e-3 ? axisPixels / axisLengthPixels : vec2(1.0, 0.0);
  highp vec2 perpDir = vec2(-alongDir.y, alongDir.x);
  highp vec2 pixelCenter = (pixelsA + pixelsB) * 0.5;
  highp float halfAlongPixels = 0.0;
  highp float halfPerpPixels = 0.0;
  highp float ndcNearZ = 1.0;

  for (int corner = 0; corner < 8; ++corner) {
    highp vec4 clip = ((corner & 1) == 0 ? axisA : axisB)
        + ((corner & 2) == 0 ? -clipVectorA : clipVectorA)
        + ((corner & 4) == 0 ? -clipVectorB : clipVectorB);
    highp vec2 offset = raycastClipToPixels(clip) - pixelCenter;
    halfAlongPixels = max(halfAlongPixels, abs(dot(offset, alongDir)));
    halfPerpPixels = max(halfPerpPixels, abs(dot(offset, perpDir)));
    ndcNearZ = min(ndcNearZ, clamp(clip.z / clip.w, -1.0, 1.0));
  }

  // The corner bound is exact. One pixel covers numerical error.
  highp vec2 pixels = pixelCenter
      + alongDir * (quadCoefficient.x * (halfAlongPixels + 1.0))
      + perpDir * (quadCoefficient.y * (halfPerpPixels + 1.0));
  gl_Position = vec4(pixels * 2.0 / uViewportSize, ndcNearZ, 1.0);
}
`;

// `radiusInPixels` is in device pixels along the vertical viewport extent.
// A point at or behind the eye gets zero.
// Column 1 of uInvProjection is one NDC unit of y, and its length does not change
// as the camera turns.
const glsl_raycastPrimitivePixelRadius = `
highp float raycastRadiusFromClipW(highp float clipW, highp float radiusInPixels) {
  if (!(clipW > 0.0)) return 0.0;
  return length(uInvProjection[1].xyz) * (2.0 / uViewportSize.y) * clipW * radiusInPixels;
}
highp float getRaycastRadiusForPixels(highp vec3 point, highp float radiusInPixels) {
  return raycastRadiusFromClipW((uProjection * vec4(point, 1.0)).w, radiusInPixels);
}
highp vec2 getRaycastSegmentRadiiForPixels(
    highp vec3 endpointA, highp vec3 endpointB, highp float radiusInPixels) {
  highp vec2 radii = vec2(
      getRaycastRadiusForPixels(endpointA, radiusInPixels),
      getRaycastRadiusForPixels(endpointB, radiusInPixels));
  if (!(radii.x > 0.0)) radii.x = radii.y;
  if (!(radii.y > 0.0)) radii.y = radii.x;
  return radii;
}
`;

// Goes first in the fragment main, so that a miss discards before any other
// code runs.
// Positive form, so a non-finite depth discards rather than corrupt the
// order-independent transparency weight.
export const glsl_raycastFragmentSetup = `
RaycastResult raycastResult = intersectRaycastPrimitive();
if (!raycastResult.hit) discard;
if (!(raycastResult.windowDepth >= 0.0 && raycastResult.windowDepth <= 1.0)) discard;
gl_FragDepth = raycastResult.windowDepth;
raycastSurfaceDepth = raycastResult.windowDepth;
raycastLightingFactor = raycastResult.lightingFactor;
`;

export function raycastPrimitiveCoreModule(builder: ShaderBuilder) {
  builder.require(projectionMatrixShaderModule);
  builder.addUniform("highp mat4", "uInvProjection");
  builder.addUniform("highp vec4", "uLightDirection");
  builder.addUniform("highp vec2", "uViewportSize");
  builder.addVertexCode(glsl_getQuadVertexPosition);
  builder.addVertexCode(glsl_raycastDepthRangeCull);
  builder.addVertexCode(glsl_raycastQuadConstants);
  builder.addVertexCode(glsl_raycastPrimitivePixelRadius);
  builder.addFragmentCode(glsl_raycastPrimitiveFragmentUtil);
  builder.addFragmentCode(glsl_splitAlongDir);
  builder.addFragmentCode(glsl_solveQuadratic);
}

export function defineRaycastAxialObbQuad(builder: ShaderBuilder) {
  builder.require(raycastPrimitiveCoreModule);
  builder.addVertexCode(glsl_raycastAxialObbQuad);
}

const tempInvProjection = mat4.create();

export function initializeRaycastPrimitiveShader(
  shader: ShaderProgram,
  primitiveToClip: mat4,
  projectionParameters: { width: number; height: number },
) {
  const { gl } = shader;
  gl.uniformMatrix4fv(shader.uniform("uProjection"), false, primitiveToClip);
  mat4.invert(tempInvProjection, primitiveToClip);
  gl.uniformMatrix4fv(
    shader.uniform("uInvProjection"),
    false,
    tempInvProjection,
  );
  gl.uniform2f(
    shader.uniform("uViewportSize"),
    projectionParameters.width,
    projectionParameters.height,
  );
}
