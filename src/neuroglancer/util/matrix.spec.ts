/**
 * @license
 * Copyright 2019 Google Inc.
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

import * as matrix from 'neuroglancer/util/matrix';

describe('matrix identity', () => {
  it('works for n=0', () => {
    expect(matrix.identity(new Float32Array(0), 1, 0)).toEqual(Float32Array.of());
  });
  it('works for n=1', () => {
    expect(matrix.identity(new Float32Array(1), 1, 1)).toEqual(Float32Array.of(1));
  });
  it('works for n=2', () => {
    expect(matrix.identity(new Float32Array(4), 2, 2)).toEqual(Float32Array.from([
      1, 0,  //
      0, 1,  //
    ]));
  });
  it('works for n=2 with lda 3', () => {
    expect(matrix.identity(new Float32Array(6), 3, 2)).toEqual(Float32Array.from([
      1, 0, 0,  //
      0, 1, 0,  //
    ]));
  });
  it('works for n=3', () => {
    expect(matrix.identity(new Float32Array(9), 3, 3)).toEqual(Float32Array.from([
      1, 0, 0,  //
      0, 1, 0,  //
      0, 0, 1,  //
    ]));
  });
});

describe('matrix multiply', () => {
  it('works for n=m=k=1', () => {
    expect(matrix.multiply(
               new Float32Array(1), 1, Float32Array.of(2), 1, Float32Array.of(3), 1, 1, 1, 1))
        .toEqual(Float32Array.of(6));
  });
  it('works for n=2 m=3 k=4', () => {
    expect(matrix.multiply(
               /*c=*/ new Float32Array(8), /*ldc=*/ 2,
               /*a=*/ Float32Array.from([
                 1, 4,  //
                 2, 5,  //
                 3, 6,  //
               ]),
               /*lda=*/ 2, /*b=*/ Float32Array.from([
                 10, 14, 18,  //
                 11, 15, 19,  //
                 12, 16, 20,  //
                 13, 17, 21,  //
               ]),
               /*ldb=*/ 3, /*m=*/ 2, /*n=*/ 3, /*k=*/ 4))
        .toEqual(Float32Array.from([
          1 * 10 + 2 * 14 + 3 * 18,  //
          4 * 10 + 5 * 14 + 6 * 18,  //

          1 * 11 + 2 * 15 + 3 * 19,  //
          4 * 11 + 5 * 15 + 6 * 19,  //

          1 * 12 + 2 * 16 + 3 * 20,  //
          4 * 12 + 5 * 16 + 6 * 20,  //

          1 * 13 + 2 * 17 + 3 * 21,  //
          4 * 13 + 5 * 17 + 6 * 21,  //
        ]));
  });
});

describe('matrix inverse', () => {
  for (let n = 0; n <= 5; ++n) {
    it(`works for identity with n=${n}`, () => {
      const a = matrix.identity(new Float32Array(n * n), n, n);
      const inv = new Float32Array(n * n);
      const det = matrix.inverse(inv, n, a, n, n);
      for (let i = 0; i < n * n; ++i) {
        expect(inv[i]).toBeCloseTo(a[i]);
      }
      expect(det).toEqual(1);
    });
    it(`works for random with n=${n}`, () => {
      const a = matrix.identity(new Float32Array(n * n), n, n);
      for (let i = 0; i < n * n; ++i) {
        a[i] = Math.random() * (Math.random() > 0.5 ? 1 : -1);
      }
      const inv = new Float32Array(n * n);
      matrix.inverse(inv, n, a, n, n);
      const invInv = new Float32Array(n * n);
      matrix.inverse(invInv, n, inv, n, n);
      const identity = matrix.identity(new Float32Array(n * n), n, n);
      const product = matrix.multiply(new Float32Array(n * n), n, a, n, inv, n, n, n, n);
      for (let j = 0; j < n * n; ++j) {
        expect(product[j]).toBeCloseTo(identity[j]);
        expect(invInv[j]).toBeCloseTo(a[j]);
      }
    });
  }
  it('works for random 3x3', () => {
    const a = Float32Array.from([
      0.63801312, -0.18285496,  0.2852664, //
      0.20250243, -1.13919964, -1.47078985, //
      0.08072267,  0.59113917, -1.35186258
    ]);
    const expectedInv = Float32Array.from([
      1.53537228, -0.05006174, 0.37845593,  //
      0.09878793, -0.56428026, 0.6347676,   //
      0.13487817, -0.24973639, -0.4395521
    ]);
    const inv = new Float32Array(9);
    matrix.inverse(inv, 3, a, 3, 3);
    for (let j = 0; j < 9; ++j) {
      expect(inv[j]).toBeCloseTo(expectedInv[j]);
    }
  });

  it(`works for shear matrix with n=4`, () => {
    const a = Float32Array.from([
      2, 0, 0, 0,  //
      2, 2, 0, 0,  //
      0, 0, 1, 0,  //
      0, 0, 0, 1   //
    ]);
    const inv = new Float32Array(16);
    matrix.inverse(inv, 4, a, 4, 4);
    const expected = Float32Array.from([
      0.5, 0, 0, 0,     //
      -0.5, 0.5, 0, 0,  //
      0, 0, 1, 0,       //
      0, 0, 0, 1        //
    ]);
    for (let j = 0; j < 16; ++j) {
      expect(inv[j]).toBeCloseTo(expected[j]);
    }
  });
  it(`works for simple matrix with n=2`, () => {
    const a = Float32Array.from([
      1, 2,  //
      3, 4
    ]);
    const inv = new Float32Array(4);
    matrix.inverse(inv, 2, a, 2, 2);
    const expected = Float32Array.from([
      -2, 1,     //
      1.5, -0.5  //
    ]);
    for (let j = 0; j < 4; ++j) {
      expect(inv[j]).toBeCloseTo(expected[j]);
    }
  });
});

