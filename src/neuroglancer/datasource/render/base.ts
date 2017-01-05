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

export class RenderSourceParameters {
  baseUrls: string[];
  owner: string;
  project: string;
  stack: string;
  encoding: string;
}

export class TileChunkSourceParameters extends RenderSourceParameters {
  dims: string;
  level: number;
  encoding: string;

  static RPC_ID = 'render/TileChunkSource';

  static stringify(parameters: TileChunkSourceParameters) {
    return `render:tile:${parameters.baseUrls[0]}/${parameters.owner
        }/${parameters.project}/${parameters.stack}/${parameters.level}/${parameters.encoding}`;
  }
}
