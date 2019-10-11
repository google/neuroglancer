/**
 * @license
 * Copyright 2018 Google Inc.
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
 * @file Ellipse-related shader functions.
 */

import {mat3, vec2, vec3} from 'neuroglancer/util/geom';

/**
 * Specifies the parameters of an ellipse in quadratic form.
 */
export const glsl_EllipseQuadraticForm = `
struct EllipseQuadraticForm {
  highp float A;  // x*x coefficient
  highp float B;  // x*y coefficient
  highp float C;  // y*y coefficient
  highp float D;  // x coefficient
  highp float E;  // y coefficient
  highp float F;  // 1 coefficient
};
`;

/**
 * Given a 3-d ellipsoid, finds the ellipse corresponding to the z=0 cross-section.
 * @param A The positive semi-definite matrix defining the ellipsoid shape.
 * @param c The centroid.
 */
export const glsl_computeCrossSectionEllipse = [glsl_EllipseQuadraticForm, `
EllipseQuadraticForm computeCrossSectionEllipse(mat3 A, vec3 c) {
  EllipseQuadraticForm p;
  p.A = A[0][0];
  p.B = A[0][1] + A[1][0];
  p.C = A[1][1];
  p.D = -2.0 * c[0] * A[0][0] - c[1] * (A[0][1] + A[1][0]) +
        c[2] * (A[0][2] + A[2][0]);
  p.E = -c[0] * (A[0][1] + A[1][0]) - 2.0 * c[1] * A[1][1] +
        c[2] * (A[1][2] + A[2][1]);
  p.F = c[0] * c[0] * A[0][0] + c[0] * c[1] * (A[0][1] + A[1][0]) -
        c[0] * c[2] * (A[0][2] + A[2][0]) + c[1] * c[1] * A[1][1] -
        c[1] * c[2] * (A[1][2] + A[2][1]) + c[2] * c[2] * A[2][2] - 1.0;
  return p;
}
`];

export function computeCrossSectionEllipseDebug(Ao: mat3, c: vec3) {
  const A = [[Ao[0], Ao[1], Ao[2]], [Ao[3], Ao[4], Ao[5]], [Ao[6], Ao[7], Ao[8]]];
  return {
    A: A[0][0],
    B: A[0][1] + A[1][0],
    C: A[1][1],
    D: -2.0 * c[0] * A[0][0] - c[1] * (A[0][1] + A[1][0]) + c[2] * (A[0][2] + A[2][0]),
    E: -c[0] * (A[0][1] + A[1][0]) - 2.0 * c[1] * A[1][1] + c[2] * (A[1][2] + A[2][1]),
    F: c[0] * c[0] * A[0][0] + c[0] * c[1] * (A[0][1] + A[1][0]) -
        c[0] * c[2] * (A[0][2] + A[2][0]) + c[1] * c[1] * A[1][1] -
        c[1] * c[2] * (A[1][2] + A[2][1]) + c[2] * c[2] * A[2][2] - 1.0,
  };
}

export const glsl_CenterOrientEllipse = `
struct CenterOrientEllipse {
  vec2 k;   // center
  vec2 u1;  // minor axis direction
  vec2 u2;  // major axis direction
  float a;  // semimajor axis
  float b;  // semiminor axis
  bool valid; // indicates if the ellipse is valid
};
`;

/**
 * Compute the center-orient parameterization of an ellipse from the quadratic parameterization.
 *
 * See: https://www.geometrictools.com/Documentation/InformationAboutEllipses.pdf
 */
export const glsl_computeCenterOrientEllipse = [
  glsl_EllipseQuadraticForm, glsl_CenterOrientEllipse, `
CenterOrientEllipse computeCenterOrientEllipse(EllipseQuadraticForm p) {
  CenterOrientEllipse r;
  float a11 = p.A;
  float a12 = p.B / 2.0;
  float a22 = p.C;
  float b1 = p.D;
  float b2 = p.E;
  float c = p.F;
  float kdenom = 2.0 * (a12 * a12 - a11 * a22);
  float k1 = r.k.x = (a22 * b1 - a12 * b2) / kdenom;
  float k2 = r.k.y = (a11 * b2 - a12 * b1) / kdenom;
  float mu = 1.0 / (a11 * k1 * k1 + 2.0 * a12 * k1 * k2 + a22 * k2 * k2 - c);
  float m11 = mu * a11;
  float m12 = mu * a12;
  float m22 = mu * a22;
  float lambdaTerm1 = m11 + m22;
  float lambdaTerm2 = sqrt((m11 - m22) * (m11 - m22) + 4.0 * m12 * m12);
  float lambda1 = ((lambdaTerm1 + lambdaTerm2) / 2.0);
  float lambda2 = ((lambdaTerm1 - lambdaTerm2) / 2.0);
  r.a = 1.0 / sqrt(lambda1);
  r.b = 1.0 / sqrt(lambda2);
  r.valid = lambda1 > 0.0 && lambda2 > 0.0;
  if (abs(m11 - m22) < 1e-6 && abs(m12) < 1e-6) {
    r.u1 = vec2(1.0, 0.0);
  } else if (m11 >= m22) {
    r.u1 = normalize(vec2(lambda1 - m22, m12));
  } else {
    r.u1 = normalize(vec2(m12, lambda1 - m11));
  }
  r.u2 = vec2(-r.u1.y, r.u1.x);
  return r;
}
`
];

export function computeCenterOrientEllipseDebug(
    p: {A: number, B: number, C: number, D: number, E: number, F: number}) {
  const a11 = p.A;
  const a12 = p.B / 2.0;
  const a22 = p.C;
  const b1 = p.D;
  const b2 = p.E;
  const c = p.F;
  const kdenom = 2.0 * (a12 * a12 - a11 * a22);
  const k1 = (a22 * b1 - a12 * b2) / kdenom;
  const k2 = (a11 * b2 - a12 * b1) / kdenom;
  const mu = 1.0 / (a11 * k1 * k1 + 2.0 * a12 * k1 * k2 + a22 * k2 * k2 - c);
  const m11 = mu * a11;
  const m12 = mu * a12;
  const m22 = mu * a22;
  const lambdaTerm1 = m11 + m22;
  const lambdaTerm2 = Math.sqrt((m11 - m22) * (m11 - m22) + 4.0 * m12 * m12);
  const lambda1 = ((lambdaTerm1 + lambdaTerm2) / 2.0);
  const lambda2 = ((lambdaTerm1 - lambdaTerm2) / 2.0);
  const a = 1.0 / Math.sqrt(lambda1);
  const b = 1.0 / Math.sqrt(lambda2);
  let u1: vec2;
  if (m11 >= m22) {
    u1 = vec2.fromValues(lambda1 - m22, m12);
  } else {
    u1 = vec2.fromValues(m12, lambda1 - m11);
  }
  vec2.normalize(u1, u1);
  const u2 = vec2.fromValues(-u1[1], u1[0]);
  return {
    k: vec2.fromValues(k1, k2),
    u1,
    u2,
    a,
    b,
    lambda1,
    lambda2,
    m11,
    m12,
    m22,
    valid: lambda1 > 0 && lambda2 > 0,
  };
}
