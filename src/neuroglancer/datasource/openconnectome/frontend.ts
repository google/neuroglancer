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

import {LEGACY_URL_PREFIX} from 'neuroglancer/datasource/ndstore/base';
import {SingleServerDataSource} from 'neuroglancer/datasource/ndstore/frontend';

const HOSTNAMES = ['http://openconnecto.me', 'http://www.openconnecto.me'];

export class OpenConnectomeDataSource extends SingleServerDataSource {
  constructor() {
    super('NDstore server hosted at openconnecto.me', HOSTNAMES, LEGACY_URL_PREFIX);
  }
}
