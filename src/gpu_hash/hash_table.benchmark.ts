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

import { describe, bench } from "vitest";
import { HashSetUint64 } from "#src/gpu_hash/hash_table.js";
import { getRandomValues } from "#src/util/random.js";

describe("gpu_hash/hash_table", () => {
  const ht = new HashSetUint64();
  const numValues = 100;
  const values = new BigUint64Array(numValues);
  getRandomValues(values);
  bench("insert", () => {
    ht.clear();
    for (const value of values) {
      ht.add(value);
    }
  });
});
