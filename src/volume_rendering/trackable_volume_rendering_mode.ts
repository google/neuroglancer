import { TrackableEnum } from "#src/util/trackable_enum.js";
import type { VolumeRenderingRenderLayer } from "src/volume_rendering/volume_render_layer";

export enum VolumeRenderingModes {
  OFF = 0,
  ON = 1,
  MAX = 2,
  MIN = 3,
}

export type TrackableVolumeRenderingModeValue =
  TrackableEnum<VolumeRenderingModes>;

export function trackableShaderModeValue(
  initialValue = VolumeRenderingModes.OFF,
) {
  return new TrackableEnum(VolumeRenderingModes, initialValue);
}

export function isProjectionMode(mode: VolumeRenderingModes): boolean {
  return mode === VolumeRenderingModes.MAX || mode === VolumeRenderingModes.MIN;
}

export function isProjectionLayer(layer: VolumeRenderingRenderLayer): boolean {
  return isProjectionMode(layer.mode.value);
}
