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

// Canonical list of colormap names available as #uicontrol colormap options.
export const COLORMAP_NAMES = [
  "grayscale",
  "viridis",
  "plasma",
  "inferno",
  "magma",
  "coolwarm",
  "rdbu",
  "jet",
  "cubehelix",
] as const;

export type ColormapName = (typeof COLORMAP_NAMES)[number];

const COLORMAP_GLSL_NAMES: Record<ColormapName, string> = {
  grayscale: "colormapGrayscale",
  viridis: "colormapViridis",
  plasma: "colormapPlasma",
  inferno: "colormapInferno",
  magma: "colormapMagma",
  coolwarm: "colormapCoolwarm",
  rdbu: "colormapRdBu",
  jet: "colormapJet",
  cubehelix: "colormapCubehelix",
};

const COLORMAP_DISPLAY_NAMES: Record<ColormapName, string> = {
  grayscale: "Grayscale",
  viridis: "Viridis",
  plasma: "Plasma",
  inferno: "Inferno",
  magma: "Magma",
  coolwarm: "Coolwarm",
  rdbu: "RdBu",
  jet: "Jet",
  cubehelix: "Cubehelix",
};

// Maps colormap name to the GLSL function name.
export function colormapGlslFunctionName(name: ColormapName): string {
  return COLORMAP_GLSL_NAMES[name];
}

// Returns the human-readable display name for a colormap.
export function colormapDisplayName(name: ColormapName): string {
  return COLORMAP_DISPLAY_NAMES[name];
}

// JavaScript implementations of each colormap for CPU-side swatch rendering.
// These mirror the GLSL polynomial math exactly so swatches match shader output.
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function evalPoly6(
  x: number,
  c: [number, number, number, number, number, number, number],
): number {
  return clamp01(
    c[0] +
      x * (c[1] + x * (c[2] + x * (c[3] + x * (c[4] + x * (c[5] + x * c[6]))))),
  );
}

const VIRIDIS_R: [number, number, number, number, number, number, number] = [
  0.2744554244543814, 0.10770832620590942, -0.32724109678694613,
  -4.599931518228907, 6.203735901279355, 4.751786888900565, -5.43207717100151,
];
const VIRIDIS_G: [number, number, number, number, number, number, number] = [
  0.005767962396577286, 1.3964696839276685, 0.214813564542913,
  -5.758238189317904, 14.153964947400272, -13.749439404408186,
  4.641571315981625,
];
const VIRIDIS_B: [number, number, number, number, number, number, number] = [
  0.33266388111298156, 1.386770597936565, 0.09197688075380395,
  -19.29180895035448, 56.6562995652498, -65.32096782757077, 26.27210760448218,
];

const PLASMA_R: [number, number, number, number, number, number, number] = [
  0.05873234392399702, 2.176514634195958, -2.689460476458034, 6.130348345893603,
  -11.10743619062271, 10.02306557647065, -3.658713842777788,
];
const PLASMA_G: [number, number, number, number, number, number, number] = [
  0.02333670892565664, 0.2383834171260182, -7.455851135738909, 42.3461881477227,
  -82.66631109428045, 71.41361770095349, -22.93153465461149,
];
const PLASMA_B: [number, number, number, number, number, number, number] = [
  0.5433401826748754, 0.7539604599784036, 3.110799939717086, -28.51885465332158,
  60.13984767418263, -54.07218655740221, 18.19190778539828,
];

const INFERNO_R: [number, number, number, number, number, number, number] = [
  0.0002189403691192265, 0.1065134194856116, 11.60249308247187,
  -41.70399613249965, 77.162935699427, -71.31942824499214, 25.13112622477341,
];
const INFERNO_G: [number, number, number, number, number, number, number] = [
  0.001651004631528365, 0.5639564367884091, -3.972853965665698,
  17.43639888205313, -33.40235894210092, 32.62606426397723, -12.24266895238567,
];
const INFERNO_B: [number, number, number, number, number, number, number] = [
  -0.01948089843709184, 3.932712388889277, -15.9423941062914, 44.35414519872813,
  -81.80730925738993, 73.20951985803202, -23.07032500287172,
];

const MAGMA_R: [number, number, number, number, number, number, number] = [
  -0.002136485053939582, 0.2516605407371642, 8.353717279216625,
  -27.66873308576866, 52.17613981234068, -50.76852536473588, 18.65570506591883,
];
const MAGMA_G: [number, number, number, number, number, number, number] = [
  -0.000749655052795221, 0.6775232436837668, -3.577719514958484,
  14.26473078096533, -27.94360607168351, 29.04658282127291, -11.48977351915498,
];
const MAGMA_B: [number, number, number, number, number, number, number] = [
  -0.005386127855323933, 2.494026599312351, 0.3144679030132573,
  -13.64921318813922, 12.94416944238394, 4.23415299384598, -5.601961508734096,
];

