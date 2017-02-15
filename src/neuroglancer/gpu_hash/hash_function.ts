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

export const PRIME_MODULUS = 4093;

export class HashFunction {
  constructor(
      public a0: Float32Array, public a1: Float32Array, public b: number, public c: number) {}

  computeDotProduct(low: number, high: number) {
    let {a0, a1} = this;
    let a0DotLow = a0[0] * (low & 0xFF) + a0[1] * ((low >> 8) & 0xFF) +
        a0[2] * ((low >> 16) & 0xFF) + a0[3] * ((low >> 24) & 0xFF);
    let a1DotHigh = a1[0] * (high & 0xFF) + a1[1] * ((high >> 8) & 0xFF) +
        a1[2] * ((high >> 16) & 0xFF) + a1[3] * ((high >> 24) & 0xFF);
    return a0DotLow + a1DotHigh;
  }

  compute(low: number, high: number) {
    let {b, c} = this;
    let x = this.computeDotProduct(low, high);
    let x2 = (x * x) % PRIME_MODULUS;
    let result = (x + x2 * c + b) % PRIME_MODULUS;
    return result;
  }

  toString() {
    return `new HashFunction(Float32Array.of(${this.a0}), Float32Array.of(${this.a1}), ${this.b}, ${this.c})`;
  }

  static generate() {
    function genCoeff() { return Math.floor(Math.random() * PRIME_MODULUS); }
    function genVector() { return Float32Array.of(genCoeff(), genCoeff(), genCoeff(), genCoeff()); }
    return new HashFunction(genVector(), genVector(), genCoeff(), genCoeff());
  }
};
