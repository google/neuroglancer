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

import "#src/datasource/zarr/register_default.js";
import "#src/kvstore/icechunk/register_frontend.js";
import "#src/kvstore/zip/register_frontend.js";
import "#src/kvstore/ocdbt/register_frontend.js";
import "#src/sliceview/uncompressed_chunk_format.js";
import { datasourceMetadataSnapshotTests } from "#tests/datasource/metadata_snapshot_test_util.js";

datasourceMetadataSnapshotTests("zarr", [
  "zarr_v3/examples/single_res",
  "ome_zarr/simple_0.4",
  "ome_zarr/simple_0.5",
  "ome_zarr/simple_0.5.zip",
  "ome_zarr/simple_0.5.ocdbt",
]);

datasourceMetadataSnapshotTests(
  "zarr",
  ["icechunk/single_array.icechunk"],
  "kvstore/",
);
