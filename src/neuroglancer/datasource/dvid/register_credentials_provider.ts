/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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
import {credentialsKey} from 'neuroglancer/datasource/dvid/api';
import {DVIDCredentialsProvider} from 'neuroglancer/datasource/dvid/credentials_provider';

export function dvidCredentailsKey(authServer: string) {
  return credentialsKey + authServer;
}

export function registerDVIDCredentialsProvider(key: string) {
  defaultCredentialsManager.register(
    key, (authServer) => new DVIDCredentialsProvider(authServer));
}

export function isDVIDCredentialsProviderRegistered(key: string) {
  return defaultCredentialsManager.base.providers.has(key);
}

registerDVIDCredentialsProvider(dvidCredentailsKey(''));
