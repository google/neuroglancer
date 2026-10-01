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
 * @file Shared GLSL for raycast primitives. Each is a camera-facing screen space
 * quad whose fragment shader casts a ray to find the 3D surface, then emits a depth
 * and a lighting factor.
 *
 * Positions, radii and normals are in whatever space `uProjection` maps to clip
 * space. That space must reach clip space through a rotation, a uniform scale and
 * the projection alone. Any anisotropic scale left in `uProjection` draws a sphere
 * as an ellipsoid, because the intersection solves a true sphere. `uLightDirection`
 * is read in the same space, so the surface normal needs no further transform.
 * `skeleton/frontend.ts` passes global coordinates scaled to canonical voxels.
 *
 * That space must also be centred near the camera. The fragment shader
 * reconstructs its ray origin there through `uInvProjection`, then subtracts a
 * primitive's own position from it, so both carry whatever the space's origin is.
 * A radius of a few units against coordinates of 1e4 leaves float32 nothing to
 * work with, and the surface normal is destroyed rather than merely noisy. Since
 * `mat4` is a Float32Array, the projection cannot help beyond roughly 1e4 either.
 *
 * The file holds three things: the setup a primitive needs whatever its shape, the
 * general algebra it solves with, and bounding boxes. One bounding box lives here
 * so far, the axial OBB for an object with one long axis. An AABB would fit the
 * same way, but nothing needs one. A primitive whose silhouette has a closed form
 * should bound itself in its own file, which is both tighter and less code. See
 * `raycast_sphere.ts`.
 */

import { mat4 } from "#src/util/geom.js";
import { glsl_getQuadVertexPosition } from "#src/webgl/quad.js";
import {
  glsl_solveQuadratic,
  glsl_splitAlongDir,
} from "#src/webgl/raycast_shader_lib.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { glsl_clipLineToDepthRange } from "#src/webgl/shader_lib.js";

export function projectionMatrixShaderModule(builder: ShaderBuilder) {
  builder.addUniform("highp mat4", "uProjection");
}

// The ray direction comes from the near plane and the middle of the depth range,
// not from the far plane. Once far over near is large enough, the projection's z
// coefficient rounds to exactly -1 in float32 and the far plane stops being
// reachable through uInvProjection, which leaves the direction a zero vector and
// discards every fragment. At a near of 0.1 that happens by a far of 4e6. The
// middle of the range stays a fixed distance behind the near plane whatever the
// far plane does.
//
// The fragment side of the contract. A primitive supplies
// `intersectRaycastPrimitive`, and gets the ray, the depth conversion and the
// lighting from here. `raycastSurfaceDepth` and `raycastLightingFactor` are file
// scope globals rather than locals of main, so that a consumer's own emit helper
// can read them.
const glsl_raycastPrimitiveFragmentUtil = `
struct RaycastRay {
  highp vec3 origin;
  highp vec3 direction;
};
struct RaycastHit {
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
RaycastHit raycastMiss() {
  RaycastHit hit;
  hit.hit = false;
  return hit;
}
RaycastHit makeRaycastHit(highp vec3 surfacePoint, highp vec3 normal) {
  RaycastHit hit;
  hit.hit = true;
  hit.windowDepth = getRaycastWindowDepth(surfacePoint);
  hit.lightingFactor = getRaycastSurfaceLightingFactor(normal);
  return hit;
}
`;

// Distance to the near and the far clip plane, both linear in position. A caller
// passes the maximum over its own shape: the value at the centre plus how far the
// shape reaches along each distance's own gradient.
//
// Negative form on the test, so a non-finite value fails open and leaves the shape
// drawn. An emitter over-covers for the same reason, so that a primitive straddling
// the near plane is never lost.
const glsl_raycastDepthRangeCull = `
highp vec2 raycastDepthPlaneDistances(highp vec4 clip) {
  return vec2(clip.z + clip.w, clip.w - clip.z);
}
bool raycastOutsideDepthRange(highp vec2 maxDepthDistances) {
  return maxDepthDistances.x < 0.0 || maxDepthDistances.y < 0.0;
}
`;

