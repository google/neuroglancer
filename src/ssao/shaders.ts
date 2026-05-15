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
// Number of directions in which to sample horizon angles.
#define NUM_DIRECTIONS 4
// Number of steps along each direction at which to sample the horizon from the
// depth buffer.
#define NUM_STEPS 8
#define PI 3.14159265
// Cap the per-pixel kernel at this fraction of viewport height; avoids
// runaway sampling at extreme zoom-in.
#define MAX_KERNEL_FRACTION 0.4
// Minimum view-space distance to count a horizon sample; avoids division by zero
// at coincident samples.
#define MIN_SAMPLE_DIST 0.0001
// Squared length below which a packed normal is treated as the no-AO
// sentinel (zero-RGB plus rounding tolerance). Real packed unit normals
// have squared length >= 1/3, so 0.01 is safely below.
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
`;

export function defineGTAOShader(builder: ShaderBuilder) {
  builder.addUniform("highp mat4", "uProjection");
  builder.addUniform("highp mat4", "uInvProjection");
  builder.addUniform("highp float", "uRadius");
  builder.addUniform("highp vec2", "uResolution");
  builder.addOutputBuffer("vec4", "v4f_fragColor", null);
  builder.addFragmentCode(glsl_gtao);
  builder.setFragmentMain(`
  vec2 uv = vTexCoord;
  float depthVal = getValue0().r;
  if (depthVal == 0.0) {
    v4f_fragColor = vec4(1.0);
    return;
  }

  float fragZ = 1.0 - depthVal;
  vec3 P = viewPosFromDepth(uv, fragZ, uInvProjection);

  // Zero RGB is the no-AO sentinel: cleared background pixels and
  // highlighted objects (see emit shader) both land here.
  vec3 rawN = getValue1().rgb;
  if (dot(rawN, rawN) < SENTINEL_EPS) {
    v4f_fragColor = vec4(1.0);
    return;
  }
  vec3 N = normalize(rawN * 2.0 - 1.0);

  // World→UV scale: wClip is -P.z under perspective and 1 under ortho.
  float wClip = uProjection[2][3] * P.z + uProjection[3][3];
  float screenRadius = uRadius * uProjection[1][1] / (2.0 * wClip);
  screenRadius = min(screenRadius, MAX_KERNEL_FRACTION);
  // Sub-pixel kernel: nothing meaningful to sample.
  if (screenRadius < 1.0 / uResolution.y) {
    v4f_fragColor = vec4(1.0);
    return;
  }

  float noiseAngle = gtaoHash(gl_FragCoord.xy) * PI;
  float stepNoise = gtaoHash(gl_FragCoord.xy * STEP_NOISE_SCALE + STEP_NOISE_BIAS);

  float totalOcclusion = 0.0;

  for (int d = 0; d < NUM_DIRECTIONS; d++) {
    float phi = (float(d) + 0.5) / float(NUM_DIRECTIONS) * PI + noiseAngle;
    // Correct for non-square viewports so azimuthal samples are uniform in
    // world space rather than UV space.
    vec2 dir2D = vec2(cos(phi), sin(phi)) * vec2(uResolution.y / uResolution.x, 1.0);
    vec2 stepUV = dir2D * screenRadius / float(NUM_STEPS);

    float maxSinH_pos = 0.0;
    float maxSinH_neg = 0.0;

    for (int s = 1; s <= NUM_STEPS; s++) {
      float t = float(s) + stepNoise * 0.5;

      vec2 uvP = uv + stepUV * t;
      if (uvP.x > 0.0 && uvP.x < 1.0 && uvP.y > 0.0 && uvP.y < 1.0) {
        float dv = texture(uSampler[0], uvP).r;
        if (dv > 0.0) {
          vec3 S = viewPosFromDepth(uvP, 1.0 - dv, uInvProjection);
          vec3 delta = S - P;
          float dist = length(delta);
          if (dist > MIN_SAMPLE_DIST) {
            float sinH = dot(delta / dist, N);
            float falloff = clamp(1.0 - dist * dist / (uRadius * uRadius), 0.0, 1.0);
            maxSinH_pos = max(maxSinH_pos, sinH * falloff);
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
          if (dist > MIN_SAMPLE_DIST) {
            float sinH = dot(delta / dist, N);
            float falloff = clamp(1.0 - dist * dist / (uRadius * uRadius), 0.0, 1.0);
            maxSinH_neg = max(maxSinH_neg, sinH * falloff);
          }
        }
      }
    }

    totalOcclusion += (maxSinH_pos + maxSinH_neg) * 0.5;
  }

  float ao = 1.0 - totalOcclusion / float(NUM_DIRECTIONS);
  ao = clamp(ao, 0.0, 1.0);
  v4f_fragColor = vec4(vec3(ao), 1.0);
`);
}

const glsl_blur = `
// Bilateral falloff sharpness; tuned for normalized [0,1] depth so that
// samples across surface boundaries get rejected.
#define DEPTH_AWARE_FALLOFF 1000.0
`;

export function defineBlurShader(builder: ShaderBuilder) {
  builder.addUniform("highp vec2", "uDirection");
  builder.addOutputBuffer("vec4", "v4f_fragColor", null);
  builder.addFragmentCode(glsl_blur);
  builder.setFragmentMain(`
  vec2 texelSize = 1.0 / vec2(textureSize(uSampler[0], 0));
  float centerDepth = getValue1().r;

  float result = 0.0;
  float totalWeight = 0.0;

  for (int i = -2; i <= 2; i++) {
    vec2 offset = vec2(float(i)) * texelSize * uDirection;
    vec2 uv = vTexCoord + offset;
    float sampleDepth = texture(uSampler[1], uv).r;
    float depthDiff = abs(sampleDepth - centerDepth);
    float w = exp(-depthDiff * DEPTH_AWARE_FALLOFF);
    result += texture(uSampler[0], uv).r * w;
    totalWeight += w;
  }

  v4f_fragColor = vec4(vec3(result / totalWeight), 1.0);
`);
}

const glsl_ssaoComposite = `
// Squared length below which a packed normal is treated as the no-AO
// sentinel (zero-RGB plus rounding tolerance). Real packed unit normals
// have squared length >= 1/3, so 0.01 is safely below.
#define SENTINEL_EPS 0.01
`;

export function defineSSAOCompositeShader(builder: ShaderBuilder) {
  builder.addUniform("highp float", "uIntensity");
  builder.addOutputBuffer("vec4", "v4f_fragColor", null);
  builder.addFragmentCode(glsl_ssaoComposite);
  builder.setFragmentMain(`
  vec4 color = getValue0();
  float ao = getValue1().r;
  // Zero-RGB normal is the no-AO sentinel: cleared background, opaque
  // annotations/skeletons (which write vec4(0)), and highlighted mesh
  // segments. Skip the AO multiply so they render at the SSAO-off
  // appearance.
  vec3 normal = getValue2().rgb;
  ao = dot(normal, normal) < SENTINEL_EPS ? 1.0 : pow(ao, uIntensity);
  v4f_fragColor = vec4(color.rgb * ao, color.a);
`);
}
