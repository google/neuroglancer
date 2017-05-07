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
 * @file Convenience interface for creating TrackableValue instances designed to represent alpha
 * (opacity) values.
 */

import {TrackableValue} from 'neuroglancer/trackable_value';
import {verifyFiniteFloat} from 'neuroglancer/util/json';

export type TrackableFiniteFloat = TrackableValue<number>;

export function trackableFiniteFloat(initialValue = 1.0) {
  return new TrackableValue<number>(initialValue, verifyFiniteFloat);
}
