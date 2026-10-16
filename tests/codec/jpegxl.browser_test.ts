/**
 * @license
 * Browser test: JPEG XL decoding 8-bit vs 16-bit using testdata server.
 */
import { expect, it, describe } from "vitest";
import "#src/datasource/zarr/codec/bytes/decode.js";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/jpegxl/decode.js";
import "#src/datasource/zarr/codec/jpegxl/resolve.js";
import "#src/datasource/zarr/codec/reshape/decode.js";
import "#src/datasource/zarr/codec/reshape/resolve.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { decompressJxl } from "#src/sliceview/jxl/index.js";
import { DataType } from "#src/util/data_type.js";

declare const TEST_DATA_SERVER: string;

interface FixtureMeta {
  file: string;
  width: number;
  height: number;
  channels: number;
  bytesPerSample: number; // 1=u8,2=u16,4=float32
  kind: string; // u8|u16|f32
  value?: number; // reference value for 1x1 fixtures (see generator notes)
  lossless?: boolean;
  values?: number[]; // full expected sample values (lossless fixtures)
}

async function fetchMetadata(): Promise<FixtureMeta[] | null> {
  const url = `${TEST_DATA_SERVER.replace(/\/$/, "")}/jxl/fixtures.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()) as FixtureMeta[];
  } catch {
    return null;
  }
}

async function fetchFixture(relPath: string): Promise<Uint8Array | null> {
  const url = `${TEST_DATA_SERVER.replace(/\/$/, "")}/${relPath}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

describe("jpegxl decode (browser)", () => {
  it("decodes metadata-described fixtures (u8/u16/f32 single-channel)", async () => {
    const metas = await fetchMetadata();
    if (!metas) {
      expect(true).toBe(true); // skip
      return;
    }
    let ran = 0;
    for (const meta of metas) {
      const data = await fetchFixture(`jxl/${meta.file}`);
      if (!data) continue;
      const area = meta.width * meta.height;
      const decoded = await decompressJxl(
        data,
        area * meta.channels,
        meta.bytesPerSample === 4 ? 4 : meta.bytesPerSample === 2 ? 2 : 1,
      );
      const expectedLen = area * meta.channels * meta.bytesPerSample;
      expect(decoded.uint8Array.length).toBe(expectedLen);
      // Validate central pixel value approximation.
      if (meta.channels === 1 && area === 1 && meta.value !== undefined) {
        if (meta.bytesPerSample === 1) {
          const v = decoded.uint8Array[0];
          expect(Math.abs(v - meta.value)).toBeLessThanOrEqual(2);
        } else if (meta.bytesPerSample === 2) {
          const v16 = decoded.uint8Array[0] | (decoded.uint8Array[1] << 8);
          expect(Math.abs(v16 - meta.value)).toBeLessThanOrEqual(512);
        } else if (meta.bytesPerSample === 4) {
          const view = new DataView(
            decoded.uint8Array.buffer,
            decoded.uint8Array.byteOffset,
            decoded.uint8Array.byteLength,
          );
          const f = view.getFloat32(0, true);
          expect(Math.abs(f - meta.value)).toBeLessThanOrEqual(0.005);
        }
      }
      ran++;
    }
    expect(ran).toBeGreaterThan(0);
  });

  it("decodes lossless fixtures to exact sample values (color fidelity + derived channels)", async () => {
    const metas = await fetchMetadata();
    if (!metas) {
      expect(true).toBe(true); // skip
      return;
    }
    let ran = 0;
    for (const meta of metas) {
      if (!meta.lossless || meta.values === undefined) continue;
      const data = await fetchFixture(`jxl/${meta.file}`);
      if (!data) continue;
      const expectedElements = meta.width * meta.height * meta.channels;
      // `numComponents` is derived from the codestream, not passed in.
      const decoded = await decompressJxl(data, expectedElements, 1);
      expect(decoded.numComponents).toBe(meta.channels);
      expect(Array.from(decoded.uint8Array)).toEqual(meta.values);
      ran++;
    }
    expect(ran).toBeGreaterThan(0);
  });

  it("decodes through a reshape -> jpegxl v3 codec chain", async () => {
    const metas = await fetchMetadata();
    if (!metas) {
      expect(true).toBe(true); // skip
      return;
    }
    const meta = metas.find((m) => m.file === "gray_u8_4x4.jxl");
    if (!meta || meta.values === undefined) {
      expect(true).toBe(true); // skip
      return;
    }
    const data = await fetchFixture(`jxl/${meta.file}`);
    if (!data) {
      expect(true).toBe(true); // skip
      return;
    }
    // A 3-D chunk [1, 4, 4] is reshaped into the native 2-D image [4, 4]:
    // reshape `shape: [[1], [2]]` drops the leading unit dimension.
    const chunkShape = [1, 4, 4];
    const codecs = parseCodecChainSpec(
      [
        { name: "reshape", configuration: { shape: [[1], [2]] } },
        { name: "jpegxl", configuration: {} },
      ],
      { dataType: DataType.UINT8, chunkShape },
    );
    expect(codecs.arrayInfo[codecs.arrayInfo.length - 1].chunkShape).toEqual([
      4, 4,
    ]);
    const decoded = await decodeArray(
      codecs,
      new Uint8Array(data),
      new AbortController().signal,
    );
    expect(Array.from(new Uint8Array(decoded.buffer))).toEqual(meta.values);
  });

  it("throws when the chunk shape does not match the decoded image size", async () => {
    const metas = await fetchMetadata();
    if (!metas) {
      expect(true).toBe(true); // skip
      return;
    }
    const meta = metas.find((m) => m.file === "gray_u8_4x4.jxl");
    const data = meta && (await fetchFixture(`jxl/${meta.file}`));
    if (!data) {
      expect(true).toBe(true); // skip
      return;
    }
    // Declare a 5x5 image where the codestream is 4x4 -> must throw.
    const codecs = parseCodecChainSpec(
      [{ name: "jpegxl", configuration: {} }],
      { dataType: DataType.UINT8, chunkShape: [5, 5] },
    );
    await expect(
      decodeArray(codecs, new Uint8Array(data), new AbortController().signal),
    ).rejects.toThrow();
  });
});
