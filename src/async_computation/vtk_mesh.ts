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

import { registerAsyncComputation } from "#/async_computation/handler";
import { parseVTKFromArrayBuffer } from "#/async_computation/vtk_mesh_request";
import { getTriangularMeshSize, parseVTK } from "#/datasource/vtk/parse";
import { maybeDecompressGzip } from "#/util/gzip";

registerAsyncComputation(
  parseVTKFromArrayBuffer,
  async (buffer: ArrayBuffer) => {
    const mesh = parseVTK(maybeDecompressGzip(buffer));
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