function evalColormapJs(
  x: number,
  rc: [number, number, number, number, number, number, number],
  gc: [number, number, number, number, number, number, number],
  bc: [number, number, number, number, number, number, number],
): [number, number, number] {
  x = clamp01(x);
  return [evalPoly6(x, rc), evalPoly6(x, gc), evalPoly6(x, bc)];
}

function colormapJetJs(x: number): [number, number, number] {
  x = clamp01(x);
  const r = clamp01(
    x < 0.89 ? (x - 0.35) / 0.31 : 1.0 - ((x - 0.89) / 0.11) * 0.5,
  );
  const g = clamp01(x < 0.64 ? (x - 0.125) * 4.0 : 1.0 - (x - 0.64) / 0.27);
  const b = clamp01(
    x < 0.34 ? 0.5 + (x * 0.5) / 0.11 : 1.0 - (x - 0.34) / 0.31,
  );
  return [r, g, b];
}

function colormapCubehelixJs(x: number): [number, number, number] {
  x = clamp01(x);
  const angle = 2.0 * Math.PI * (4.0 / 3.0 + x);
  const amp = (x * (1.0 - x)) / 2.0;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const r = clamp01(x + amp * (-0.14861 * cosA + 1.78277 * sinA));
  const g = clamp01(x + amp * (-0.29227 * cosA - 0.90649 * sinA));
  const b = clamp01(x + amp * (1.97294 * cosA));
  return [r, g, b];
}

function colormapCoolwarmJs(x: number): [number, number, number] {
  x = clamp01(x);
  const blue: [number, number, number] = [0.229, 0.298, 0.754];
  const white: [number, number, number] = [0.865, 0.865, 0.865];
  const red: [number, number, number] = [0.706, 0.016, 0.15];
  const [a, b] = x < 0.5 ? [blue, white] : [white, red];
  const t = x < 0.5 ? x * 2.0 : (x - 0.5) * 2.0;
  return [
    clamp01(a[0] + t * (b[0] - a[0])),
    clamp01(a[1] + t * (b[1] - a[1])),
    clamp01(a[2] + t * (b[2] - a[2])),
  ];
}

function colormapRdBuJs(x: number): [number, number, number] {
  x = clamp01(x);
  const red: [number, number, number] = [0.647, 0.0, 0.149];
  const white: [number, number, number] = [0.969, 0.969, 0.969];
  const blue: [number, number, number] = [0.192, 0.212, 0.584];
  const [a, b] = x < 0.5 ? [red, white] : [white, blue];
  const t = x < 0.5 ? x * 2.0 : (x - 0.5) * 2.0;
  return [
    clamp01(a[0] + t * (b[0] - a[0])),
    clamp01(a[1] + t * (b[1] - a[1])),
    clamp01(a[2] + t * (b[2] - a[2])),
  ];
}

// Evaluates a colormap at t ∈ [0, 1], returning [r, g, b] in [0, 1].
// Used for rendering gradient swatches in the UI.
export function computeColormapColor(
  name: ColormapName,
  t: number,
): [number, number, number] {
  switch (name) {
    case "grayscale": {
      const v = clamp01(t);
      return [v, v, v];
    }
    case "viridis":
      return evalColormapJs(t, VIRIDIS_R, VIRIDIS_G, VIRIDIS_B);
    case "plasma":
      return evalColormapJs(t, PLASMA_R, PLASMA_G, PLASMA_B);
    case "inferno":
      return evalColormapJs(t, INFERNO_R, INFERNO_G, INFERNO_B);
    case "magma":
      return evalColormapJs(t, MAGMA_R, MAGMA_G, MAGMA_B);
    case "coolwarm":
      return colormapCoolwarmJs(t);
    case "rdbu":
      return colormapRdBuJs(t);
    case "jet":
      return colormapJetJs(t);
    case "cubehelix":
      return colormapCubehelixJs(t);
  }
}

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
vec3 colormapGrayscale(float x) {
  float v = clamp(x, 0.0, 1.0);
  return vec3(v, v, v);
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
   * Maximum error across all channels is approximately 0.01-0.02 depending on
   * the colormap — visually close but not exact reproduction.
   */
  `vec3 colormapViridis(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c0 = vec3(0.2744554244543814, 0.005767962396577286, 0.33266388111298156);
  vec3 c1 = vec3(0.10770832620590942, 1.3964696839276685, 1.386770597936565);
  vec3 c2 = vec3(-0.32724109678694613, 0.214813564542913, 0.09197688075380395);
  vec3 c3 = vec3(-4.599931518228907, -5.758238189317904, -19.29180895035448);
  vec3 c4 = vec3(6.203735901279355, 14.153964947400272, 56.6562995652498);
  vec3 c5 = vec3(4.751786888900565, -13.749439404408186, -65.32096782757077);
  vec3 c6 = vec3(-5.43207717100151, 4.641571315981625, 26.27210760448218);
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
