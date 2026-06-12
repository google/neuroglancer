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

import type { VolumeChunkSpecification } from "#src/sliceview/volume/base.js";
import type { ChunkFormatHandler } from "#src/sliceview/volume/frontend.js";
import type { GL } from "#src/webgl/context.js";

export type ChunkFormatHandlerFactory = (
  gl: GL,
  spec: VolumeChunkSpecification,
) => ChunkFormatHandler | null;

const chunkFormatHandlers = new Array<ChunkFormatHandlerFactory>();

export function registerChunkFormatHandler(factory: ChunkFormatHandlerFactory) {
  chunkFormatHandlers.push(factory);
}

export function getChunkFormatHandler(gl: GL, spec: VolumeChunkSpecification) {
  for (const handler of chunkFormatHandlers) {
    const result = handler(gl, spec);
    if (result != null) {
      return result;
    }
  }
  throw new Error("No chunk format handler found.");
}
