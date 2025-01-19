/**
 * @license
 * Copyright 2020 Google Inc.
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

import { parseOBJFromArrayBuffer } from "#src/async_computation/obj_mesh_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { getCachedDecodedUrl } from "#src/chunk_manager/generic_file_source.js";
import type { ReadResponse } from "#src/kvstore/index.js";
import { registerSingleMeshFactory } from "#src/single_mesh/backend.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

/**
 * This needs to be a global function, because it identifies the instance of SimpleAsyncCache
 * to use.
 */
async function parse(
  readResponse: ReadResponse | undefined,
  progressOptions: Partial<ProgressOptions>,
) {
  if (readResponse === undefined) {
    throw new Error("Not found");
  }
  const buffer = await readResponse.response.arrayBuffer();
  return requestAsyncComputation(
    parseOBJFromArrayBuffer,
    progressOptions.signal,
    [buffer],
    buffer,
  );
}

registerSingleMeshFactory("obj", {
  description: "OBJ",
  getMesh: (sharedKvStoreContext, url, options) =>
    getCachedDecodedUrl(sharedKvStoreContext, url, parse, options),
});
