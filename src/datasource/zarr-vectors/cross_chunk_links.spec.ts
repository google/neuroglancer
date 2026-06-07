/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vitest";
import {
  decodeCrossChunkLinks,
  readCrossChunkLinks,
} from "#src/datasource/zarr-vectors/cross_chunk_links.js";

const TEXT_ENC = new TextEncoder();

function int64Bytes(values: number[]): Uint8Array {
  const buf = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; ++i) buf[i] = BigInt(values[i]);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function jsonBytes(obj: unknown): Uint8Array {
  return TEXT_ENC.encode(JSON.stringify(obj));
}

describe("decodeCrossChunkLinks", () => {
  it("decodes one link_width=2, sid_ndim=3 record", () => {
    // One edge: endpointA = (chunk (0,1,2), vertex 7); endpointB = ((1,1,2), vertex 0).
    const bytes = int64Bytes([0, 1, 2, 7, 1, 1, 2, 0]);
    const records = decodeCrossChunkLinks(bytes, 2, 3);
    expect(records).toHaveLength(1);
    expect(records[0].endpoints).toHaveLength(2);
    expect(records[0].endpoints[0]).toEqual({
      chunkCoords: [0, 1, 2],
      vertexIndex: 7,
    });
    expect(records[0].endpoints[1]).toEqual({
      chunkCoords: [1, 1, 2],
      vertexIndex: 0,
    });
  });

  it("decodes multiple records", () => {
    const bytes = int64Bytes([
      // record 0: ((0,0,0), 4) ↔ ((-1,0,0), 9)
      0, 0, 0, 4, -1, 0, 0, 9,
      // record 1: ((2,3,1), 0) ↔ ((2,3,2), 0)
      2, 3, 1, 0, 2, 3, 2, 0,
    ]);
    const records = decodeCrossChunkLinks(bytes, 2, 3);
    expect(records).toHaveLength(2);
    expect(records[0].endpoints[0].chunkCoords).toEqual([0, 0, 0]);
    expect(records[0].endpoints[1].chunkCoords).toEqual([-1, 0, 0]);
    expect(records[1].endpoints[0].vertexIndex).toBe(0);
  });

  it("handles negative chunk coordinates (zarr-vectors centers chunks on origin)", () => {
    const bytes = int64Bytes([-2, -3, -1, 5, -2, -3, 0, 0]);
    const records = decodeCrossChunkLinks(bytes, 2, 3);
    expect(records[0].endpoints[0].chunkCoords).toEqual([-2, -3, -1]);
    expect(records[0].endpoints[1].chunkCoords).toEqual([-2, -3, 0]);
  });

  it("handles 2-D sid_ndim", () => {
    const bytes = int64Bytes([0, 0, 3, 0, 1, 2]);
    const records = decodeCrossChunkLinks(bytes, 2, 2);
    expect(records).toHaveLength(1);
    expect(records[0].endpoints[0]).toEqual({
      chunkCoords: [0, 0],
      vertexIndex: 3,
    });
    expect(records[0].endpoints[1]).toEqual({
      chunkCoords: [0, 1],
      vertexIndex: 2,
    });
  });

  it("handles link_width=3 (triangle face record)", () => {
    const bytes = int64Bytes([
      0, 0, 0, 1,
      1, 0, 0, 2,
      0, 1, 0, 3,
    ]);
    const records = decodeCrossChunkLinks(bytes, 3, 3);
    expect(records).toHaveLength(1);
    expect(records[0].endpoints).toHaveLength(3);
    expect(records[0].endpoints[2].vertexIndex).toBe(3);
  });

  it("returns empty list for an empty blob", () => {
    const records = decodeCrossChunkLinks(new Uint8Array(0), 2, 3);
    expect(records).toEqual([]);
  });

  it("throws when byte length is not a multiple of one record", () => {
    // Record stride = link_width(2) * (sid_ndim(3)+1) * 8 = 64 bytes.
    // 56 bytes is shy of one record.
    const bytes = new Uint8Array(56);
    expect(() => decodeCrossChunkLinks(bytes, 2, 3)).toThrow(
      /not a multiple of one record/,
    );
  });

  it("throws on invalid link_width", () => {
    expect(() => decodeCrossChunkLinks(new Uint8Array(0), 0, 3)).toThrow(
      /link_width/,
    );
  });

  it("throws on invalid sid_ndim", () => {
    expect(() => decodeCrossChunkLinks(new Uint8Array(0), 2, 0)).toThrow(
      /sid_ndim/,
    );
  });

  it("works when the input bytes have a non-zero byteOffset (realigns)", () => {
    // Construct a 16-byte ArrayBuffer; slice off the first 8 bytes so the
    // resulting Uint8Array has byteOffset 8.  decodeCrossChunkLinks should
    // copy/realign and still produce the right record.
    const big = new BigInt64Array([0n, 0n, 5n, 11n]); // padding + 4 int64s
    const u8 = new Uint8Array(big.buffer, 8 + 0, 16); // skip first 8 padding
    // Wait — only 2 ints, not enough for a (sid_ndim=1, link_width=2) record.
    // Use 4 int64s instead.
    const data = new BigInt64Array([0n, 1n, 2n, 3n]); // 4 int64s
    const padded = new Uint8Array(40);
    padded.set(new Uint8Array(data.buffer), 8); // misaligned by 8
    const view = padded.subarray(8, 8 + 32);
    const records = decodeCrossChunkLinks(view, 2, 1);
    expect(records).toHaveLength(1);
    expect(records[0].endpoints[0]).toEqual({
      chunkCoords: [0],
      vertexIndex: 1,
    });
    expect(records[0].endpoints[1]).toEqual({
      chunkCoords: [2],
      vertexIndex: 3,
    });
    // Force u8 lint use.
    expect(u8).toBeInstanceOf(Uint8Array);
  });
});

