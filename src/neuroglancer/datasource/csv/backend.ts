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

import {parseCSVFromArrayBuffer} from 'neuroglancer/async_computation/csv_vertex_attributes_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';
import {GenericSharedDataSource} from 'neuroglancer/chunk_manager/generic_file_source';
import {registerSingleMeshVertexAttributesFactory} from 'neuroglancer/single_mesh/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';

/**
 * This needs to be a global function, because it identifies the instance of GenericSharedDataSource
 * to use.
 */
function parse(buffer: ArrayBuffer, cancellationToken: CancellationToken) {
  return requestAsyncComputation(parseCSVFromArrayBuffer, cancellationToken, [buffer], buffer);
}

registerSingleMeshVertexAttributesFactory('csv', {
  description: 'Comma separated value text file',
  getMeshVertexAttributes: (chunkManager, url, getPriority, cancellationToken) =>
      GenericSharedDataSource.getUrl(chunkManager, parse, url, getPriority, cancellationToken)
});
