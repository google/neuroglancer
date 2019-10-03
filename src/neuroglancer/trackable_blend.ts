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

import {TrackableValue} from 'neuroglancer/trackable_value';
import {verifyEnumString, verifyString} from 'neuroglancer/util/json';

export enum BLEND_MODES {
  DEFAULT = 0,
  ADDITIVE = 1
}

export const BLEND_FUNCTIONS = new Map<BLEND_MODES, Function>();
BLEND_FUNCTIONS.set(BLEND_MODES.DEFAULT, (gl: WebGL2RenderingContext) => {
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
});
BLEND_FUNCTIONS.set(BLEND_MODES.ADDITIVE, (gl: WebGL2RenderingContext) => {
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
});

export type TrackableBlendModeValue = TrackableValue<string>;

function blendModeValidator(obj: any): string {
  if (verifyEnumString(obj, BLEND_MODES)) {
    return verifyString(obj);
  } else {
    throw new Error();
  }
}

export function trackableBlendModeValue(initialValue = 'default') {
  return new TrackableValue<string>(initialValue, blendModeValidator);
}
