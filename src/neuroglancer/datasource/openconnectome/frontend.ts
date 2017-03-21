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

/**
 * Convenience interface for accessing openconnecto.me server.
 */

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {getShardedVolume, tokenAndChannelCompleter} from 'neuroglancer/datasource/ndstore/frontend';
import {LEGACY_URL_PREFIX} from 'neuroglancer/datasource/ndstore/base';

const HOSTNAMES = ['http://openconnecto.me', 'http://www.openconnecto.me'];

export function getVolume(chunkManager: ChunkManager, path: string) {
  return getShardedVolume(chunkManager, HOSTNAMES, path, LEGACY_URL_PREFIX);
}

export function volumeCompleter(url: string, chunkManager: ChunkManager) {
  return tokenAndChannelCompleter(chunkManager, HOSTNAMES, url, LEGACY_URL_PREFIX);
}

registerDataSourceFactory('openconnectome', {
  description: 'NDstore server hosted at openconnecto.me',
  getVolume,
  volumeCompleter,
});
