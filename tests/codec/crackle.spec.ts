/**
 * @license
 * Copyright 2026 William Silversmith
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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi, beforeAll } from "vitest";
import { readHeader, decompressCrackle } from "#src/sliceview/crackle/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadJsonData(filename: string): number[] {
  const json = JSON.parse(readFileSync(filename, "utf8")) as { data: number[] };
  return json.data;
}

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const fs = await import("node:fs/promises");

      const url = input?.toString?.() ?? String(input);

      if (url.includes("libcrackle.wasm")) {
        const filePath = path.resolve(
          __dirname,
          "../../src/sliceview/crackle/libcrackle.wasm",
        );

        const data = await fs.readFile(filePath);

        return new Response(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
          {
            status: 200,
            headers: { "Content-Type": "application/wasm" },
          },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
});

test("crackle: zeros decodes to all zeros", async () => {
  let compressed = new Uint8Array(
    readFileSync("testdata/codec/crackle/zeros1.ckl"),
  );
  let header = readHeader(compressed);
  expect(header.dataWidth).toBe(1);
  expect(header.sx).toBe(32);
  expect(header.sy).toBe(32);
  expect(header.sz).toBe(32);

  let decoded = await decompressCrackle(compressed);

  expect(decoded.every((x) => x === 0)).toBe(true);

  compressed = new Uint8Array(
    readFileSync("testdata/codec/crackle/zeros2.ckl"),
  );
  header = readHeader(compressed);
  expect(header.dataWidth).toBe(2);
  expect(header.sx).toBe(32);
  expect(header.sy).toBe(32);
  expect(header.sz).toBe(32);

  decoded = await decompressCrackle(compressed);

  expect(decoded.every((x) => x === 0)).toBe(true);

  compressed = new Uint8Array(
    readFileSync("testdata/codec/crackle/zeros4.ckl"),
  );

  header = readHeader(compressed);
  expect(header.dataWidth).toBe(4);
  expect(header.sx).toBe(32);
  expect(header.sy).toBe(32);
  expect(header.sz).toBe(32);

  decoded = await decompressCrackle(compressed);

  expect(decoded.every((x) => x === 0)).toBe(true);

  compressed = new Uint8Array(
    readFileSync("testdata/codec/crackle/zeros8.ckl"),
  );
  header = readHeader(compressed);
  expect(header.dataWidth).toBe(8);
  expect(header.sx).toBe(32);
  expect(header.sy).toBe(32);
  expect(header.sz).toBe(32);

  decoded = await decompressCrackle(compressed);

  expect(decoded.every((x) => x === 0)).toBe(true);
});

test("crackle: ones decodes to all ones", async () => {
  let compressed = new Uint8Array(
    readFileSync("testdata/codec/crackle/ones1.ckl"),
  );
  let decoded = await decompressCrackle(compressed);

  expect(decoded.every((x) => x === 1)).toBe(true);

  compressed = new Uint8Array(readFileSync("testdata/codec/crackle/ones2.ckl"));
  decoded = await decompressCrackle(compressed);
  const view16 = new Uint16Array(decoded.buffer);
  expect(view16.every((x) => x === 1)).toBe(true);

  compressed = new Uint8Array(readFileSync("testdata/codec/crackle/ones4.ckl"));
  decoded = await decompressCrackle(compressed);
  const view32 = new Uint32Array(decoded.buffer);
  expect(view32.every((x) => x === 1)).toBe(true);

  compressed = new Uint8Array(readFileSync("testdata/codec/crackle/ones8.ckl"));
  decoded = await decompressCrackle(compressed);
  const view64 = new BigUint64Array(decoded.buffer);
  expect(view64.every((x) => x === 1n)).toBe(true);
});

test("crackle: random volume", async () => {
  const compressed = new Uint8Array(
    readFileSync("testdata/codec/crackle/random.ckl"),
  );

  const header = readHeader(compressed);
  expect(header.dataWidth).toBe(1);
  expect(header.sx).toBe(20);
  expect(header.sy).toBe(20);
  expect(header.sz).toBe(20);

  const decoded = await decompressCrackle(compressed);

  const gt = loadJsonData("testdata/codec/crackle/random.json");

  expect(decoded.length).toBe(gt.length);

  for (let i = 0; i < gt.length; i++) {
    expect(decoded[i]).toBe(gt[i]);
  }
});

async function run_connectomics_volume(filename: string) {
  const compressed = new Uint8Array(readFileSync(filename));

  const header = readHeader(compressed);
  expect(header.dataWidth).toBe(4);
  expect(header.sx).toBe(32);
  expect(header.sy).toBe(32);
  expect(header.sz).toBe(32);

  const decoded8 = await decompressCrackle(compressed);
  const decoded = new Uint32Array(decoded8.buffer);

  const gt = loadJsonData("testdata/codec/crackle/pinky40.json");

  expect(decoded.length).toBe(gt.length);

  for (let i = 0; i < gt.length; i++) {
    expect(decoded[i]).toBe(gt[i]);
  }
}

test("crackle: connectomics volume (flat)", async () => {
  await run_connectomics_volume("testdata/codec/crackle/pinky40.ckl");
});

test("crackle: connectomics volume (flat,m4)", async () => {
  await run_connectomics_volume("testdata/codec/crackle/pinky40_m4.ckl");
});

test("crackle: connectomics volume (pins)", async () => {
  await run_connectomics_volume("testdata/codec/crackle/pinky40_pins.ckl");
});

test("crackle: connectomics volume (pins,m4)", async () => {
  await run_connectomics_volume("testdata/codec/crackle/pinky40_m4pins.ckl");
});
