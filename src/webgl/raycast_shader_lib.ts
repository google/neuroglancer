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
 * @file General GLSL algebra for ray casting against a quadric surface.
 *
 * `solveQuadratic`, and the way callers form the coefficients they pass it, are
 * adapted from Inigo Quilez's sphere intersector
 * (https://iquilezles.org/articles/intersectors/), MIT licensed:
 *
 *   The MIT License. Copyright (c) 2016 Inigo Quilez.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to
 *   deal in the Software without restriction, including without limitation the
 *   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 *   sell copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: the above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS".
 *
 * One change. A caller measures its parameter from the ray's closest approach to
 * the axis, rather than forming the original `c = dot(oc, oc) - r * r`.
 * Neuroglancer models can sit far from the origin, and the rearranged form never
 * subtracts two large numbers.
 */

// Splits a vector into the part along a unit direction and the part across it.
export const glsl_splitAlongDir = `
struct VectorSplit {
  highp float parallelDist;
  highp vec3 perp;
};

VectorSplit splitAlongDir(highp vec3 vectorToSplit, highp vec3 unitDir) {
  VectorSplit split;
  split.parallelDist = dot(unitDir, vectorToSplit);
  split.perp = vectorToSplit - split.parallelDist * unitDir;
  return split;
}
`;

// Both roots of quadraticA * t^2 + 2 * quadraticB * t + quadraticC, for a
// quadraticA above zero.
//
// Note the 2. quadraticB is half the linear coefficient, which is the form a ray
// against a quadric produces and the one thing a caller cannot guess.
//
// The discriminant is the whole cost, and both roots share it, so returning both
// is barely more than returning one. Positive form on the discriminant test, so a
// NaN falls through to no roots. GLSL ES does not promise IEEE NaN comparison, so
// that is defence and not a guarantee.
export const glsl_solveQuadratic = `
struct QuadraticRoots {
  bool exist;
  highp float nearRoot;
  highp float farRoot;
};

QuadraticRoots solveQuadratic(highp float quadraticA, highp float quadraticB,
                              highp float quadraticC) {
  highp float discriminant = quadraticB * quadraticB - quadraticA * quadraticC;
  QuadraticRoots roots;
  roots.exist = false;
  roots.nearRoot = 0.0;
  roots.farRoot = 0.0;
  if (!(discriminant >= 0.0)) return roots;
  highp float rootOffset = sqrt(discriminant);
  roots.exist = true;
  roots.nearRoot = (-quadraticB - rootOffset) / quadraticA;
  roots.farRoot = (-quadraticB + rootOffset) / quadraticA;
  return roots;
}
`;
