/**
 * @license
 * Copyright 2025.
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

import type { VoxUserLayer } from "#src/layer/vox/index.js";
import { LegacyTool, registerLegacyTool } from "#src/ui/tool.js";

export const PIXEL_TOOL_ID = "voxPixel";

export class VoxelPixelLegacyTool extends LegacyTool<VoxUserLayer> {
  description = "pixel";
  toJSON() {
    return PIXEL_TOOL_ID;
  }
  trigger(_mouseState: any) {
    // eslint-disable-next-line no-console
    console.log("|hello world|");
  }
}

export function registerVoxelAnnotationTools() {
  registerLegacyTool(PIXEL_TOOL_ID, (layer) => new VoxelPixelLegacyTool(layer));
}
