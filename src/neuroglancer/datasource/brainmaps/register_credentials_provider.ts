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

import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {credentialsKey} from 'neuroglancer/datasource/brainmaps/api';
import {BrainmapsCredentialsProvider} from 'neuroglancer/datasource/brainmaps/credentials_provider';

declare var BRAINMAPS_CLIENT_ID: string;

defaultCredentialsManager.register(credentialsKey, () => new BrainmapsCredentialsProvider(BRAINMAPS_CLIENT_ID));
