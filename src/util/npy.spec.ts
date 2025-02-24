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

import fs from "node:fs/promises";
import path from "node:path";
import { describe, test, expect } from "vitest";
import { DataType } from "#src/util/data_type.js";
import { parseNpy } from "#src/util/npy.js";

interface ExampleSpec {
  dataType: string;
  shape: number[];
  data: number[];
}

async function checkNpy(spec: ExampleSpec, encoded: Uint8Array<ArrayBuffer>) {
  const decoded = parseNpy(encoded);
  expect(decoded.shape).toEqual(spec.shape);
  expect(DataType[decoded.dataType].toLowerCase()).toBe(spec.dataType);
  expect(Array.from(decoded.data)).toEqual(spec.data);
}

describe("parseNpy", () => {
  for (const { json, npys } of [
    { json: "uint8", npys: ["uint8"] },
    ...["uint16", "uint32", "uint64", "float32"].map((x) => ({
      json: x,
      npys: [`${x}-le`, `${x}-be`],
    })),
  ]) {
    for (const npyName of npys) {
      test(npyName, async () => {
        const testDataDir = path.resolve(
          import.meta.dirname,
          "..",
          "..",
          "testdata",
          "codec",
          "npy",
        );
        const example = JSON.parse(
          await fs.readFile(`${testDataDir}/npy_test.${json}.json`, {
            encoding: "utf-8",
          }),
          (key, value) =>
            Number(key).toString() === key && typeof value === "string"
              ? BigInt(value)
              : value,
        ) as ExampleSpec;
        const npy = await fs.readFile(`${testDataDir}/npy_test.${npyName}.npy`);
        await checkNpy(example, new Uint8Array(npy));
      });
    }
  }
});
