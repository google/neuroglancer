/**
 * @license
 * Copyright 2019 Google Inc.
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

import { registerAsyncComputation } from "#src/async_computation/handler.js";
import { parseVTKFromArrayBuffer } from "#src/async_computation/vtk_mesh_request.js";
import { getTriangularMeshSize, parseVTK } from "#src/datasource/vtk/parse.js";
import { maybeDecompressGzip } from "#src/util/gzip.js";

registerAsyncComputation(
  parseVTKFromArrayBuffer,
  async (buffer: ArrayBuffer) => {
    const mesh = parseVTK(await maybeDecompressGzip(buffer));
    return {
      value: { data: mesh, size: getTriangularMeshSize(mesh) },
      transfer: [
        mesh.indices.buffer,
        mesh.vertexPositions.buffer,
        ...Array.from(mesh.vertexAttributes.values()).map((a) => a.data.buffer),
      ],
    };
  },
);
