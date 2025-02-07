/**
 * @license
 * Copyright 2025 Google Inc.
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

import { test, expect } from "vitest";
import { decodeLeb128, decodeLeb128Bigint } from "#src/util/leb128.js";

function doDecode(array: Uint8Array<ArrayBuffer>) {
  const dataView = new DataView(
    array.buffer,
    array.byteOffset,
    array.byteLength,
  );
  return decodeLeb128(dataView, 0).value;
}

function doDecodeBigint(array: Uint8Array<ArrayBuffer>) {
  const dataView = new DataView(
    array.buffer,
    array.byteOffset,
    array.byteLength,
  );
  return decodeLeb128Bigint(dataView, 0).value;
}

test("simple", () => {
  expect(doDecode(Uint8Array.of(0))).toEqual(0);
  expect(doDecode(Uint8Array.of(127))).toEqual(127);
  expect(
    doDecodeBigint(
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1),
    ),
  ).toEqual(0xffffffffffffffffn);
});
