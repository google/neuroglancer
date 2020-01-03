/**
 * @license
 * Copyright 2017 Google Inc.
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

import {vec2} from 'neuroglancer/util/geom';

export class BossSourceParameters {
  baseUrl: string;
  collection: string;
  experiment: string;
  channel: string;
  resolution: string;
}

export class VolumeChunkSourceParameters extends BossSourceParameters {
  encoding: string;
  window: vec2|undefined;

  static RPC_ID = 'boss/VolumeChunkSource';

  static stringify(parameters: VolumeChunkSourceParameters) {
    return `boss:volume:${parameters.baseUrl}/${parameters.collection}/${
        parameters.experiment}/${parameters.channel}/${parameters.resolution}/${
        parameters.encoding}`;
  }
}

export class MeshSourceParameters {
  baseUrl: string;

  static RPC_ID = 'boss/MeshChunkSource';

  static stringify(parameters: MeshSourceParameters) {
    return `boss:mesh:${parameters.baseUrl}`;
  }
}
