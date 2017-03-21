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

export const LEGACY_URL_PREFIX = '/ocp/ca';
export const NDSTORE_URL_PREFIX = '/nd/sd';

export class VolumeChunkSourceParameters {
  baseUrls: string[];
  urlPrefix: string;
  key: string;
  channel: string;
  resolution: string;
  encoding: string;
  neariso: boolean;

  static RPC_ID = 'ndstore/VolumeChunkSource';

  static stringify(parameters: VolumeChunkSourceParameters) {
    return `ndstore:volume:${parameters.baseUrls[0]}/${parameters.key}/${parameters.channel}/${parameters.resolution}/${parameters.encoding}`;
  }
};

