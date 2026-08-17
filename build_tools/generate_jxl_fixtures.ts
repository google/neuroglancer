/**
 * @license
 * Utility to generate tiny JPEG XL fixtures for tests.
 *
 * Strategy:
 * 1. Create raw PPM (Portable Pixmap) files for 1x1 grayscale values.
 * 2. If `cjxl` (libjxl CLI encoder) is available on PATH, invoke it
 *    to produce .jxl outputs under testdata/jxl/.
 * 3. If unavailable, emit a notice; tests will skip if fixtures are absent.
 *
 * Usage:
 *   npx ts-node build_tools/generate_jxl_fixtures.ts
 * or add a package.json script alias.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname; // neuroglancer/
const OUT_DIR = join(ROOT, "testdata", "jxl");

interface FixtureSpec {
  filename: string; // base name without extension
  kind: "u8" | "u16" | "f32";
  width: number;
  height: number;
  value: number; // canonical value (0..255 for u8, 0..65535 for u16, 0..1 float)
}

const FIXTURES: FixtureSpec[] = [
  { filename: "gray_u8_128", kind: "u8", width: 1, height: 1, value: 128 },
  {
    filename: "gray_u16_40000",
    kind: "u16",
    width: 1,
    height: 1,
    value: 40000,
  },
  { filename: "gray_f32_0_25", kind: "f32", width: 1, height: 1, value: 0.25 },
];

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function writeRawPortableGraymap(
  path: string,
  width: number,
  height: number,
  data: Uint8Array,
) {
  // P5 (PGM) header
  const header = `P5\n${width} ${height}\n255\n`;
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(headerBytes.length + data.length);
  out.set(headerBytes, 0);
  out.set(data, headerBytes.length);
  writeFileSync(path, out);
}

// Removed unused writePpmFromGray to satisfy TS noUnusedLocals.

function haveCjxl(): boolean {
  const r = spawnSync("cjxl", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

function generate() {
  ensureDir(OUT_DIR);
  const cjxl = haveCjxl();
  if (!cjxl) {
    console.error(
      "[generate_jxl_fixtures] 'cjxl' not found on PATH. Skipping generation.",
    );
    console.error(
      "Install libjxl (brew install jpeg-xl) then re-run to create fixtures.",
    );
    return;
  }
  const metadata: any[] = [];
  for (const f of FIXTURES) {
    const base = join(OUT_DIR, f.filename);
    const jxlPath = `${base}.jxl`;
    let sourcePath: string;
    if (f.kind === "u8") {
      const gray = new Uint8Array([f.value & 0xff]);
      sourcePath = `${base}.pgm`;
      writeRawPortableGraymap(sourcePath, f.width, f.height, gray);
      const res = spawnSync("cjxl", [sourcePath, jxlPath, "--quiet"], {
        stdio: "inherit",
      });
      if (res.status !== 0) console.error(`Failed encode ${sourcePath}`);
      metadata.push({
        file: `${f.filename}.jxl`,
        width: f.width,
        height: f.height,
        channels: 1,
        bytesPerSample: 1,
        kind: f.kind,
        value: f.value,
      });
    } else if (f.kind === "u16") {
      // Produce a 16-bit gray via PGM maxval 65535 then cjxl.
      const header = `P5\n${f.width} ${f.height}\n65535\n`;
      const headerBytes = new TextEncoder().encode(header);
      const pixel = f.value & 0xffff;
      const gray16 = new Uint8Array([pixel >> 8, pixel & 0xff]); // big-endian per PGM spec
      const out = new Uint8Array(headerBytes.length + gray16.length);
      out.set(headerBytes, 0);
      out.set(gray16, headerBytes.length);
      sourcePath = `${base}_16.pgm`;
      writeFileSync(sourcePath, out);
      const res = spawnSync("cjxl", [sourcePath, jxlPath, "--quiet"], {
        stdio: "inherit",
      });
      if (res.status !== 0) console.error(`Failed encode ${sourcePath}`);
      metadata.push({
        file: `${f.filename}.jxl`,
        width: f.width,
        height: f.height,
        channels: 1,
        bytesPerSample: 2,
        kind: f.kind,
        value: f.value,
      });
    } else if (f.kind === "f32") {
      // True float32 via PFM (Portable Float Map) grayscale: header 'Pf', negative scale => little-endian
      // Spec: lines: 'Pf', 'width height', 'scale' then binary floats row-major.
      const header = `Pf\n${f.width} ${f.height}\n-1.0\n`;
      const headerBytes = new TextEncoder().encode(header);
      const pixelF32 = new Float32Array([f.value]);
      const pixelBytes = new Uint8Array(pixelF32.buffer);
      sourcePath = `${base}.pfm`;
      const out = new Uint8Array(headerBytes.length + pixelBytes.length);
      out.set(headerBytes, 0);
      out.set(pixelBytes, headerBytes.length);
      writeFileSync(sourcePath, out);
      const res = spawnSync("cjxl", [sourcePath, jxlPath, "--quiet"], {
        stdio: "inherit",
      });
      if (res.status !== 0) console.error(`Failed encode ${sourcePath}`);
      metadata.push({
        file: `${f.filename}.jxl`,
        width: f.width,
        height: f.height,
        channels: 1,
        bytesPerSample: 4,
        kind: f.kind,
        value: f.value,
      });
    }
  }

  // Multi-pixel and multi-channel lossless fixtures.  These exercise the
  // reshape -> jpegxl codec chain over real spatial/channel data and verify
  // exact-value (color) fidelity.  Encoded with `-d 0` (mathematically
  // lossless) so the decoded samples equal the source bytes.
  {
    const values = [
      0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240,
    ];
    const src = join(OUT_DIR, "gray_u8_4x4.pgm");
    writeRawPortableGraymap(src, 4, 4, new Uint8Array(values));
    const res = spawnSync(
      "cjxl",
      [src, join(OUT_DIR, "gray_u8_4x4.jxl"), "-d", "0", "--quiet"],
      { stdio: "inherit" },
    );
    if (res.status !== 0) console.error(`Failed encode ${src}`);
    metadata.push({
      file: "gray_u8_4x4.jxl",
      width: 4,
      height: 4,
      channels: 1,
      bytesPerSample: 1,
      kind: "u8",
      lossless: true,
      values,
    });
  }
  {
    const values = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30];
    const header = new TextEncoder().encode(`P6\n2 2\n255\n`);
    const body = new Uint8Array(values);
    const out = new Uint8Array(header.length + body.length);
    out.set(header, 0);
    out.set(body, header.length);
    const src = join(OUT_DIR, "rgb_u8_2x2.ppm");
    writeFileSync(src, out);
    const res = spawnSync(
      "cjxl",
      [src, join(OUT_DIR, "rgb_u8_2x2.jxl"), "-d", "0", "--quiet"],
      { stdio: "inherit" },
    );
    if (res.status !== 0) console.error(`Failed encode ${src}`);
    metadata.push({
      file: "rgb_u8_2x2.jxl",
      width: 2,
      height: 2,
      channels: 3,
      bytesPerSample: 1,
      kind: "u8",
      lossless: true,
      values,
    });
  }

  writeFileSync(
    join(OUT_DIR, "fixtures.json"),
    JSON.stringify(metadata, null, 2),
  );
  console.log(
    "JPEG XL fixtures generated (if encoding succeeded). You may delete .ppm sources.",
  );
}

generate();
