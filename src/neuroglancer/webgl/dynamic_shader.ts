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

import {WatchableValue} from 'neuroglancer/trackable_value';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {verifyString} from 'neuroglancer/util/json';
import {ShaderCompilationError, ShaderLinkError} from 'neuroglancer/webgl/shader';

/**
 * undefined means shader has not been compiled.  null means shader was compiled successfully.
 */
export type WatchableShaderError =
    WatchableValue<ShaderCompilationError|ShaderLinkError|undefined|null>;

export function makeWatchableShaderError() {
  return new WatchableValue<ShaderCompilationError|ShaderLinkError|undefined|null>(undefined);
}

export type TrackableFragmentMain = TrackableValue<string>;

export function makeTrackableFragmentMain(value: string) {
  return new TrackableValue<string>(value, verifyString);
}