describe("readCrossChunkLinks", () => {
  function mockKvStore(blobs: Record<string, Uint8Array | undefined>) {
    return async (
      subpath: string,
      _signal: AbortSignal,
    ): Promise<Uint8Array | undefined> => {
      return blobs[subpath];
    };
  }

  it("returns the parsed table when group + data are present", async () => {
    const meta = jsonBytes({
      attributes: { link_width: 2, sid_ndim: 3, num_links: 1 },
    });
    const data = int64Bytes([0, 0, 0, 5, 1, 0, 0, 0]);
    const table = await readCrossChunkLinks(
      {
        kvStoreRead: mockKvStore({
          "cross_chunk_links/0/zarr.json": meta,
          "cross_chunk_links/0/data/c/0": data,
        }),
      },
      new AbortController().signal,
    );
    expect(table).toBeDefined();
    expect(table!.linkWidth).toBe(2);
    expect(table!.sidNdim).toBe(3);
    expect(table!.records).toHaveLength(1);
    expect(table!.records[0].endpoints[0].chunkCoords).toEqual([0, 0, 0]);
  });

  it("returns undefined when group metadata is missing", async () => {
    const table = await readCrossChunkLinks(
      { kvStoreRead: mockKvStore({}) },
      new AbortController().signal,
    );
    expect(table).toBeUndefined();
  });

  it("returns empty records when num_links is 0 (no data fetch needed)", async () => {
    const meta = jsonBytes({
      attributes: { link_width: 2, sid_ndim: 3, num_links: 0 },
    });
    let dataFetched = false;
    const kvStoreRead = async (
      subpath: string,
      _signal: AbortSignal,
    ): Promise<Uint8Array | undefined> => {
      if (subpath.endsWith("data/c/0")) {
        dataFetched = true;
      }
      if (subpath === "cross_chunk_links/0/zarr.json") return meta;
      return undefined;
    };
    const table = await readCrossChunkLinks(
      { kvStoreRead },
      new AbortController().signal,
    );
    expect(table?.records).toEqual([]);
    expect(dataFetched).toBe(false);
  });

  it("tolerates a linkless table that omits sid_ndim (coarsest pyramid level)", async () => {
    // The writer only stamps `sid_ndim` when it writes records, so a
    // coarse level with zero surviving cross-chunk links has none.  A
    // linkless table needs no sid_ndim, so this must not throw.
    const meta = jsonBytes({
      attributes: { link_width: 2, num_links: 0 },
    });
    const kvStoreRead = async (
      subpath: string,
    ): Promise<Uint8Array | undefined> =>
      subpath === "cross_chunk_links/0/zarr.json" ? meta : undefined;
    const table = await readCrossChunkLinks(
      { kvStoreRead },
      new AbortController().signal,
    );
    expect(table?.records).toEqual([]);
    expect(table?.linkWidth).toBe(2);
    expect(table?.sidNdim).toBe(0);
  });

  it("respects the delta argument when forming subpaths", async () => {
    const calls: string[] = [];
    const kvStoreRead = async (
      subpath: string,
      _signal: AbortSignal,
    ): Promise<Uint8Array | undefined> => {
      calls.push(subpath);
      if (subpath === "cross_chunk_links/-1/zarr.json") {
        return jsonBytes({
          attributes: { link_width: 2, sid_ndim: 3, num_links: 0 },
        });
      }
      return undefined;
    };
    await readCrossChunkLinks(
      { kvStoreRead, delta: -1 },
      new AbortController().signal,
    );
    expect(calls[0]).toBe("cross_chunk_links/-1/zarr.json");
  });

  it("throws when num_links and record count disagree", async () => {
    const meta = jsonBytes({
      attributes: { link_width: 2, sid_ndim: 3, num_links: 99 },
    });
    const data = int64Bytes([0, 0, 0, 5, 1, 0, 0, 0]); // 1 record
    await expect(
      readCrossChunkLinks(
        {
          kvStoreRead: mockKvStore({
            "cross_chunk_links/0/zarr.json": meta,
            "cross_chunk_links/0/data/c/0": data,
          }),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/num_links=99/);
  });

  it("throws on missing or malformed group attributes", async () => {
    const meta = jsonBytes({ attributes: { link_width: 0, sid_ndim: 3 } });
    await expect(
      readCrossChunkLinks(
        {
          kvStoreRead: mockKvStore({ "cross_chunk_links/0/zarr.json": meta }),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/link_width/);
  });
});
