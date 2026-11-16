import { TrackableEnum } from "#src/util/trackable_enum.js";

export enum TransparentMeshRenderingMode {
  CURRENT = 0,
  IMPROVED = 1,
  HIGH_QUALITY = 2,
}

export class TrackableTransparentMeshRenderingMode extends TrackableEnum<TransparentMeshRenderingMode> {
  constructor() {
    super(TransparentMeshRenderingMode, TransparentMeshRenderingMode.CURRENT);
  }
}
