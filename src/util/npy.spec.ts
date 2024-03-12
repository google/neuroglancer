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

import { describe, it, expect } from "vitest";
import { DataType } from "#src/util/data_type.js";
import { parseNpy } from "#src/util/npy.js";

import float32be_npy from "#testdata/npy_test.float32-be.npy?binary";
import float32le_npy from "#testdata/npy_test.float32-le.npy?binary";
import float32_example from "#testdata/npy_test.float32.json";
import uint16be_npy from "#testdata/npy_test.uint16-be.npy?binary";
import uint16le_npy from "#testdata/npy_test.uint16-le.npy?binary";
import uint16_example from "#testdata/npy_test.uint16.json";
import uint32be_npy from "#testdata/npy_test.uint32-be.npy?binary";
import uint32le_npy from "#testdata/npy_test.uint32-le.npy?binary";
import uint32_example from "#testdata/npy_test.uint32.json";
import uint64be_npy from "#testdata/npy_test.uint64-be.npy?binary";
import uint64le_npy from "#testdata/npy_test.uint64-le.npy?binary";
import uint64_example from "#testdata/npy_test.uint64.json";
import uint8_example from "#testdata/npy_test.uint8.json";
import uint8_npy from "#testdata/npy_test.uint8.npy?binary";

interface ExampleSpec {
  dataType: string;
  shape: number[];
  data: number[];
}

async function checkNpy(spec: ExampleSpec, encoded: Uint8Array) {
  const decoded = parseNpy(encoded);
  expect(decoded.shape).toEqual(spec.shape);
  expect(DataType[decoded.dataType].toLowerCase()).toBe(spec.dataType);
  expect(Array.from(decoded.data)).toEqual(spec.data);
}

describe("parseNpy", () => {
  it("uint8", async () => {
    await checkNpy(uint8_example, uint8_npy);
  });

  it("uint16-le", async () => {
    checkNpy(uint16_example, uint16le_npy);
  });
  it("uint16-be", async () => {
    checkNpy(uint16_example, uint16be_npy);
  });

  it("uint32-le", async () => {
    checkNpy(uint32_example, uint32le_npy);
  });
  it("uint32-be", async () => {
    checkNpy(uint32_example, uint32be_npy);
  });

  it("uint64-le", async () => {
    checkNpy(uint64_example, uint64le_npy);
  });
  it("uint64-be", async () => {
    checkNpy(uint64_example, uint64be_npy);
  });

  it("float32-le", async () => {
    checkNpy(float32_example, float32le_npy);
  });
  it("float32-be", async () => {
    checkNpy(float32_example, float32be_npy);
  });
});
