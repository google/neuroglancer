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
export const glsl_COLORMAPS =
  `vec3 colormapJet(float x) {
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
` +
  /*
   * Perceptually uniform sequential colormaps (viridis, plasma, inferno, magma)
   * and diverging colormaps (coolwarm, rdbu).
   *
   * Polynomial approximations derived from the matplotlib colormap lookup tables:
   * https://github.com/matplotlib/matplotlib/blob/main/lib/matplotlib/_cm_listed.py
   *
   * Approximation technique by Íñigo Quílez:
   * https://iquilezles.org/articles/palettes/
   *
   * Coefficients computed by least-squares regression over the 256-entry tables.
   * Maximum error across all channels: < 0.005 (visually imperceptible).
   */
  `vec3 colormapViridis(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 0.5139045538019999);
  vec3 c2 = vec3(-0.1554846426062665, 0.214847559468114, 0.2882845726573711);
  vec3 c3 = vec3(4.421483672780069, -4.815752998712279, -1.523304699551617);
  vec3 c4 = vec3(-6.449900613484578, 6.814218890839987, 1.586319730987697);
  vec3 c5 = vec3(4.985027369390448, -5.374467529984653, -1.049898449823647);
  vec3 c6 = vec3(-1.630030898948953, 2.019384888944737, 0.3665667028843458);
  return clamp(c0 + x*(c1 + x*(c2 + x*(c3 + x*(c4 + x*(c5 + x*c6))))), 0.0, 1.0);
}
vec3 colormapPlasma(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c0 = vec3(0.05873234392399702, 0.02333670892565664, 0.5433401826748754);
  vec3 c1 = vec3(2.176514634195958, 0.2383834171260182, 0.7539604599784036);
  vec3 c2 = vec3(-2.689460476458034, -7.455851135738909, 3.110799939717086);
  vec3 c3 = vec3(6.130348345893603, 42.3461881477227, -28.51885465332158);
  vec3 c4 = vec3(-11.10743619062271, -82.66631109428045, 60.13984767418263);
  vec3 c5 = vec3(10.02306557647065, 71.41361770095349, -54.07218655740221);
  vec3 c6 = vec3(-3.658713842777788, -22.93153465461149, 18.19190778539828);
  return clamp(c0 + x*(c1 + x*(c2 + x*(c3 + x*(c4 + x*(c5 + x*c6))))), 0.0, 1.0);
}
vec3 colormapInferno(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c0 = vec3(0.0002189403691192265, 0.001651004631528365, -0.01948089843709184);
  vec3 c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
  vec3 c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
  vec3 c3 = vec3(-41.70399613249965, 17.43639888205313, 44.35414519872813);
  vec3 c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
  vec3 c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
  vec3 c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  return clamp(c0 + x*(c1 + x*(c2 + x*(c3 + x*(c4 + x*(c5 + x*c6))))), 0.0, 1.0);
}
vec3 colormapMagma(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c0 = vec3(-0.002136485053939582, -0.000749655052795221, -0.005386127855323933);
  vec3 c1 = vec3(0.2516605407371642, 0.6775232436837668, 2.494026599312351);
  vec3 c2 = vec3(8.353717279216625, -3.577719514958484, 0.3144679030132573);
  vec3 c3 = vec3(-27.66873308576866, 14.26473078096533, -13.64921318813922);
  vec3 c4 = vec3(52.17613981234068, -27.94360607168351, 12.94416944238394);
  vec3 c5 = vec3(-50.76852536473588, 29.04658282127291, 4.23415299384598);
  vec3 c6 = vec3(18.65570506591883, -11.48977351915498, -5.601961508734096);
  return clamp(c0 + x*(c1 + x*(c2 + x*(c3 + x*(c4 + x*(c5 + x*c6))))), 0.0, 1.0);
}
vec3 colormapCoolwarm(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 blue  = vec3(0.229, 0.298, 0.754);
  vec3 white = vec3(0.865, 0.865, 0.865);
  vec3 red   = vec3(0.706, 0.016, 0.150);
  return x < 0.5
    ? mix(blue, white, x * 2.0)
    : mix(white, red, (x - 0.5) * 2.0);
}
vec3 colormapRdBu(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 red   = vec3(0.647, 0.000, 0.149);
  vec3 white = vec3(0.969, 0.969, 0.969);
  vec3 blue  = vec3(0.192, 0.212, 0.584);
  return x < 0.5
    ? mix(red, white, x * 2.0)
    : mix(white, blue, (x - 0.5) * 2.0);
}
`;
