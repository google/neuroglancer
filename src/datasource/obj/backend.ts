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
import { GenericSharedDataSource } from "#src/chunk_manager/generic_file_source.js";
import { registerSingleMeshFactory } from "#src/single_mesh/backend.js";
import type { CancellationToken } from "#src/util/cancellation.js";

/**
 * This needs to be a global function, because it identifies the instance of GenericSharedDataSource
 * to use.
 */
function parse(buffer: ArrayBuffer, cancellationToken: CancellationToken) {
  return requestAsyncComputation(
    parseOBJFromArrayBuffer,
    cancellationToken,
    [buffer],
    buffer,
  );
}

registerSingleMeshFactory("obj", {
  description: "OBJ",
  getMesh: (
    chunkManager,
    credentialsProvider,
    url,
    getPriority,
    cancellationToken,
  ) =>
    GenericSharedDataSource.getUrl(
      chunkManager,
      credentialsProvider,
      parse,
      url,
      getPriority,
      cancellationToken,
    ),
});
