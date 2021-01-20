/**
 * @license
 * Copyright 2016 Google Inc.
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
export const glsl_COLORMAPS = (`vec3 colormapJet(float x) {
  vec3 result;
  result.r = x < 0.89 ? ((x - 0.35) / 0.31) : (1.0 - (x - 0.89) / 0.11 * 0.5);
  result.g = x < 0.64 ? ((x - 0.125) * 4.0) : (1.0 - (x - 0.64) / 0.27);
  result.b = x < 0.34 ? (0.5 + x * 0.5 / 0.11) : (1.0 - (x - 0.34) / 0.31);
  return clamp(result, 0.0, 1.0);
}
` +
/*
 * Adapted from http://www.mrao.cam.ac.uk/~dag/CUBEHELIX/CubeHelix.m
 * which is licensed under http://unlicense.org/
 */
`vec3 colormapCubehelix(float x) {
  float xclamp = clamp(x, 0.0, 1.0);
  float angle = 2.0 * 3.1415926 * (4.0 / 3.0 + xclamp);
  float amp = xclamp * (1.0 - xclamp) / 2.0;
  vec3 result;
  float cosangle = cos(angle);
  float sinangle = sin(angle);
  result.r = -0.14861 * cosangle + 1.78277 * sinangle;
  result.g = -0.29227 * cosangle + -0.90649 * sinangle;
  result.b = 1.97294 * cosangle;
  result = clamp(xclamp + amp * result, 0.0, 1.0);
  return result;
}
`);
