/**
 * @license
 * Copyright 2024 Google Inc.
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

import "#src/datasource/deepzoom/register_default.js";
import "#src/sliceview/uncompressed_chunk_format.js";
import { test } from "vitest";
import { DeepzoomImageTileSource } from "#src/datasource/deepzoom/backend.js";
import { ImageTileEncoding } from "#src/datasource/deepzoom/base.js";
import { datasourceMetadataSnapshotTests } from "#tests/datasource/metadata_snapshot_test_util.js";

datasourceMetadataSnapshotTests("deepzoom", ["14122_mPPC_BDA_s186.dzi"]);

test("download reads tiles relative to trailing-slash directory paths", async ({
  expect,
}) => {
  let readPath: string | undefined;
  let readSignal: AbortSignal | undefined;
  const source = {
    parameters: {
      url: "image_files/12/",
      encoding: ImageTileEncoding.JPG,
      format: "jpg",
      overlap: 0,
      tilesize: 256,
    },
    tileKvStore: {
      path: "image_files/12/",
      store: {
        read(path: string, options: { signal: AbortSignal }) {
          readPath = path;
          readSignal = options.signal;
          return Promise.resolve(undefined);
        },
      },
    },
  };
  const controller = new AbortController();
  await DeepzoomImageTileSource.prototype.download.call(
    source as never,
    { chunkGridPosition: Uint32Array.of(3, 4) } as never,
    controller.signal,
  );
  expect(readPath).toBe("image_files/12/3_4.jpg");
  expect(readSignal).toBe(controller.signal);
});