// RAYCAST_OFFSCREEN_NDC must exceed 1.0. Pinned exactly at the viewport edge, the
// margin an emitter adds would drag a fully off-screen primitive back on screen as
// a sliver.
//
// RAYCAST_MIN_RELATIVE_W is the smallest clip w a projected point may be treated as
// having, as a fraction of the local w scale. Relative, so it holds whatever units
// the projection works in.
//
// RAYCAST_MIN_AXIS_W_MARGIN is the nearest clip w an axis may keep, as a multiple of
// the depth its radial half-extents span. The margin over 1.0 is what a corner keeps
// in front of the eye, and so what caps how far outside the viewport it can project.
const glsl_raycastQuadConstants = `
const highp float RAYCAST_OFFSCREEN_NDC = 2.0;
const highp float RAYCAST_MIN_RELATIVE_W = 1e-4;
const highp float RAYCAST_MIN_AXIS_W_MARGIN = 1.25;
`;

// A screen space quad oriented along the projected axis, covering the box about the
// segment endpointA..endpointB with radial half-extents radiusVectorA and B.
//
// Depth-clipping the segment first is what makes an oriented quad possible. A
// primitive crossing the eye plane has an unbounded footprint, and clipping leaves
// every corner in front of the eye, where the hull of the projected corners is a
// valid bound. The radial half-extents reach nearer than the axis does, so the near
// end is trimmed again by their own depth. The part dropped there wraps the eye, and
// no quad of bounded size covers it.
//
// `clipLineToDepthRange` rewrites clipA and clipB in place. Everything after it uses
// the clipped segment. Its result is tested in positive form, so a non-finite value
// culls rather than proceeding, and the equal depth case trims nothing, which leaves
// the corner test to reject it.
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

  if (raycastOutsideDepthRange(
          max(raycastDepthPlaneDistances(clipA), raycastDepthPlaneDistances(clipB))
          + abs(raycastDepthPlaneDistances(clipVectorA))
          + abs(raycastDepthPlaneDistances(clipVectorB)))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  bool clipped = clipLineToDepthRange(clipA, clipB);

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

  if (!(clipped && startT < endT && min(axisA.w, axisB.w) >= radialW)) {
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

// The radius that projects to `radiusInPixels` device pixels, measured on the
// vertical viewport extent. A primitive sized this way holds a constant on-screen
// size as the camera moves.
// A point at or behind the eye has no on-screen size to match, and gets zero.
//
// Column 1 of uInvProjection is one NDC unit of y, so its length converts between
// the two. The space reaches the eye through a rotation and a uniform scale, so that
// length does not turn with the camera.
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

// Runs a primitive's own `intersectRaycastPrimitive` and publishes the result. A
// consumer places this at the top of its fragment main, so that a miss discards
// before any of its own code runs.
//
// The depth range test is in positive form, so a non-finite depth fails closed
// rather than poisoning the order-independent transparency weight.
export const glsl_raycastFragmentSetup = `
RaycastHit raycastHit = intersectRaycastPrimitive();
if (!raycastHit.hit) discard;
if (!(raycastHit.windowDepth >= 0.0 && raycastHit.windowDepth <= 1.0)) discard;
gl_FragDepth = raycastHit.windowDepth;
raycastSurfaceDepth = raycastHit.windowDepth;
raycastLightingFactor = raycastHit.lightingFactor;
`;

// A ShaderModule, so requiring it twice adds its code once.
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
  builder.addVertexCode(glsl_clipLineToDepthRange);
  builder.addVertexCode(glsl_raycastAxialObbQuad);
}

const tempInvProjection = mat4.create();

// `primitiveToClip` maps the space a primitive's positions are given in to clip
// space. See the constraint on that space at the top of this file.
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
