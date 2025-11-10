/**
 * @license
 * Copyright 2025.
 */

import type { ChunkManager } from '#src/chunk_manager/frontend.js';
import type { VolumeChunkSpecification } from '#src/sliceview/volume/base.js';
import { VolumeChunkSource as BaseVolumeChunkSource } from '#src/sliceview/volume/frontend.js';
import { VOX_DUMMY_CHUNK_SOURCE_RPC_ID } from '#src/voxel_annotation/backend.js';

/**
 * Frontend owner for VoxDummyChunkSource. It simply sets the RPC_TYPE_ID so the backend
 * counterpart created in the worker matches our vox implementation that synthesizes data.
 */
export class VoxDummyChunkSource extends BaseVolumeChunkSource {
  constructor(chunkManager: ChunkManager, options: { spec: VolumeChunkSpecification }) {
    super(chunkManager, options);
  }
}

// Register owner type id so ChunkManager can initialize the correct backend counterpart.
(VoxDummyChunkSource as any).prototype.RPC_TYPE_ID = VOX_DUMMY_CHUNK_SOURCE_RPC_ID;
