import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeChunkSpecification, VolumeSourceOptions , DataType, VolumeType } from "#src/sliceview/volume/base.js";
import {
  InMemoryVolumeChunkSource,
  MultiscaleVolumeChunkSource,
  type VolumeChunkSource
} from "#src/sliceview/volume/frontend.js";

export class VoxelPreviewMultiscaleSource extends MultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType: VolumeType;
  rank: number;

  constructor(
    chunkManager: ChunkManager,
    public primarySource: MultiscaleVolumeChunkSource,
  ) {
    super(chunkManager);
    this.dataType = primarySource.dataType;
    this.volumeType = primarySource.volumeType;
    this.rank = primarySource.rank;
  }

  getSources(
    options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    const sourcesByScale = this.primarySource.getSources(options);

    return sourcesByScale.map(orientation => {
      return orientation.map(primaryResSource => {
        const spec = primaryResSource.chunkSource.spec;

        const previewSpec: VolumeChunkSpecification = {
          ...spec,
          compressedSegmentationBlockSize: undefined,
        };

        const previewSource = this.chunkManager.getChunkSource(
          InMemoryVolumeChunkSource,
          { spec: previewSpec },
        );

        console.log(
            "%c[CHECKPOINT 5]%c Preview source created:",
            "color: purple; font-weight: bold;",
            "",
            previewSource,
        );

        return {
          chunkSource: previewSource,
          chunkToMultiscaleTransform: primaryResSource.chunkToMultiscaleTransform,
        };
      });
    });
  }
}
