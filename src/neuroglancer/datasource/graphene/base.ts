/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import {mat4} from 'neuroglancer/util/geom';
import {ShardingParameters} from 'neuroglancer/datasource/precomputed/base';

export const PYCG_APP_VERSION = 1;

export enum VolumeChunkEncoding {
  RAW,
  JPEG,
  COMPRESSED_SEGMENTATION
}

export class VolumeChunkSourceParameters {
  url: string;
  encoding: VolumeChunkEncoding;
  sharding: ShardingParameters|undefined;

  static RPC_ID = 'graphene/VolumeChunkSource';
}


export class ChunkedGraphSourceParameters {
  url: string;

  static RPC_ID = 'graphene/ChunkedGraphSource';
}

export class MeshSourceParameters {
  manifestUrl: string;
  fragmentUrl: string;
  lod: number;
  sharding: Array<ShardingParameters>|undefined;

  static RPC_ID = 'graphene/MeshSource';
}

export class MultiscaleMeshMetadata {
  transform: mat4;
  lodScaleMultiplier: number;
  vertexQuantizationBits: number;
  sharding: Array<ShardingParameters>|undefined;
}

/*
temporary solution to deal with cors error if the middle auth credential is passed to fetch request to GCS.
because the authorization header is not in Access-Control-Allow-Headers
*/

import {cancellableFetchSpecialOk as cancellableFetchSpecialOkOrig, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';
import { CancellationToken, uncancelableToken } from 'neuroglancer/util/cancellation';
import { ResponseTransform } from 'neuroglancer/util/http_request';

const GCS_ORIGIN = 'https://storage.googleapis.com';

export async function cancellableFetchSpecialOk<T>(
  credentialsProvider: SpecialProtocolCredentialsProvider, url: string, init: RequestInit,
  transformResponse: ResponseTransform<T>,
  cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
    if ((new URL(url)).origin === GCS_ORIGIN) {
      credentialsProvider = undefined;
    }

    return cancellableFetchSpecialOkOrig(credentialsProvider, url, init, transformResponse, cancellationToken);
}

import {fetchSpecialHttpByteRange as fetchSpecialHttpByteRangeOrig} from 'neuroglancer/util/byte_range_http_requests';
import { Uint64 } from 'neuroglancer/util/uint64';

export function fetchSpecialHttpByteRange(
  credentialsProvider: SpecialProtocolCredentialsProvider, url: string,
  startOffset: Uint64|number, endOffset: Uint64|number,
  cancellationToken: CancellationToken): Promise<ArrayBuffer> {
    if ((new URL(url)).origin === GCS_ORIGIN) {
      credentialsProvider = undefined;
    }

    return fetchSpecialHttpByteRangeOrig(credentialsProvider, url, startOffset, endOffset, cancellationToken);
}

export const responseIdentity = async (x: any) => x;

export function isBaseSegmentId(segmentId: Uint64, nBitsForLayerId: number) {
  const layerId = Uint64.rshift(new Uint64(), segmentId, 64 - nBitsForLayerId);
  return Uint64.equal(layerId, Uint64.ONE);
}

export function getGrapheneFragmentKey(fragmentId: string) {
  const sharded = fragmentId.charAt(0) === '~';

  if (sharded) {
    const parts = fragmentId.substring(1).split(/:(.+)/);
    return {key:parts[0], fragmentId: parts[1]};
  } else {
    return {key:fragmentId, fragmentId: fragmentId};
  }
}
