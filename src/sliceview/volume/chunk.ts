import { SliceViewChunk } from "#src/sliceview/chunk_base.js";
import type { ChunkFormat, VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { GL } from "#src/webgl/context.js";

export abstract class VolumeChunk extends SliceViewChunk {
  declare source: VolumeChunkSource;
  chunkDataSize: Uint32Array;
  declare CHUNK_FORMAT_TYPE: ChunkFormat;

  get chunkFormat(): this["CHUNK_FORMAT_TYPE"] {
    return this.source.chunkFormat;
  }

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.chunkDataSize = x.chunkDataSize || source.spec.chunkDataSize;
  }
  abstract getValueAt(dataPosition: Uint32Array): any;
  abstract updateFromCpuData(gl: GL): void;
}
