import {TrackableEnum} from 'neuroglancer/util/trackable_enum';
import {glsl_CHUNK_NUMBER_SHADER, glsl_MAX_PROJECTION_SHADER, glsl_USER_DEFINED_RAY_TRAVERSAL} from 'src/neuroglancer/volume_rendering/glsl';

export enum SHADER_MODES {
  DISABLED = 0,
  DIRECT_COMPOSITING = 1,
  MAX_PROJECTION = 2,
  CHUNK_VISUALIZATION = 3,
}

export const SHADER_FUNCTIONS = new Map([
  [SHADER_MODES.DISABLED, glsl_USER_DEFINED_RAY_TRAVERSAL],
  [SHADER_MODES.DIRECT_COMPOSITING, glsl_USER_DEFINED_RAY_TRAVERSAL],
  [SHADER_MODES.MAX_PROJECTION, glsl_MAX_PROJECTION_SHADER],
  [SHADER_MODES.CHUNK_VISUALIZATION, glsl_CHUNK_NUMBER_SHADER],
]);

export type TrackableShaderModeValue = TrackableEnum<SHADER_MODES>;

export function trackableShaderModeValue(initialValue = SHADER_MODES.DISABLED) {
  return new TrackableEnum(SHADER_MODES, initialValue);
}