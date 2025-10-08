/**
 * @license
 * Browser test: JPEG XL decoding 8-bit vs 16-bit using testdata server.
 */
import { expect, it, describe } from "vitest";
import { decompressJxl } from "#src/sliceview/jxl/index.js";

declare const TEST_DATA_SERVER: string;

interface FixtureMeta {
  file: string;
  width: number;
  height: number;
  channels: number;
  bytesPerSample: number; // 1=u8,2=u16,4=float32
  kind: string; // u8|u16|f32
  value: number; // reference value (see generator notes)
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
        area,
        meta.channels,
        meta.bytesPerSample === 4 ? 4 : meta.bytesPerSample === 2 ? 2 : 1,
      );
      const expectedLen = area * meta.channels * meta.bytesPerSample;
      expect(decoded.uint8Array.length).toBe(expectedLen);
      // Validate central pixel value approximation.
      if (meta.channels === 1 && area === 1) {
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
});
