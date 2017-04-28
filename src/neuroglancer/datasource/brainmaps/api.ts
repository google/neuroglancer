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

import {getToken, Token} from 'neuroglancer/datasource/brainmaps/api_implementation';
import {HttpError, openShardedHttpRequest} from 'neuroglancer/util/http_request';
import {CancellationToken, uncancelableToken, CANCELED} from 'neuroglancer/util/cancellation';

export var numPendingRequests = 0;

export type BrainmapsInstance = number;
export const PRODUCTION_INSTANCE = 0;

export const INSTANCE_NAMES: string[] = [];

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

/**
 * Maps a BrainmapsInstance to the list of base URL shards to use for accessing it.
 */
export const INSTANCE_BASE_URLS: string[][] = [];
const instanceHostname: string[] = [];

export const INSTANCE_IDENTIFIERS: string[] = [];

export function brainmapsInstanceKey(instance: BrainmapsInstance) {
  return INSTANCE_IDENTIFIERS[instance];
}

export function setupBrainmapsInstance(
    instance: BrainmapsInstance, hostname: string, identifier: string, name: string) {
  INSTANCE_IDENTIFIERS[instance] = identifier;
  INSTANCE_NAMES[instance] = name;
  instanceHostname[instance] = hostname;
  let baseUrls = [`https://${hostname}`];
  INSTANCE_BASE_URLS[instance] = baseUrls;
}

setupBrainmapsInstance(PRODUCTION_INSTANCE, 'brainmaps.googleapis.com', 'prod', 'Brain Maps');

export interface HttpCall {
  method: 'GET'|'POST';
  path: string;
  responseType: XMLHttpRequestResponseType;
  payload?: string;
}


export function makeRequest(
    instance: BrainmapsInstance, httpCall: HttpCall,
    cancellationToken?: CancellationToken): Promise<ArrayBuffer>;
export function makeRequest(
    instance: BrainmapsInstance, httpCall: HttpCall,
    cancellationToken?: CancellationToken): Promise<any>;
export function makeRequest(
    instance: BrainmapsInstance, httpCall: HttpCall,
    cancellationToken?: CancellationToken): any;

export function makeRequest(
    instance: BrainmapsInstance, httpCall: HttpCall,
    cancellationToken: CancellationToken = uncancelableToken): any {
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
    function start(token: Token) {
      if (xhr === null) {
        --numPendingRequests;
        return;
      }
      xhr = openShardedHttpRequest(INSTANCE_BASE_URLS[instance], httpCall.path, httpCall.method);
      xhr.responseType = httpCall.responseType;
      xhr.setRequestHeader('Authorization', `${token['tokenType']} ${token['accessToken']}`);
      xhr.onloadend = function(this: XMLHttpRequest) {
        if (xhr === null) {
          --numPendingRequests;
          return;
        }
        let status = this.status;
        if (status >= 200 && status < 300) {
          --numPendingRequests;
          cancellationToken.remove(abort);
          resolve(this.response);
        } else if (status === 401) {
          // Authorization needed.
          getToken(token).then(start);
        } else if (status === 504) {
          // Gateway timeout can occur if the server takes too long to reply.  Retry.
          getToken().then(start);
        } else {
          --numPendingRequests;
          cancellationToken.remove(abort);
          reject(HttpError.fromXhr(this));
        }
      };
      xhr.send(httpCall.payload);
    }
    getToken().then(start);
  });
}
