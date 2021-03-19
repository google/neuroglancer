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

import {DataType} from 'neuroglancer/util/data_type';
import {parseNpy} from 'neuroglancer/util/npy';

interface ExampleSpec {
  dataType: string;
  shape: number[];
  data: number[];
}

function checkNpy(spec: ExampleSpec, encoded: Uint8Array) {
  let decoded = parseNpy(encoded);
  expect(decoded.shape).toEqual(spec.shape);
  expect(DataType[decoded.dataType].toLowerCase()).toBe(spec.dataType);
  expect(Array.from(<any>decoded.data)).toEqual(spec.data);
}

describe('parseNpy', () => {
  it('uint8', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.uint8.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.uint8.npy'));
  });

  it('uint16-le', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.uint16.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.uint16-le.npy'));
  });
  it('uint16-be', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.uint16.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.uint16-be.npy'));
  });

  it('uint32-le', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.uint32.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.uint32-le.npy'));
  });
  it('uint32-be', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.uint32.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.uint32-be.npy'));
  });

  it('uint64-le', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.uint64.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.uint64-le.npy'));
  });
  it('uint64-be', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.uint64.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.uint64-be.npy'));
  });

  it('float32-le', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.float32.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.float32-le.npy'));
  });
  it('float32-be', () => {
    checkNpy(
        require<ExampleSpec>('neuroglancer-testdata/npy_test.float32.json'),
        require<Uint8Array>('neuroglancer-testdata/npy_test.float32-be.npy'));
  });
});
