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

import type { BrainmapsInstance } from "#src/datasource/brainmaps/api.js";
import {
  BrainmapsDataSource,
  productionInstance,
} from "#src/datasource/brainmaps/frontend.js";
import { registerProvider } from "#src/datasource/default_provider.js";

registerProvider(new BrainmapsDataSource(productionInstance, "brainmaps"));

declare const NEUROGLANCER_BRAINMAPS_SERVERS:
  | { [key: string]: BrainmapsInstance }
  | undefined;

if (typeof NEUROGLANCER_BRAINMAPS_SERVERS !== "undefined") {
  for (const [key, instance] of Object.entries(
    NEUROGLANCER_BRAINMAPS_SERVERS,
  )) {
    registerProvider(new BrainmapsDataSource(instance, `brainmaps-${key}`));
  }
}
