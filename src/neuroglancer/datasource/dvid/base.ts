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
import {VolumeType} from 'neuroglancer/sliceview/volume/base';

export enum VolumeChunkEncoding {
  JPEG,
  COMPRESSED_SEGMENTATION
}

export class DVIDSourceParameters {
  baseUrls: string[];
  nodeKey: string;
  dataInstanceKey: string;
}

export class VolumeChunkSourceParameters extends DVIDSourceParameters {
  encoding: VolumeChunkEncoding;
  static RPC_ID = 'dvid/VolumeChunkSource';
  static stringify(parameters: VolumeChunkSourceParameters) {
    return `dvid:volume:${parameters['baseUrls'][0]}/${parameters['nodeKey']}/${parameters['dataInstanceKey']}`;
  }
};

export enum TileEncoding {
  JPEG
}

export class TileChunkSourceParameters extends DVIDSourceParameters {
  dims: string;
  level: string;
  encoding: TileEncoding;

  static RPC_ID = 'dvid/TileChunkSource';

  static stringify(parameters: TileChunkSourceParameters) {
    return `dvid:volume:${parameters['baseUrls'][0]}/${parameters['nodeKey']}/${parameters['dataInstanceKey']}/${parameters['dims']}/${parameters['level']}/${TileEncoding[parameters['encoding']]}`;
  }
}
