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

import type { ShaderBuilder } from "#src/webgl/shader.js";

const glsl_gtao = `
// Number of view-space slices in which to sample horizon angles. Eight
// directions reduce angular noise and camera-motion pattern changes compared
// with the previous four-direction kernel.
#define NUM_DIRECTIONS 8
// Number of steps along each direction at which to sample the horizon from the
// depth buffer.
#define NUM_STEPS 8
#define PI 3.14159265
#define HALF_PI 1.57079633
// Cap the per-pixel kernel at this fraction of viewport height; avoids
// runaway sampling at extreme zoom-in. Sized for scenes of thin arbors.
#define MAX_KERNEL_FRACTION 0.6
// Squared length below which a packed normal is treated as the no-AO
// sentinel (zero-RGB plus rounding tolerance). Real packed unit normals
// have squared length >= 1 - sqrt(3) / 2 (~0.134), so 0.01 is safely below.
#define SENTINEL_EPS 0.01
// Decorrelate the per-step noise from the per-direction noise by perturbing
// the hash input.
#define STEP_NOISE_SCALE 0.7
#define STEP_NOISE_BIAS 0.3

vec3 viewPosFromDepth(vec2 uv, float fragZ, mat4 invProj) {
  vec4 clip = vec4(uv * 2.0 - 1.0, fragZ * 2.0 - 1.0, 1.0);
  vec4 view = invProj * clip;
  return view.xyz / view.w;
}

float gtaoHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float integrateArc(float horizonAngle, float normalAngle) {
  return -cos(2.0 * horizonAngle - normalAngle) + cos(normalAngle) +
         2.0 * horizonAngle * sin(normalAngle);
}

vec4 gtao() {
  vec2 uv = vTexCoord;
  float depthVal = getValue0().r;
  if (depthVal == 0.0) {
    return vec4(1.0);
  }

  float fragZ = 1.0 - depthVal;
  vec3 P = viewPosFromDepth(uv, fragZ, uInvProjection);

  // Zero RGB is the no-AO sentinel: cleared background pixels and
  // highlighted objects (see emit shader) both land here.
  vec3 rawN = getValue1().rgb;
  if (dot(rawN, rawN) < SENTINEL_EPS) {
    return vec4(1.0);
  }
  vec3 N = normalize(rawN * 2.0 - 1.0);

  // Here, uRadius acts as a fraction of viewport height, clamped at a
  // reasonable maximum, to drive the marching distance.
  float kernelRadius = uRadius;
  kernelRadius = min(kernelRadius, MAX_KERNEL_FRACTION);
  // Here, uRadius scales the view-space distance for per-sample falloff.
  float wClip = uProjection[2][3] * P.z + uProjection[3][3];
  float falloffRadius = uRadius * 2.0 * wClip / uProjection[1][1];

  // Sub-pixel kernel: nothing meaningful to sample.
  if (kernelRadius < 1.0 / uResolution.y) {
    return vec4(1.0);
  }

  float noiseAngle = gtaoHash(gl_FragCoord.xy) * PI;
  float stepNoise = gtaoHash(gl_FragCoord.xy * STEP_NOISE_SCALE + STEP_NOISE_BIAS);

  float totalVisibility = 0.0;
  vec3 viewDirection = abs(uProjection[2][3]) > 0.5
    ? normalize(-P)
    : vec3(0.0, 0.0, 1.0);
  float minSampleDist = max(falloffRadius * 0.0001, 0.000001);

  for (int d = 0; d < NUM_DIRECTIONS; d++) {
    float phi = (float(d) + 0.5) / float(NUM_DIRECTIONS) * PI + noiseAngle;
    // Correct for non-square viewports so azimuthal samples are uniform in
    // world space rather than UV space.
    vec2 dir2D = vec2(cos(phi), sin(phi)) * vec2(uResolution.y / uResolution.x, 1.0);
    vec2 stepUV = dir2D * kernelRadius / float(NUM_STEPS);

    // Construct the view-space slice corresponding to this screen-space
    // direction, then project the surface normal into it.
    vec3 tangentPoint = viewPosFromDepth(
      uv + dir2D / uResolution.y, fragZ, uInvProjection);
    vec3 sliceTangent = normalize(tangentPoint - P);
    vec3 sliceNormal = normalize(cross(viewDirection, sliceTangent));
    vec3 projectedNormal = N - sliceNormal * dot(N, sliceNormal);
    float projectedNormalLength = length(projectedNormal);
    if (projectedNormalLength < 0.0001) {
      continue;
    }
    projectedNormal /= projectedNormalLength;
    float normalAngle = atan(
      dot(projectedNormal, sliceTangent),
      dot(projectedNormal, viewDirection));

    // The projected normal's +/- pi/2 boundaries represent an unobstructed
    // hemisphere. Samples move each horizon inward as they occlude the slice.
    float horizonPosLimit = normalAngle + HALF_PI;
    float horizonNegLimit = normalAngle - HALF_PI;
    float horizonPos = horizonPosLimit;
    float horizonNeg = horizonNegLimit;

    for (int s = 1; s <= NUM_STEPS; s++) {
      float t = float(s) + stepNoise * 0.5;

      vec2 uvP = uv + stepUV * t;
      if (uvP.x > 0.0 && uvP.x < 1.0 && uvP.y > 0.0 && uvP.y < 1.0) {
        float dv = texture(uSampler[0], uvP).r;
        if (dv > 0.0) {
          vec3 S = viewPosFromDepth(uvP, 1.0 - dv, uInvProjection);
          vec3 delta = S - P;
          float dist = length(delta);
          if (dist > minSampleDist) {
            float falloff = clamp(1.0 - dist * dist / (falloffRadius * falloffRadius), 0.0, 1.0);
            float sampleAngle = acos(clamp(dot(delta / dist, viewDirection), -1.0, 1.0));
            horizonPos = min(horizonPos, mix(horizonPosLimit, sampleAngle, falloff));
          }
        }
      }

      vec2 uvN = uv - stepUV * t;
      if (uvN.x > 0.0 && uvN.x < 1.0 && uvN.y > 0.0 && uvN.y < 1.0) {
        float dv = texture(uSampler[0], uvN).r;
        if (dv > 0.0) {
          vec3 S = viewPosFromDepth(uvN, 1.0 - dv, uInvProjection);
          vec3 delta = S - P;
          float dist = length(delta);
          if (dist > minSampleDist) {
            float falloff = clamp(1.0 - dist * dist / (falloffRadius * falloffRadius), 0.0, 1.0);
            float sampleAngle = -acos(clamp(dot(delta / dist, viewDirection), -1.0, 1.0));
            horizonNeg = max(horizonNeg, mix(horizonNegLimit, sampleAngle, falloff));
          }
        }
      }
    }

    horizonPos = clamp(horizonPos, horizonNegLimit, horizonPosLimit);
    horizonNeg = clamp(horizonNeg, horizonNegLimit, horizonPosLimit);
    totalVisibility += projectedNormalLength * 0.25 *
      (integrateArc(horizonPos, normalAngle) +
       integrateArc(-horizonNeg, -normalAngle));
  }

  float ao = totalVisibility / float(NUM_DIRECTIONS);
  ao = clamp(ao, 0.0, 1.0);
  return vec4(vec3(ao), 1.0);
}
`;

