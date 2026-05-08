import { SkeletonRenderMode } from "#src/skeleton/frontend.js";

export interface SkeletonModeLayerLike {
  displayState: {
    skeletonRenderingOptions: {
      params2d: {
        mode: {
          value: SkeletonRenderMode;
        };
      };
      params3d: {
        mode: {
          value: SkeletonRenderMode;
        };
      };
    };
  };
}

export function setSpatialSkeletonModesToLinesAndPoints(
  layer: SkeletonModeLayerLike,
) {
  layer.displayState.skeletonRenderingOptions.params2d.mode.value =
    SkeletonRenderMode.LINES_AND_POINTS;
  layer.displayState.skeletonRenderingOptions.params3d.mode.value =
    SkeletonRenderMode.LINES_AND_POINTS;
}
