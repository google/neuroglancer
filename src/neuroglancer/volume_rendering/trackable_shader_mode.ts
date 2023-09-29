import {TrackableEnum} from 'neuroglancer/util/trackable_enum';
import {maxProjectionFragmentShader, userDefinedFragmentShader, chunkValueFragmentShader} from 'neuroglancer/volume_rendering/shaders';

export enum SHADER_MODES {
  DEFAULT = 0,
  MAX_PROJECTION = 1,
  CHUNK_VISUALIZATION = 2,
}

export const SHADER_FUNCTIONS = new Map([
  [SHADER_MODES.DEFAULT, userDefinedFragmentShader],
  [SHADER_MODES.MAX_PROJECTION, maxProjectionFragmentShader],
  [SHADER_MODES.CHUNK_VISUALIZATION, chunkValueFragmentShader],
]);

export type TrackableShaderModeValue = TrackableEnum<SHADER_MODES>;

export function trackableShaderModeValue(initialValue = SHADER_MODES.DEFAULT) {
  return new TrackableEnum(SHADER_MODES, initialValue);
}