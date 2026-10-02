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

// `dynamic`: per-segment appearance resolved in the shader (spatial skeletons).
// `legacy`: one skeleton drawn per call with a CPU-supplied `uColor`.
export type SkeletonColorPath = "dynamic" | "legacy";

export function edgeColorPathsGlsl(path: SkeletonColorPath): string {
  if (path === "dynamic") {
    return `
vec4 segmentColor() {
  return getSegmentAppearance(vSegmentValue);
}
void emitRGB(vec3 color) {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a * getLineAlpha() * getCrossSectionFade();
  if (alpha <= 0.0) discard;
  emit(vec4(color * alpha, alpha), vPickID);
}
void emitDefault() {
  vec4 baseColor = segmentColor();
  highp float alpha = baseColor.a * getLineAlpha() * getCrossSectionFade();
  if (alpha <= 0.0) discard;
  emit(vec4(baseColor.rgb * alpha, alpha), vPickID);
}
`;
  }
  return `
vec4 segmentColor() {
  return uColor;
}
void emitRGB(vec3 color) {
  emit(vec4(color * uColor.a, uColor.a * getLineAlpha() * getCrossSectionFade()), vPickID);
}
void emitDefault() {
  emit(vec4(uColor.rgb, uColor.a * getLineAlpha() * getCrossSectionFade()), vPickID);
}
`;
}

export function nodeColorPathsGlsl(path: SkeletonColorPath): string {
  if (path === "dynamic") {
    return `
vec4 segmentColor() {
  return getSegmentAppearance(vSegmentValue);
}
void emitRGBA(vec4 color) {
  vec4 baseColor = segmentColor();
  highp float alpha = color.a * baseColor.a;
  if (alpha <= 0.0) discard;
  vec4 nodeColor = vec4(color.rgb, alpha);
  vec4 finished = getCircleColor(nodeColor, nodeColor);
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
  return `
vec4 segmentColor() {
  return uColor;
}
void emitRGBA(vec4 color) {
  emit(getCircleColor(color, color), vPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(uColor);
}
`;
}
