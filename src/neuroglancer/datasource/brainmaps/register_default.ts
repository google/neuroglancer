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

import {BrainmapsInstance, credentialsKey} from 'neuroglancer/datasource/brainmaps/api';
import {BrainmapsDataSource, productionInstance} from 'neuroglancer/datasource/brainmaps/frontend';
import {registerProvider} from 'neuroglancer/datasource/default_provider';

registerProvider(
    'brainmaps',
    options => new BrainmapsDataSource(
        productionInstance, options.credentialsManager.getCredentialsProvider(credentialsKey)));

declare var NEUROGLANCER_BRAINMAPS_SERVERS: {[key: string]: BrainmapsInstance}|undefined;

if (typeof NEUROGLANCER_BRAINMAPS_SERVERS !== 'undefined') {
  for (const [key, instance] of Object.entries(NEUROGLANCER_BRAINMAPS_SERVERS)) {
    registerProvider(
        `brainmaps-${key}`,
        options => new BrainmapsDataSource(
            instance, options.credentialsManager.getCredentialsProvider(credentialsKey)));
  }
}
