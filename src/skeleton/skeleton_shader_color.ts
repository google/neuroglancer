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
 * @file GLSL for the skeleton color paths, shared by the billboard and raycast
 * primitives so the color logic is defined once.
 */

// `dynamic`: per-segment appearance resolved in the shader (spatial skeletons).
// `legacy`: one skeleton drawn per call with a CPU-supplied `uColor`.
export type SkeletonColorPath = "dynamic" | "legacy";

// Per-primitive substitutions for the edge color paths.  Filling in the
// billboard values reproduces the original line GLSL exactly.
export interface EdgeShadingGlsl {
  // Multiplied into the coverage alpha: ` * getLineAlpha() * ...` (billboard) or
  // `` (raycast, whose silhouette is already exact).
  coverageAlpha: string;
  // Multiplied into the emitted rgb: `` (billboard) or ` * raycastLightingFactor`.
  shadeColor: string;
  // Extra premultiply for the legacy `emitDefault` rgb: `` (billboard emits
  // un-premultiplied) or ` * uColor.a` (raycast).
  legacyDefaultPremultiply: string;
}

// GLSL run at the top of the fragment shader before the user's main: intersect
// the raycast surface, discard on a miss, publish the surface depth (for
// gl_FragDepth and the OIT emit depth) and the lighting factor, and cull against
// the chunk bounds using the true surface point.  The primitive defines
// `intersectFunction`.
export function raycastFragmentSetup(
  intersectFunction: string,
  spatialChunkCulling: boolean,
): string {
  return (
    `
RaycastHit raycastHit = ${intersectFunction}();
if (!raycastHit.hit) discard;
// Discard hits outside the frustum depth range (positive-form test, so it also
// rejects any residual NaN) before they can influence the OIT weight.
if (!(raycastHit.windowDepth >= 0.0 && raycastHit.windowDepth <= 1.0)) discard;
gl_FragDepth = raycastHit.windowDepth;
emitDepthOverride = raycastHit.windowDepth;
raycastLightingFactor = raycastHit.lightingFactor;
` + (spatialChunkCulling ? `spatialChunkCull(raycastHit.surfacePoint);\n` : "")
  );
}

export function edgeColorPathsGlsl(
  path: SkeletonColorPath,
  shading: EdgeShadingGlsl,
): string {
  const { coverageAlpha, shadeColor, legacyDefaultPremultiply } = shading;
  if (path === "dynamic") {
    return `
vec4 segmentColor() {
  return getSegmentAppearance(vSegmentValue);
}
void emitRGB(vec3 color) {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a${coverageAlpha};
  if (alpha <= 0.0) discard;
  emit(vec4(color${shadeColor} * alpha, alpha), vPickID);
}
void emitDefault() {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a${coverageAlpha};
  if (alpha <= 0.0) discard;
  emit(vec4(baseColor.rgb${shadeColor} * alpha, alpha), vPickID);
}
`;
  }
  return `
vec4 segmentColor() {
  return uColor;
}
void emitRGB(vec3 color) {
  emit(vec4(color${shadeColor} * uColor.a, uColor.a${coverageAlpha}), vPickID);
}
void emitDefault() {
  emit(vec4(uColor.rgb${shadeColor}${legacyDefaultPremultiply}, uColor.a${coverageAlpha}), vPickID);
}
`;
}

export function nodeColorPathsGlsl(
  path: SkeletonColorPath,
  legacyPremultiply: boolean,
): string {
  if (path === "dynamic") {
    return `
vec4 segmentColor() {
  return getSegmentAppearance(vSegmentValue);
}
void emitRGBA(vec4 color) {
  vec4 baseColor = segmentColor();
  highp float alpha = color.a * baseColor.a;
  if (alpha <= 0.0) discard;
  vec4 finished = finishNodeColor(vec4(color.rgb, alpha));
  emit(vec4(finished.rgb * finished.a, finished.a), vPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(vec4(segmentColor().rgb, 1.0));
}
`;
  }
  const legacyEmit = legacyPremultiply
    ? "emit(vec4(finished.rgb * finished.a, finished.a), vPickID);"
    : "emit(finished, vPickID);";
  return `
vec4 segmentColor() {
  return uColor;
}
void emitRGBA(vec4 color) {
  vec4 finished = finishNodeColor(color);
  ${legacyEmit}
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(uColor);
}
`;
}
