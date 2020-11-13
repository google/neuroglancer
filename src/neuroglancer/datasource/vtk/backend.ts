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

import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {parseVTKFromArrayBuffer} from 'neuroglancer/async_computation/vtk_mesh_request';
import {GenericSharedDataSource} from 'neuroglancer/chunk_manager/generic_file_source';
import {registerSingleMeshFactory, SingleMesh} from 'neuroglancer/single_mesh/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {DataType} from 'neuroglancer/util/data_type';

/**
 * This needs to be a global function, because it identifies the instance of GenericSharedDataSource
 * to use.
 */
function parse(buffer: ArrayBuffer, cancellationToken: CancellationToken) {
  return requestAsyncComputation(parseVTKFromArrayBuffer, cancellationToken, [buffer], buffer);
}

registerSingleMeshFactory('vtk', {
  description: 'VTK',
  getMesh: (chunkManager, credentialsProvider, url, getPriority, cancellationToken) =>
      GenericSharedDataSource
          .getUrl(chunkManager, credentialsProvider, parse, url, getPriority, cancellationToken)
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
