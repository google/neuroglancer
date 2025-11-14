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

import { SliceViewChunk } from "#src/sliceview/chunk_base.js";
import type {
  ChunkFormat,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import type { GL } from "#src/webgl/context.js";

export abstract class VolumeChunk extends SliceViewChunk {
  declare source: VolumeChunkSource;
  chunkDataSize: Uint32Array;
  declare CHUNK_FORMAT_TYPE: ChunkFormat;

  get chunkFormat(): this["CHUNK_FORMAT_TYPE"] {
    return this.source.chunkFormat;
  }

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.chunkDataSize = x.chunkDataSize || source.spec.chunkDataSize;
  }
  abstract getValueAt(dataPosition: Uint32Array): any;
  abstract updateFromCpuData(gl: GL): void;
}
