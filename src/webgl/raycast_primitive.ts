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
 * @file Shared GLSL for raycast (raycast) primitives: a camera-facing quad (2
 * triangles) whose fragment shader ray-intersects the true 3D surface, writes
 * `gl_FragDepth`, and shades a normal.  Intersection is done in model space, so
 * the (possibly anisotropic/sheared) `uProjection` deforms the model-space
 * sphere/cylinder into the correct display-space shape, as in
 * `src/annotation/ellipsoid.ts`.
 *
 * The consumer must declare these uniforms (see `frontend.ts`
 * `defineCommonShader`):
 *   uniform highp mat4 uProjection;       // model -> clip
 *   uniform highp mat4 uInvProjection;    // clip -> model
 *   uniform highp mat4 uNormalTransform;  // model-normal -> display, = (M^-1)^T
 *   uniform highp vec4 uLightDirection;   // xyz = dir*intensity, w = ambient
 *   uniform highp vec2 uViewportSize;     // device pixels
 */

import { glsl_getQuadVertexPosition } from "#src/webgl/quad.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";

// Fragment helpers: eye-ray reconstruction, model->window depth, and the Lambert
// lighting factor.  `RaycastHit` is returned by each intersection routine.
export const glsl_raycastPrimitiveFragmentUtil = `
struct RaycastRay {
  highp vec3 origin;
  highp vec3 direction;
};
struct RaycastHit {
  bool hit;
  highp vec3 surfacePoint;
  highp float windowDepth;
  highp float lightingFactor;
};
RaycastRay getRaycastEyeRay() {
  highp vec2 normalizedDeviceCoord = (gl_FragCoord.xy / uViewportSize) * 2.0 - 1.0;
  highp vec4 nearClip = uInvProjection * vec4(normalizedDeviceCoord, -1.0, 1.0);
  highp vec4 farClip = uInvProjection * vec4(normalizedDeviceCoord, 1.0, 1.0);
  highp vec3 nearModel = nearClip.xyz / nearClip.w;
  highp vec3 farModel = farClip.xyz / farClip.w;
  RaycastRay ray;
  ray.origin = nearModel;
  ray.direction = normalize(farModel - nearModel);
  return ray;
}
highp float getRaycastWindowDepth(highp vec3 modelPoint) {
  // Assumes the default depth range [0, 1] and NDC z in [-1, 1].
  highp vec4 clip = uProjection * vec4(modelPoint, 1.0);
  return 0.5 * (clip.z / clip.w) + 0.5;
}
highp float getRaycastSurfaceLighting(highp vec3 modelNormal) {
  highp vec3 displayNormal = normalize((uNormalTransform * vec4(modelNormal, 0.0)).xyz);
  return abs(dot(displayNormal, uLightDirection.xyz)) + uLightDirection.w;
}
`;

// Accumulates the projected NDC bounding box of the primitive's model-space AABB
// corners, then emits the current quad corner covering it.  A corner on/behind
// the near plane must not be dropped (that would under-cover a primitive
// straddling the near plane, leaving it undrawn); instead its w is clamped
// positive so it projects off-screen and expands the bounds, and the fragment
// ray test trims the excess.  NDC is bounded so the expansion stays finite.
export const glsl_raycastPrimitiveVertexUtil = `
const highp float RAYCAST_NDC_BOUND = 2.0;
struct RaycastBounds {
  highp vec2 ndcMin;
  highp vec2 ndcMax;
  highp float ndcNearZ;
  bool anyCornerValid;
};
RaycastBounds beginRaycastBounds() {
  RaycastBounds bounds;
  bounds.ndcMin = vec2(0.0);
  bounds.ndcMax = vec2(0.0);
  bounds.ndcNearZ = 0.0;
  bounds.anyCornerValid = false;
  return bounds;
}
void accumulateRaycastCorner(inout RaycastBounds bounds, highp vec3 modelCorner) {
  highp vec4 clip = uProjection * vec4(modelCorner, 1.0);
  highp float clipW = max(clip.w, 1e-4);
  highp vec2 ndcXY =
      clamp(clip.xy / clipW, vec2(-RAYCAST_NDC_BOUND), vec2(RAYCAST_NDC_BOUND));
  highp float ndcZ = clip.z / clipW;
  if (!bounds.anyCornerValid) {
    bounds.ndcMin = ndcXY;
    bounds.ndcMax = ndcXY;
    bounds.ndcNearZ = ndcZ;
    bounds.anyCornerValid = true;
  } else {
    bounds.ndcMin = min(bounds.ndcMin, ndcXY);
    bounds.ndcMax = max(bounds.ndcMax, ndcXY);
    bounds.ndcNearZ = min(bounds.ndcNearZ, ndcZ);
  }
}
vec4 getRaycastQuadPosition(RaycastBounds bounds) {
  if (!bounds.anyCornerValid) {
    // Cull: position outside the clip volume.
    return vec4(2.0, 2.0, 2.0, 1.0);
  }
  // Expand slightly so the analytic silhouette is never clipped by the quad.
  highp vec2 margin = (bounds.ndcMax - bounds.ndcMin) * 0.02 + 2.0 / uViewportSize;
  highp vec2 lowerCorner = bounds.ndcMin - margin;
  highp vec2 upperCorner = bounds.ndcMax + margin;
  highp vec2 quadCorner = getQuadVertexPosition(lowerCorner, upperCorner);
  return vec4(quadCorner, clamp(bounds.ndcNearZ, -1.0, 1.0), 1.0);
}
`;

// Model-space radius that projects to `radiusInPixels` device px at `modelPoint`
// (using the vertical viewport extent), giving raycasts a constant on-screen
// size like the billboards.
export const glsl_raycastPrimitivePixelRadius = `
highp float getRaycastModelRadiusForPixels(highp vec3 modelPoint, highp float radiusInPixels) {
  highp vec4 clip = uProjection * vec4(modelPoint, 1.0);
  highp float clipW = max(clip.w, 1e-6);
  highp float ndcPerPixel = 2.0 / uViewportSize.y;
  highp vec4 clipDelta = vec4(0.0, ndcPerPixel * clipW * radiusInPixels, 0.0, 0.0);
  highp vec3 modelDelta = (uInvProjection * clipDelta).xyz;
  return length(modelDelta);
}
`;

// Convenience: pull in the fragment- and vertex-stage raycast helpers.  The
// consumer must separately declare the uniforms documented in the file header.
export function defineRaycastPrimitiveCommon(builder: ShaderBuilder) {
  builder.addVertexCode(glsl_getQuadVertexPosition);
  builder.addVertexCode(glsl_raycastPrimitiveVertexUtil);
  builder.addVertexCode(glsl_raycastPrimitivePixelRadius);
  builder.addFragmentCode(glsl_raycastPrimitiveFragmentUtil);
}
