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

import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { parseWarpfieldConfiguration } from "#src/datasource/zarr/codec/warpfield/config.js";
import { WarpfieldDecoder } from "#src/datasource/zarr/codec/warpfield/wasm.js";

const testDataDir = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "testdata",
  "codec",
  "warpfield",
);

// Chunks encoded by the Python reference, with its decodings.
const examples = [
  "volume_jacobian",
  "volume_component_last",
  "image_linear",
  "stack_cubic",
  "smooth_extrapolate_f64",
];

let decoder: WarpfieldDecoder;

beforeAll(async () => {
  decoder = await WarpfieldDecoder.instantiate(
    await fs.readFile(path.join(import.meta.dirname, "warpfield.wasm")),
  );
});

async function readExample(name: string) {
  const meta = JSON.parse(
    await fs.readFile(path.join(testDataDir, `${name}.json`), "utf-8"),
  );
  const encoded = new Uint8Array(
    await fs.readFile(path.join(testDataDir, `${name}.wfld`)),
  );
  const raw = new Uint8Array(
    await fs.readFile(path.join(testDataDir, `${name}.bin`)),
  ).buffer;
  const arrayType = meta.dataType === "float32" ? Float32Array : Float64Array;
  return { meta, encoded, expected: new arrayType(raw), arrayType };
}

function bits(a: Float32Array | Float64Array) {
  return a instanceof Float32Array
    ? new Uint32Array(a.buffer, a.byteOffset, a.length)
    : new BigUint64Array(a.buffer, a.byteOffset, a.length);
}

describe("warpfield wasm decoder", () => {
  for (const name of examples) {
    test(`${name} is bit-identical to the reference`, async () => {
      const { meta, encoded, expected, arrayType } = await readExample(name);
      const config = parseWarpfieldConfiguration(meta.configuration);
      const decoded = decoder.decodeAs(
        encoded,
        meta.shape,
        config.json,
        arrayType,
      );
      expect(decoded.length).toBe(expected.length);
      expect(bits(decoded)).toEqual(bits(expected));
    });
  }

  test("rejects a chunk decoded with the wrong shape", async () => {
    const { meta, encoded } = await readExample("image_linear");
    const config = parseWarpfieldConfiguration(meta.configuration);
    expect(() => decoder.decode(encoded, [33, 41, 2], config.json)).toThrow(
      /canonical shape/,
    );
  });

  test("rejects truncated and corrupt chunks", async () => {
    const { meta, encoded } = await readExample("volume_component_last");
    const config = parseWarpfieldConfiguration(meta.configuration);
    expect(() =>
      decoder.decode(
        encoded.subarray(0, encoded.length - 10),
        meta.shape,
        config.json,
      ),
    ).toThrow();
    const bad = encoded.slice();
    bad[0] = 0;
    expect(() => decoder.decode(bad, meta.shape, config.json)).toThrow(/magic/);
  });

  test("validates the configuration", () => {
    expect(() =>
      parseWarpfieldConfiguration({ axis_roles: ["component"] }),
    ).toThrow(/spatial/);
    expect(() =>
      parseWarpfieldConfiguration({
        axis_roles: ["spatial"],
        error_bound: 0.1,
        face_error_bound: 0.2,
      }),
    ).toThrow(/face_error_bound/);
    expect(() =>
      parseWarpfieldConfiguration({ axis_roles: ["spatial"], foo: 1 }),
    ).toThrow(/unknown/);
  });
});
