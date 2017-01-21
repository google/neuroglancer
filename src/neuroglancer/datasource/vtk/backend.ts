/**
 * @license
 * Copyright 2016 Google Inc.
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

import {GenericFileSource} from 'neuroglancer/chunk_manager/generic_file_source';
import {parseVTK} from 'neuroglancer/datasource/vtk/parse';
import {registerSingleMeshFactory, SingleMesh} from 'neuroglancer/single_mesh/backend';
import {DataType} from 'neuroglancer/util/data_type';
import {maybeDecompressGzip} from 'neuroglancer/util/gzip';

/**
 * This needs to be a global function, because it identifies the instance of GenericFileSource to
 * use.
 */
function parseVTKFromArrayBuffer(buffer: ArrayBuffer) {
  return parseVTK(maybeDecompressGzip(buffer));
}

registerSingleMeshFactory('vtk', {
  description: 'VTK',
  getMesh: (chunkManager, url, getPriority, cancellationToken) =>
               GenericFileSource
                   .getData(
                       chunkManager.addRef(), parseVTKFromArrayBuffer, url, getPriority,
                       cancellationToken)
                   .then(mesh => {
                     let result: SingleMesh = {
                       info: {
                         numTriangles: mesh.numTriangles,
                         numVertices: mesh.numVertices,
                         vertexAttributes: [],
                       },
                       indices: mesh.indices,
                       vertexPositions: mesh.vertexPositions,
                       vertexAttributes: [],
                     };
                     for (const attribute of mesh.vertexAttributes) {
                       result.info.vertexAttributes.push({
                         name: attribute.name,
                         dataType: DataType.FLOAT32,
                         numComponents: attribute.numComponents,
                       });
                       result.vertexAttributes.push(attribute.data);
                     }
                     return result;
                   })
});
