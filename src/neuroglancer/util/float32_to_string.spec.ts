/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

import {float32ToString} from 'neuroglancer/util/float32_to_string';

describe('float32_to_minimal_string', () => {
  it('valid_float_to_minimal_string', () => {
    let val: string;

    val = float32ToString(0.2999998927116394);
    expect(val).toEqual('0.2999999');

    val = float32ToString(0.2999999225139618);
    expect(val).toEqual('0.29999992');

    val = float32ToString(0.30000001192092896);
    expect(val).toEqual('0.3');

    val = float32ToString(0.30000004172325134);
    expect(val).toEqual('0.30000004');

    val = float32ToString(0.0005000000237487257);
    expect(val).toEqual('0.0005');

    val = float32ToString(0.0005000000819563866);
    expect(val).toEqual('0.0005000001');

    val = float32ToString(4.999999987376214e-7);
    expect(val).toEqual('5e-7');

    val = float32ToString(NaN);
    expect(val).toEqual('NaN');

    val = float32ToString(-Infinity);
    expect(val).toEqual('-Infinity');
  });

  it('float32_to_minimal_string_roundtrip', () => {
    const test_values = [
      (0.2999998927116394),
      (0.2999999225139618),
      (0.30000001192092896),
      (0.30000004172325134),
      (0.0005000000237487257),
      (0.0005000000819563866),
      (4.999999987376214e-7),
      (NaN),
      (-Infinity)
    ];

    test_values.forEach(original => {
      let roundtrip = parseFloat(float32ToString(original));
      expect(Math.fround(roundtrip)).toEqual(original);
    });
  });
});