describe('matrix determinant', () => {
  for (let n = 0; n <= 5; ++n) {
    it(`works for random lower triangular with n=${n}`, () => {
      const a = matrix.identity(new Float32Array(n * n), n, n);
      let expectedDet = 1;
      for (let i = 0; i < n; ++i) {
        for (let j = i; j < n; ++j) {
          const x = a[i * n + j] = Math.random() * (Math.random() > 0.5 ? 1 : -1);
          if (i === j) expectedDet *= x;
        }
      }
      const inv = new Float32Array(n * n);
      const det = matrix.inverse(inv, n, a, n, n);
      expect(det).toBeCloseTo(expectedDet);
    });

    it(`works for random upper triangular with n=${n}`, () => {
      const a = matrix.identity(new Float32Array(n * n), n, n);
      let expectedDet = 1;
      for (let i = 0; i < n; ++i) {
        for (let j = 0; j <= i; ++j) {
          const x = a[i * n + j] = Math.random() * (Math.random() > 0.5 ? 1 : -1);
          if (i === j) expectedDet *= x;
        }
      }
      const inv = new Float32Array(n * n);
      const det = matrix.inverse(inv, n, a, n, n);
      expect(det).toBeCloseTo(expectedDet);
    });
  }

  it('works for fixed example', () => {
    const a = Float64Array.from([
      0.5031954, 0.99386515, 0.83549146, 0.40939415,   //
      0.71039848, 0.36933695, 0.26979203, 0.76002198,  //
      0.52522857, 0.89060451, 0.79783943, 0.98458708,  //
      0.58377242, 0.14067787, 0.24505687, 0.14859511,  //
    ]);
    const det = matrix.inverseInplace(a, 4, 4);
    expect(det).toBeCloseTo(0.0604863912803989);
  });

});

describe('createHomogeneousScaleMatrix', () => {
  it('works for rank 0', () => {
    expect(matrix.createHomogeneousScaleMatrix(Float64Array, [])).toEqual(Float64Array.from([1]));
  });
  it('works for rank 1', () => {
    expect(matrix.createHomogeneousScaleMatrix(Float64Array, [2])).toEqual(Float64Array.from([
      2, 0,  //
      0, 1,  //
    ]));
  });
  it('works for rank 2', () => {
    expect(matrix.createHomogeneousScaleMatrix(Float64Array, [2, 3])).toEqual(Float64Array.from([
      2, 0, 0,  //
      0, 3, 0,  //
      0, 0, 1,  //
    ]));
  });
  it('works for rank 3', () => {
    expect(matrix.createHomogeneousScaleMatrix(Float64Array, [2, 3, 4])).toEqual(Float64Array.from([
      2, 0, 0, 0,  //
      0, 3, 0, 0,  //
      0, 0, 4, 0,  //
      0, 0, 0, 1,  //
    ]));
  });
});
