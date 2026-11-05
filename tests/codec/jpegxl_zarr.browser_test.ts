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

// Decodes real zarr v3 stores that use the `sharding_indexed` -> `reshape` +
// `jpegxl` codec chain (with `transpose` for one array), exercising multi-frame,
// multi-channel, uint16, float32, and channel-in-the-middle scenarios. Each
// array is a single shard file. See build_tools/generate_zarr_jpegxl_fixtures.py
// for how the fixtures are built.

import { describe, expect, it } from "vitest";
import "#src/datasource/zarr/codec/bytes/decode.js";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/crc32c/decode.js";
import "#src/datasource/zarr/codec/crc32c/resolve.js";
import "#src/datasource/zarr/codec/jpegxl/decode.js";
import "#src/datasource/zarr/codec/jpegxl/resolve.js";
import "#src/datasource/zarr/codec/reshape/decode.js";
import "#src/datasource/zarr/codec/reshape/resolve.js";
import "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import "#src/datasource/zarr/codec/transpose/decode.js";
import "#src/datasource/zarr/codec/transpose/resolve.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

declare const TEST_DATA_SERVER: string;

interface ManifestChunk {
  subChunk: number[];
  values: number[];
}
interface ManifestArray {
  dir: string;
  shardKey: string;
  chunks: ManifestChunk[];
}
type Manifest = Record<string, ManifestArray>;

const DATA_TYPES: Record<string, DataType> = {
  uint8: DataType.UINT8,
  uint16: DataType.UINT16,
  float32: DataType.FLOAT32,
};

function base() {
  return `${TEST_DATA_SERVER.replace(/\/$/, "")}/zarr_jpegxl`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

function readSamples(decoded: ArrayBufferView, dataType: DataType): number[] {
  const { buffer, byteOffset, byteLength } = decoded;
  switch (dataType) {
    case DataType.UINT8:
      return Array.from(new Uint8Array(buffer, byteOffset, byteLength));
    case DataType.UINT16:
      return Array.from(new Uint16Array(buffer, byteOffset, byteLength / 2));
    case DataType.FLOAT32:
      return Array.from(new Float32Array(buffer, byteOffset, byteLength / 4));
    default:
      throw new Error(`unsupported data type ${dataType}`);
  }
}

// `decodeArray` returns samples in the innermost codec's *physical* (C-order)
// layout; the mapping back to the logical chunk axes is expressed by
// `layoutInfo[0]` (physicalToLogicalDimension + readChunkShape), exactly as the
// volume reader interprets it. Reconstruct the logical C-order chunk so we can
// compare against the original data -- this is what verifies that a `transpose`
// in the chain restores the channel axis to its logical position.
function reconstructLogical(
  physical: number[],
  chunkShape: number[],
  layout: { physicalToLogicalDimension: number[]; readChunkShape: number[] },
): number[] {
  const rank = chunkShape.length;
  const p2l = layout.physicalToLogicalDimension;
  const physicalShape = p2l.map((l) => layout.readChunkShape[l]);
  const physStride = new Array<number>(rank);
  physStride[rank - 1] = 1;
  for (let p = rank - 2; p >= 0; --p) {
    physStride[p] = physStride[p + 1] * physicalShape[p + 1];
  }
  const total = chunkShape.reduce((a, b) => a * b, 1);
  const out = new Array<number>(total);
  const idx = new Array<number>(rank).fill(0);
  for (let flat = 0; flat < total; ++flat) {
    let off = 0;
    for (let p = 0; p < rank; ++p) off += idx[p2l[p]] * physStride[p];
    out[flat] = physical[off];
    for (let d = rank - 1; d >= 0; --d) {
      if (++idx[d] < chunkShape[d]) break;
      idx[d] = 0;
    }
  }
  return out;
}

// C-order linear index of `coords` within `gridShape`.
function linearIndex(coords: number[], gridShape: number[]): number {
  let index = 0;
  for (let d = 0; d < gridShape.length; ++d) {
    index = index * gridShape[d] + coords[d];
  }
  return index;
}

describe("zarr v3 sharding + reshape + jpegxl codec chain", () => {
  it("decodes sharded multi-frame / multi-channel / uint16 / float32 / transpose stores", async () => {
    const manifest = await fetchJson<Manifest>(`${base()}/manifest.json`);
    if (!manifest) {
      expect(true).toBe(true); // skip when fixtures are absent
      return;
    }
    const signal = new AbortController().signal;
    let arraysChecked = 0;
    for (const [name, arr] of Object.entries(manifest)) {
      const zarrJson = await fetchJson<any>(`${base()}/${arr.dir}/zarr.json`);
      if (!zarrJson) continue;
      const dataType = DATA_TYPES[zarrJson.data_type];
      expect(dataType, `data type ${zarrJson.data_type}`).not.toBeUndefined();
      // The outer chunk shape is the shard shape.
      const shardShape: number[] =
        zarrJson.chunk_grid.configuration.chunk_shape;
      const spec = parseCodecChainSpec(zarrJson.codecs, {
        dataType,
        chunkShape: shardShape,
      });
      const sharding: any = spec[CodecKind.arrayToBytes].configuration;
      const { subChunkShape, subChunkGridShape, subChunkCodecs, indexCodecs } =
        sharding;

      if (name === "array5_txycz_transpose_u8") {
        // Logical axes [t, x, y, c, z] are stored physically as [t, c, z, x, y];
        // on decode the channel axis (logical dim 3) lands back in the middle.
        expect(subChunkCodecs.layoutInfo[0].physicalToLogicalDimension).toEqual(
          [0, 3, 4, 1, 2],
        );
        expect(subChunkCodecs.layoutInfo[0].readChunkShape).toEqual(
          subChunkShape,
        );
      }

      const shard = await fetchBytes(`${base()}/${arr.dir}/${arr.shardKey}`);
      expect(shard, `${name} shard`).not.toBeNull();

      // Decode the shard index (bytes + crc32c) from the end of the shard.
      const indexSize =
        indexCodecs.encodedSize[indexCodecs.encodedSize.length - 1];
      const indexBytesRaw = shard!.slice(shard!.length - indexSize);
      const indexArray = await decodeArray(
        indexCodecs,
        new Uint8Array(indexBytesRaw),
        signal,
      );
      const index = new BigUint64Array(
        indexArray.buffer,
        indexArray.byteOffset,
        indexArray.byteLength / 8,
      );

      for (const chunk of arr.chunks) {
        const linear = linearIndex(chunk.subChunk, subChunkGridShape);
        const offset = Number(index[linear * 2]);
        const length = Number(index[linear * 2 + 1]);
        const subBytes = shard!.slice(offset, offset + length);
        const decoded = await decodeArray(
          subChunkCodecs,
          new Uint8Array(subBytes),
          signal,
        );
        const physical = readSamples(decoded, dataType);
        expect(physical.length, `${name} ${chunk.subChunk} length`).toBe(
          chunk.values.length,
        );
        const got = reconstructLogical(
          physical,
          subChunkShape,
          subChunkCodecs.layoutInfo[0],
        );
        if (dataType === DataType.FLOAT32) {
          for (let i = 0; i < got.length; ++i) {
            expect(
              Math.abs(got[i] - chunk.values[i]),
              `${name} ${chunk.subChunk} [${i}]`,
            ).toBeLessThanOrEqual(1e-4);
          }
        } else {
          expect(got, `${name} ${chunk.subChunk}`).toEqual(chunk.values);
        }
      }
      arraysChecked++;
    }
    expect(arraysChecked).toBeGreaterThan(0);
  });
});
