import { ChunkState } from "#src/chunk_manager/base.js";
import { Chunk } from "#src/chunk_manager/frontend.js";
import type { SliceViewChunkSource } from "#src/sliceview/frontend.js";
import type { vec3 } from "#src/util/geom.js";

export class SliceViewChunk extends Chunk {
  chunkGridPosition: vec3;
  declare source: SliceViewChunkSource;

  constructor(source: SliceViewChunkSource, x: any) {
    super(source);
    this.chunkGridPosition = x.chunkGridPosition;
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}
