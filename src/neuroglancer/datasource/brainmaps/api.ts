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

import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {fetchWithCredentials} from 'neuroglancer/credentials_provider/http_request';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {responseArrayBuffer, responseJson} from 'neuroglancer/util/http_request';

export type BrainmapsCredentialsProvider = CredentialsProvider<Credentials>;

/**
 * OAuth2 token
 */
export interface Credentials {
  tokenType: string;
  accessToken: string;
}

/**
 * Key used for retrieving the CredentialsProvider from a CredentialsManager.
 */
export const credentialsKey = 'google-brainmaps';

export interface BrainmapsInstance {
  description: string;
  /**
   * One or more server URLs to use to connect to the instance.
   */
  serverUrl: string;
}

/**
 * API-related interfaces.
 */

export interface ChangeSpecPayload {
  change_stack_id?: string;
  time_stamp?: number;
  skip_equivalences?: boolean;
}

export interface ChangeStackAwarePayload {
  change_spec?: ChangeSpecPayload;
}

export interface GeometryPayload {
  corner: string;
  size: string;
  scale: number;
}

export interface GeometryAwarePayload {
  geometry: GeometryPayload;
}

export interface ImageFormatOptionsPayload {
  image_format?: 'AUTO'|'JPEG'|'PNG'|'JSON';
  jpeg_quality?: number;
  compressed_segmentation_block_size?: string;
}

export interface SubvolumePayload extends ChangeStackAwarePayload, GeometryAwarePayload {
  image_format_options?: ImageFormatOptionsPayload;
  subvolume_format?: 'RAW'|'SINGLE_IMAGE';
}

export interface SkeletonPayload extends ChangeStackAwarePayload {
  object_id: string;
}

export interface MeshFragmentPayload extends ChangeStackAwarePayload {
  fragment_key: string;
  object_id: string;
}

export interface BatchMeshFragment {
  object_id: string;
  fragment_keys: string[];
}

export interface BatchMeshFragmentPayload {
  volume_id: string;
  mesh_name: string;
  batches: BatchMeshFragment[];
}

export interface HttpCall {
  method: 'GET'|'POST';
  path: string;
  payload?: string;
}

export function makeRequest(
    instance: BrainmapsInstance, credentialsProvider: BrainmapsCredentialsProvider,
    httpCall: HttpCall&{responseType: 'arraybuffer'},
    cancellationToken?: CancellationToken): Promise<ArrayBuffer>;
export function makeRequest(
    instance: BrainmapsInstance, credentialsProvider: BrainmapsCredentialsProvider,
    httpCall: HttpCall&{responseType: 'json'}, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequest(
    instance: BrainmapsInstance, credentialsProvider: BrainmapsCredentialsProvider,
    httpCall: HttpCall&{responseType: XMLHttpRequestResponseType},
    cancellationToken: CancellationToken = uncancelableToken): any {
  return fetchWithCredentials(
      credentialsProvider, `${instance.serverUrl}${httpCall.path}`,
      {method: httpCall.method, body: httpCall.payload},
      httpCall.responseType === 'json' ? responseJson : responseArrayBuffer,
      (credentials, init) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `${credentials.tokenType} ${credentials.accessToken}`);
        return {...init, headers};
      },
      error => {
        const {status} = error;
        if (status === 401) {
          // 401: Authorization needed.  OAuth2 token may have expired.
          return 'refresh';
        } else if (status === 504 || status === 503) {
          // 503: Service unavailable.  Retry.
          // 504: Gateway timeout.  Can occur if the server takes too long to reply.  Retry.
          return 'retry';
        }
        throw error;
      },
      cancellationToken);
}