export function defineGTAOShader(builder: ShaderBuilder) {
  builder.addUniform("highp mat4", "uProjection");
  builder.addUniform("highp mat4", "uInvProjection");
  builder.addUniform("highp float", "uRadius");
  builder.addUniform("highp vec2", "uResolution");
  builder.addOutputBuffer("vec4", "v4f_fragColor", null);
  builder.addFragmentCode(glsl_gtao);
  builder.setFragmentMain(`v4f_fragColor = gtao();`);
}

const glsl_blur = `
#define DEPTH_SIGMA_FRACTION 0.1

float viewZFromDepth(vec2 uv, float depthVal) {
  vec4 clip = vec4(uv * 2.0 - 1.0, (1.0 - depthVal) * 2.0 - 1.0, 1.0);
  vec4 view = uInvProjection * clip;
  return view.z / view.w;
}

vec4 blur() {
  vec2 texelSize = 1.0 / vec2(textureSize(uSampler[0], 0));
  float centerDepth = getValue1().r;
  if (centerDepth == 0.0) {
    return vec4(1.0);
  }
  float centerZ = viewZFromDepth(vTexCoord, centerDepth);
  float wClip = uProjection[2][3] * centerZ + uProjection[3][3];
  float falloffRadius = uRadius * 2.0 * wClip / uProjection[1][1];
  float depthSigma = max(falloffRadius * DEPTH_SIGMA_FRACTION, 0.000001);

  float result = 0.0;
  float totalWeight = 0.0;

  for (int i = -2; i <= 2; i++) {
    vec2 offset = vec2(float(i)) * texelSize * uDirection;
    vec2 uv = vTexCoord + offset;
    float sampleDepth = texture(uSampler[1], uv).r;
    if (sampleDepth == 0.0) {
      continue;
    }
    float sampleZ = viewZFromDepth(uv, sampleDepth);
    float w = exp(-abs(sampleZ - centerZ) / depthSigma);
    result += texture(uSampler[0], uv).r * w;
    totalWeight += w;
  }

  return vec4(vec3(result / totalWeight), 1.0);
}
`;

export function defineBlurShader(builder: ShaderBuilder) {
  builder.addUniform("highp vec2", "uDirection");
  builder.addUniform("highp mat4", "uProjection");
  builder.addUniform("highp mat4", "uInvProjection");
  builder.addUniform("highp float", "uRadius");
  builder.addOutputBuffer("vec4", "v4f_fragColor", null);
  builder.addFragmentCode(glsl_blur);
  builder.setFragmentMain(`v4f_fragColor = blur();`);
}

const glsl_ssaoComposite = `
// Squared length below which a packed normal is treated as the no-AO
// sentinel (zero-RGB plus rounding tolerance). Real packed unit normals
// have squared length >= 1 - sqrt(3) / 2 (~0.134), so 0.01 is safely below.
#define SENTINEL_EPS 0.01

// Set to 1 to visualize the (post-intensity) AO buffer directly instead of
// the color * AO composite. Useful for fine-tuning radius, intensity or
// blur falloff without the effect of mesh color or lighting.
#define DEBUG_SSAO 0

vec4 composite() {
  vec4 color = getValue0();
  float ao = getValue1().r;
  // Zero-RGB normal is the no-AO sentinel: cleared background, opaque
  // annotations/skeletons (which write vec4(0)), and highlighted mesh
  // segments. Skip the AO multiply so they render at the SSAO-off
  // appearance.
  vec3 normal = getValue2().rgb;
  ao = dot(normal, normal) < SENTINEL_EPS ? 1.0 : pow(ao, uIntensity);
  #if DEBUG_SSAO
  return vec4(vec3(ao), 1.0);
  #else
  return vec4(color.rgb * ao, color.a);
  #endif
}
`;

export function defineSSAOCompositeShader(builder: ShaderBuilder) {
  builder.addUniform("highp float", "uIntensity");
  builder.addOutputBuffer("vec4", "v4f_fragColor", null);
  builder.addFragmentCode(glsl_ssaoComposite);
  builder.setFragmentMain(`v4f_fragColor = composite();`);
}
