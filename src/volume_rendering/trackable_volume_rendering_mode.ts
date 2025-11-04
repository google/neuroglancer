/**
 * @license
 * Copyright 2025 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
