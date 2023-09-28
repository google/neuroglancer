import {TrackableEnum} from 'neuroglancer/util/trackable_enum';
import {maxProjectionFragmentShader, userDefinedFragmentShader} from 'neuroglancer/volume_rendering/shaders';

export enum SHADER_MODES {
  DEFAULT = 0,
  MAX_PROJECTION = 1
}

export const SHADER_FUNCTIONS = new Map([
  [SHADER_MODES.DEFAULT, userDefinedFragmentShader],
  [SHADER_MODES.MAX_PROJECTION, maxProjectionFragmentShader]
]);

export type TrackableShaderModeValue = TrackableEnum<SHADER_MODES>;

export function trackableShaderModeValue(initialValue = SHADER_MODES.DEFAULT) {
  return new TrackableEnum(SHADER_MODES, initialValue);
}