import {TrackableEnum} from 'neuroglancer/util/trackable_enum';

export enum VOLUME_RENDERING_MODES {
  DISABLED = 0,
  DIRECT_COMPOSITING = 1,
  MAX_PROJECTION = 2
}

export type TrackableVolumeRenderingModeValue = TrackableEnum<VOLUME_RENDERING_MODES>;

export function trackableShaderModeValue(initialValue = VOLUME_RENDERING_MODES.DISABLED) {
  return new TrackableEnum(VOLUME_RENDERING_MODES, initialValue);
}