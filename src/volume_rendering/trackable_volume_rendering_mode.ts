import { TrackableEnum } from "#src/util/trackable_enum.js";

export enum VOLUME_RENDERING_MODES {
  OFF = 0,
  ON = 1,
  MAX = 2,
  MIN = 3,
}

export type TrackableVolumeRenderingModeValue =
  TrackableEnum<VOLUME_RENDERING_MODES>;

export function trackableShaderModeValue(
  initialValue = VOLUME_RENDERING_MODES.OFF,
) {
  return new TrackableEnum(VOLUME_RENDERING_MODES, initialValue);
}

export function isProjection(
  mode: VOLUME_RENDERING_MODES,
): boolean {
  return mode === VOLUME_RENDERING_MODES.MAX || mode === VOLUME_RENDERING_MODES.MIN;
}