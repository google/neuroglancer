import {TrackableEnum} from 'neuroglancer/util/trackable_enum';

export enum VOLUME_RENDERING_MODES {
  OFF = 0,
  ON = 1,
  MAX = 2
}

export type TrackableVolumeRenderingModeValue = TrackableEnum<VOLUME_RENDERING_MODES>;

export function trackableShaderModeValue(initialValue = VOLUME_RENDERING_MODES.OFF) {
  return new TrackableEnum(VOLUME_RENDERING_MODES, initialValue);
}