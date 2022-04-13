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

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {assignMeshFragmentData, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {getGrapheneFragmentKey, responseIdentity} from 'neuroglancer/datasource/graphene/base';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk, isNotFoundError, responseArrayBuffer, responseJson} from 'neuroglancer/util/http_request';
import {cancellableFetchSpecialOk, SpecialProtocolCredentials} from 'neuroglancer/util/special_protocol_request';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject} from 'neuroglancer/worker_rpc';
import {ChunkedGraphSourceParameters, MeshSourceParameters} from 'neuroglancer/datasource/graphene/base';
import {ChunkedGraphChunk, ChunkedGraphChunkSource, decodeSupervoxelArray} from 'neuroglancer/sliceview/chunked_graph/backend';
import {decodeManifestChunk} from 'neuroglancer/datasource/precomputed/backend';
import {fetchSpecialHttpByteRange} from 'neuroglancer/util/byte_range_http_requests';

export function decodeChunkedGraphChunk(leaves: string[]) {
  return decodeSupervoxelArray(leaves);
}

@registerSharedObject() export class GrapheneChunkedGraphChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(ChunkedGraphChunkSource), ChunkedGraphSourceParameters)) {
  async download(chunk: ChunkedGraphChunk, cancellationToken: CancellationToken): Promise<void> {
    let {parameters} = this;
    let chunkPosition = this.computeChunkBounds(chunk);
    let chunkDataSize = chunk.chunkDataSize!;
    let bounds = `${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
        `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
        `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;

    const request = cancellableFetchSpecialOk(this.credentialsProvider,
        `${parameters.url}/${chunk.segment}/leaves?int64_as_str=1&bounds=${bounds}`, {}, responseIdentity,
        cancellationToken);
    await this.withErrorMessage(
        request, `Fetching leaves of segment ${chunk.segment} in region ${bounds}: `)
      .then(res => res.json())
      .then(res => {
        chunk.leaves = decodeChunkedGraphChunk(res['leaf_ids'])
      })
      .catch(err => console.error(err));
  }

  async withErrorMessage(promise: Promise<Response>, errorPrefix: string): Promise<Response> {
    const response = await promise;
    if (response.ok) {
      return response;
    } else {
      let msg: string;
      try {
        msg = (await response.json())['message'];
      } catch {
        msg = await response.text();
      }
      throw new Error(`[${response.status}] ${errorPrefix}${msg}`);
    }
  }
}

function getVerifiedFragmentPromise(
  chunk: FragmentChunk,
  parameters: MeshSourceParameters,
  cancellationToken: CancellationToken) {
  if (chunk.fragmentId && chunk.fragmentId.charAt(0) === '~') {
    let parts = chunk.fragmentId.substr(1).split(':');
    let startOffset: Uint64|number, endOffset: Uint64|number;
    startOffset = Number(parts[1]);
    endOffset = startOffset+Number(parts[2]);
    return fetchSpecialHttpByteRange(undefined,
      `${parameters.fragmentUrl}/initial/${parts[0]}`,
      startOffset,
      endOffset,
      cancellationToken
    );
  }
  return cancellableFetchOk(
    `${parameters.fragmentUrl}/dynamic/${chunk.fragmentId}`, {}, responseArrayBuffer,
    cancellationToken);
}

function getFragmentDownloadPromise(
  chunk: FragmentChunk,
  parameters: MeshSourceParameters,
  cancellationToken: CancellationToken
) {
  let fragmentDownloadPromise;
  if (parameters.sharding){
    fragmentDownloadPromise = getVerifiedFragmentPromise(chunk, parameters, cancellationToken);
  } else {
    fragmentDownloadPromise = cancellableFetchOk(
      `${parameters.fragmentUrl}/${chunk.fragmentId}`, {}, responseArrayBuffer,
      cancellationToken);
  }
  return fragmentDownloadPromise;
}

async function decodeDracoFragmentChunk(
    chunk: FragmentChunk, response: ArrayBuffer) {
  const m = await import(/* webpackChunkName: "draco" */ 'neuroglancer/mesh/draco');
  const rawMesh = await m.decodeDraco(new Uint8Array(response));
  assignMeshFragmentData(chunk, rawMesh);
}

@registerSharedObject() export class GrapheneMeshSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(MeshSource), MeshSourceParameters)) {
  async download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    cancellationToken.add(() => {
      console.log('GrapheneMeshSource cancelled');
    });
    const {parameters} = this;
    let url = `${parameters.manifestUrl}/manifest`;
    let manifestUrl = `${url}/${chunk.objectId}:${parameters.lod}?verify=1&prepend_seg_ids=1`;

    await cancellableFetchSpecialOk(this.credentialsProvider, manifestUrl, {}, responseJson, cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  async downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;

    try {
      const response = await getFragmentDownloadPromise(
        chunk, parameters, cancellationToken);
      await decodeDracoFragmentChunk(chunk, response);
    } catch (e) {
      if (isNotFoundError(e)) {
        chunk.source!.removeChunk(chunk);
      }
      Promise.reject(e);
    }
  }

  getFragmentKey(objectKey: string|null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
  }
}
