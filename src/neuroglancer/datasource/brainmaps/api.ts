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

import {CredentialsProvider, CredentialsWithGeneration} from 'neuroglancer/credentials_provider';
import {CANCELED, CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {HttpError, openShardedHttpRequest} from 'neuroglancer/util/http_request';

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
  serverUrls: string[];
}

/**
 * API-related interfaces.
 */

export interface ChangeSpecPayload {
  change_stack_id?: string;
  time_stamp?: number;
  skip_equivalences?: boolean;
}

export interface ChangeStackAwarePayload { change_spec?: ChangeSpecPayload; }

export interface GeometryPayload {
  corner: string;
  size: string;
  scale: number;
}

export interface GeometryAwarePayload { geometry: GeometryPayload; }

export interface ImageFormatOptionsPayload {
  image_format?: 'AUTO'|'JPEG'|'PNG'|'JSON';
  jpeg_quality?: number;
  compressed_segmentation_block_size?: string;
}

export interface SubvolumePayload extends ChangeStackAwarePayload, GeometryAwarePayload {
  image_format_options?: ImageFormatOptionsPayload;
  subvolume_format?: 'RAW'|'SINGLE_IMAGE';
}

export interface SkeletonPayload extends ChangeStackAwarePayload { object_id: string; }

export interface MeshFragmentPayload extends ChangeStackAwarePayload {
  fragment_key: string;
  object_id: string;
}

export interface HttpCall {
  method: 'GET'|'POST';
  path: string;
  responseType: XMLHttpRequestResponseType;
  payload?: string;
}

export function makeRequest(
    instance: BrainmapsInstance, credentialsProvider: BrainmapsCredentialsProvider,
    httpCall: HttpCall, cancellationToken?: CancellationToken): Promise<ArrayBuffer>;
export function makeRequest(
    instance: BrainmapsInstance, credentialsProvider: BrainmapsCredentialsProvider,
    httpCall: HttpCall, cancellationToken?: CancellationToken): Promise<any>;
// export function makeRequest(
//     instance: BrainmapsInstance, credentialsProvider: BrainmapsCredentialsProvider,
//     httpCall: HttpCall, cancellationToken?: CancellationToken): any;

export function makeRequest(
    instance: BrainmapsInstance, credentialsProvider: BrainmapsCredentialsProvider,
    httpCall: HttpCall, cancellationToken: CancellationToken = uncancelableToken): any {
  /**
   * undefined means request not yet attempted.  null means request
   * cancelled.
   */
  let xhr: XMLHttpRequest|undefined|null = undefined;
  return new Promise<any>((resolve, reject) => {
    const abort = () => {
      let origXhr = xhr;
      xhr = null;
      if (origXhr != null) {
        origXhr.abort();
      }
      reject(CANCELED);
    };
    cancellationToken.add(abort);
    function start(credentials: CredentialsWithGeneration<Credentials>) {
      if (xhr === null) {
        return;
      }
      xhr = openShardedHttpRequest(instance.serverUrls, httpCall.path, httpCall.method);
      xhr.responseType = httpCall.responseType;
      xhr.setRequestHeader(
          'Authorization',
          `${credentials.credentials.tokenType} ${credentials.credentials.accessToken}`);
      xhr.onloadend = function(this: XMLHttpRequest) {
        if (xhr === null) {
          return;
        }
        let status = this.status;
        if (status >= 200 && status < 300) {
          cancellationToken.remove(abort);
          resolve(this.response);
        } else if (status === 401) {
          // 401: Authorization needed.  OAuth2 token may have expired.
          credentialsProvider.get(credentials, cancellationToken).then(start);
        } else if (status === 504) {
          // 504: Gateway timeout.  Can occur if the server takes too long to reply.  Retry.
          credentialsProvider.get(/*invalidToken=*/undefined, cancellationToken).then(start);
        } else {
          cancellationToken.remove(abort);
          reject(HttpError.fromXhr(this));
        }
      };
      xhr.send(httpCall.payload);
    }
    credentialsProvider.get(/*invalidToken=*/undefined, cancellationToken).then(start);
  });
}
