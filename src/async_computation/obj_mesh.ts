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

import { registerAsyncComputation } from "#src/async_computation/handler.js";
import { parseOBJFromArrayBuffer } from "#src/async_computation/obj_mesh_request.js";
import type { SingleMesh } from "#src/single_mesh/backend.js";
import { Float32ArrayBuilder } from "#src/util/float32array_builder.js";
import { maybeDecompressGzip } from "#src/util/gzip.js";
import { Uint32ArrayBuilder } from "#src/util/uint32array_builder.js";

registerAsyncComputation(
  parseOBJFromArrayBuffer,
  async (buffer: ArrayBuffer) => {
    buffer = await maybeDecompressGzip(buffer);
    let text = new TextDecoder().decode(buffer);
    // Strip comments
    text = text.replace(/#.*/g, "");
    const vertexPositions = new Float32ArrayBuilder();
    const indices = new Uint32ArrayBuilder();

    // Find vertices
    for (const match of text.matchAll(
      /^v\s+([-0-9.eE]+)\s+([-0-9.eE]+)\s+([-0-9.eE]+)\s*$/gm,
    )) {
      vertexPositions.appendArray([
        parseFloat(match[1]),
        parseFloat(match[2]),
        parseFloat(match[3]),
      ]);
    }

    // Find indices
    for (const match of text.matchAll(
      /^f\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/gm,
    )) {
      indices.appendArray([
        parseInt(match[1], 10) - 1,
        parseInt(match[2], 10) - 1,
        parseInt(match[3], 10) - 1,
      ]);
    }

    vertexPositions.shrinkToFit();
    indices.shrinkToFit();

    const mesh: SingleMesh = {
      info: {
        numVertices: vertexPositions.length / 3,
        numTriangles: indices.length / 3,
        vertexAttributes: [],
      },
      vertexPositions: vertexPositions.view,
      indices: indices.view,
      vertexAttributes: [],
    };

    const size = mesh.vertexPositions.byteLength + mesh.indices.byteLength;
    console.log(mesh);

    return {
      value: { data: mesh, size },
      transfer: [mesh.indices.buffer, mesh.vertexPositions.buffer],
    };
  },
);
