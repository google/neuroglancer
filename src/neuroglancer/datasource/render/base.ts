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

export class RenderBaseSourceParameters {
  baseUrl: string;
  owner: string;
  project: string;
  stack: string;
  channel: string|undefined;
}

export class RenderSourceParameters extends RenderBaseSourceParameters {
  minIntensity: number|undefined;
  maxIntensity: number|undefined;
  maxTileSpecsToRender: number|undefined;
  filter: boolean|undefined;
}

export class TileChunkSourceParameters extends RenderSourceParameters {
  dims: string;
  level: number;
  encoding: string;

  static RPC_ID = 'render/TileChunkSource';
}
